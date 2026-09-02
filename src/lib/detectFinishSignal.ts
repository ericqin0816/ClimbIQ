import type {
  Confidence,
  DetectionCandidate,
  NormalizedZone,
  RGB,
  StartLightCalibration,
  StartSignalDebug,
  StartSignalDetectionResult,
} from "../types";
import {
  computeColorDistance,
  roundTime,
  sampleFramesInRange,
  sampleZoneOpponentColors,
} from "./videoFrameSampler";
import { resolveFinishSearchWindow } from "./finishSearchWindow";

export interface FinishColorSample {
  time: number;
  averageRgb: RGB;
  /** Pixels ranked toward the calibrated return color, when video sampling provides them. */
  directionalRgb?: RGB;
}

interface DetectFinishSignalOptions {
  video: HTMLVideoElement;
  zone?: NormalizedZone;
  startSignalRawTime?: number;
  calibration: StartLightCalibration;
  expectedFinishTime?: number;
  minimumClimbSeconds?: number;
  maximumClimbSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (phase: "coarse" | "refine", processed: number, total: number) => void;
}

interface RequiredCalibration {
  beforeStartRGB: RGB;
  afterStartRGB: RGB;
  colorDelta: number;
}

interface FinishAnalysis {
  detected: boolean;
  rawTime?: number;
  confidence: Confidence;
  reason: string;
  threshold: number;
  samples: FinishColorSample[];
  candidates: DetectionCandidate[];
  baselineRgb?: RGB;
}

const COARSE_FPS = 5;
const REFINE_FPS = 30;

/**
 * Finds the finish by watching the selected lane's sensor switch from its
 * during-climb state to the opposite learned state. The direction is inferred
 * from the sampled baseline, so neither blue-to-green nor green-to-blue is hard-coded.
 */
export async function detectFinishSignal({
  video,
  zone,
  startSignalRawTime,
  calibration,
  expectedFinishTime,
  minimumClimbSeconds = 3,
  maximumClimbSeconds = 30,
  signal,
  onProgress,
}: DetectFinishSignalOptions): Promise<StartSignalDetectionResult> {
  if (!zone) {
    return emptyResult("Finish was not detected because the selected lane-light region is unavailable.");
  }
  if (startSignalRawTime === undefined) {
    return emptyResult("Finish was not detected because Start Signal is not set.", zone);
  }
  if (!hasCalibration(calibration)) {
    return emptyResult("Finish was not detected because the lane light has no learned before/after colors.", zone);
  }

  const { start: searchStart, end: searchEnd } = resolveFinishSearchWindow(
    startSignalRawTime,
    video.duration,
    minimumClimbSeconds,
    maximumClimbSeconds,
  );
  if (searchEnd - searchStart < 0.5) {
    return emptyResult("Finish search window is too short.", zone);
  }

  const coarseSamples = await sampleFinishColors(video, zone, searchStart, searchEnd, COARSE_FPS, calibration, signal, (done, total) => {
    onProgress?.("coarse", done, total);
  });
  const coarse = analyzeFinishColorSamples(coarseSamples, calibration, expectedFinishTime);
  if (!coarse.detected || coarse.rawTime === undefined) {
    return toResult(coarse, zone, calibration);
  }

  // The timing unit flashes green before it settles. The coarse 5 fps pass may
  // land on a later flash, so retain enough history for 30 fps refinement to
  // recover the first flash rather than timestamping the solid-green state.
  const refineStart = Math.max(searchStart, coarse.rawTime - 1.15);
  const refineEnd = Math.min(searchEnd, coarse.rawTime + 0.85);
  const refinedSamples = await sampleFinishColors(video, zone, refineStart, refineEnd, REFINE_FPS, calibration, signal, (done, total) => {
    onProgress?.("refine", done, total);
  });
  const refined = analyzeFinishColorSamples(refinedSamples, calibration, expectedFinishTime);
  return toResult(refined.detected ? refined : coarse, zone, calibration);
}

export function analyzeFinishColorSamples(
  samples: FinishColorSample[],
  calibration: StartLightCalibration,
  expectedFinishTime?: number,
): FinishAnalysis {
  if (samples.length < 6 || !hasCalibration(calibration)) {
    return {
      detected: false,
      confidence: "None",
      reason: "Not enough calibrated lane-light samples were available for finish detection.",
      threshold: 0,
      samples,
      candidates: [],
    };
  }

  const preStartOpponent = opponent(calibration.beforeStartRGB);
  const afterStartOpponent = opponent(calibration.afterStartRGB);
  const calibrationSpan = Math.abs(preStartOpponent - afterStartOpponent);
  if (calibrationSpan < 1) {
    return {
      detected: false,
      confidence: "None",
      reason: "The learned lane-light colors are too similar to identify its finish reversal.",
      threshold: 0,
      samples,
      candidates: [],
    };
  }

  const baselineCount = Math.min(12, Math.max(3, Math.floor(samples.length * 0.2)));
  const baselineValues = samples.slice(0, baselineCount).map((sample) => opponent(sample.averageRgb));
  const baselineRgb = averageRgb(samples.slice(0, baselineCount).map((sample) => sample.averageRgb));
  const baselineOpponent = median(baselineValues);
  const baselineMad = median(baselineValues.map((value) => Math.abs(value - baselineOpponent)));
  // Some timing systems stay blue throughout the climb and return green at
  // finish; others reset green during the climb and turn blue on contact. Learn
  // which calibrated state the lane currently occupies, then watch for the
  // opposite state instead of hard-coding either polarity.
  const baselineIsAfterState = Math.abs(baselineOpponent - afterStartOpponent) <=
    Math.abs(baselineOpponent - preStartOpponent);
  const targetOpponent = baselineIsAfterState ? preStartOpponent : afterStartOpponent;
  const sourceOpponent = baselineIsAfterState ? afterStartOpponent : preStartOpponent;
  const direction = Math.sign(targetOpponent - sourceOpponent) || 1;
  const learnedSpan = Math.max(calibrationSpan, Math.abs(targetOpponent - baselineOpponent));
  const threshold = Math.max(1.2, learnedSpan * 0.12, baselineMad * 4 + 0.8);
  const confirmationThreshold = Math.max(threshold * 1.35, learnedSpan * 0.22);
  const signalColors = samples.map((sample) => sample.directionalRgb ?? sample.averageRgb);
  const signalBaselineOpponent = median(signalColors.slice(0, baselineCount).map(opponent));
  const signalBaselineMad = median(
    signalColors.slice(0, baselineCount).map((rgb) => Math.abs(opponent(rgb) - signalBaselineOpponent)),
  );
  const signalThreshold = Math.max(threshold, signalBaselineMad * 4 + 0.8);
  // Confirmation should stay conservative, but using that same threshold as
  // the timestamp can miss the first dim return-color pixels during a fade.
  // Once a real settled reversal has been verified below, this lower
  // hysteresis threshold lets us recover a short, connected precursor without
  // accepting an isolated flicker on its own.
  const onsetThreshold = Math.max(0.55, learnedSpan * 0.035, signalBaselineMad * 3 + 0.3);
  const projected = signalColors.map((rgb) => direction * (opponent(rgb) - signalBaselineOpponent));
  const frameInterval = median(
    samples.slice(1).map((sample, index) => Math.max(1 / 120, sample.time - samples[index].time)),
  );
  const baselineLuminance = median(signalColors.slice(0, baselineCount).map(luminance));
  const baselineChroma = median(signalColors.slice(0, baselineCount).map(chroma));
  const minimumPlausibleChroma = Math.max(
    2.5,
    Math.min(baselineChroma, chroma(calibration.beforeStartRGB), chroma(calibration.afterStartRGB)) * 0.15,
  );
  const targetAdvantageFloor = Math.max(0.5, calibrationSpan * 0.03);
  const plausibleLightLevel = signalColors.map((rgb) => {
    const lightLevel = luminance(rgb);
    const lightRatio = lightLevel / Math.max(1, baselineLuminance);
    return lightRatio >= 0.55 && lightRatio <= 2.4 && chroma(rgb) >= minimumPlausibleChroma;
  });
  const targetDirected = signalColors.map((rgb, index) => {
    const sampleOpponent = opponent(rgb);
    const targetAdvantage = Math.abs(sampleOpponent - sourceOpponent) -
      Math.abs(sampleOpponent - targetOpponent);
    return targetAdvantage >= targetAdvantageFloor && plausibleLightLevel[index];
  });
  const maxVerificationSeconds = 1.15;
  const confirmationWindowSeconds = 0.48;
  // At coarse 5 fps, one missed flash creates a 0.4 s separation. At refined
  // frame rates, keep the connection tighter so an old isolated flicker cannot
  // be attached to the real finish.
  const maxConnectedGapSeconds = frameInterval >= 0.15
    ? frameInterval * 2.25
    : frameInterval >= 0.075
      ? frameInterval * 2.25
      : Math.max(0.1, frameInterval * 3.25);
  // Baseline pixels naturally wobble more than the faint-onset threshold.
  // Use a bounded fraction of the strict transition threshold when proving a
  // stable source state, while onset backtracking below remains conservative.
  const sourceStabilityThreshold = Math.max(onsetThreshold, signalThreshold * 0.75);
  const candidates: DetectionCandidate[] = [];

  for (let index = 2; index < samples.length - 1; index += 1) {
    const previousStable = hasStableSourceBefore(samples, projected, index, sourceStabilityThreshold, 0.5);
    // The first transitional frame can still resemble the source color, but a
    // source-state noise spike must not anchor the finish unless the very next
    // sample continues toward the verified reversal.
    const immediateContinuation = projected[index + 1] >= onsetThreshold && plausibleLightLevel[index + 1];
    // A strict transition anchor must retain plausible colored-light evidence.
    // Neutral occlusion can move opponent color away from blue, but its missing
    // chroma must never become the timestamp just because real green appears later.
    if (!previousStable || projected[index] < signalThreshold || !plausibleLightLevel[index] ||
        (!targetDirected[index] && !immediateContinuation)) {
      continue;
    }
    const horizonEnd = findLastIndexAtOrBefore(samples, samples[index].time + maxVerificationSeconds);
    let confirmationEnd = -1;
    for (let end = index + 1; end <= horizonEnd; end += 1) {
      const windowStartTime = samples[end].time - confirmationWindowSeconds;
      let windowStart = end;
      while (windowStart > index && samples[windowStart - 1].time >= windowStartTime) {
        windowStart -= 1;
      }
      const windowDuration = samples[end].time - samples[windowStart].time + frameInterval;
      if (windowDuration < 0.32) {
        continue;
      }
      const windowProjected = projected.slice(windowStart, end + 1);
      const verifiedFrames = windowProjected.filter((value, offset) =>
        value >= signalThreshold && targetDirected[windowStart + offset] && plausibleLightLevel[windowStart + offset],
      ).length;
      const peak = Math.max(...windowProjected);
      const settledRatio = frameInterval >= 0.15 ? 0.6 : 0.62;
      if (
        verifiedFrames >= Math.max(2, Math.ceil(windowProjected.length * settledRatio)) &&
        peak >= confirmationThreshold
      ) {
        confirmationEnd = end;
        break;
      }
    }
    if (confirmationEnd < 0) {
      continue;
    }

    const supportingIndices = indicesWhere(index, confirmationEnd, (supportIndex) =>
      projected[supportIndex] >= signalThreshold && targetDirected[supportIndex] && plausibleLightLevel[supportIndex],
    );
    if (supportingIndices.length < 2 || !hasConnectedEvidencePath({
      samples,
      projected,
      plausibleLightLevel,
      startIndex: index,
      endIndex: confirmationEnd,
      onsetThreshold,
      maxConnectedGapSeconds,
    })) {
      continue;
    }

    const onsetIndex = findConnectedPrecursorIndex({
      samples,
      projected,
      plausibleLightLevel,
      strictIndex: index,
      onsetThreshold,
      frameInterval,
    });
    const verification = projected.slice(index, confirmationEnd + 1);
    const persistentFrames = verification.filter((value) => value >= signalThreshold).length;
    const targetDirectedFrames = verification.filter((value, offset) =>
      value >= signalThreshold && targetDirected[index + offset] && plausibleLightLevel[index + offset],
    ).length;
    const peak = Math.max(...verification);
    const rawTime = roundTime(samples[onsetIndex].time);
    const expectedPenalty = expectedFinishTime === undefined ? 0 : Math.abs(rawTime - expectedFinishTime) * 2;
    const confidence: Confidence = peak >= Math.max(confirmationThreshold * 1.2, learnedSpan * 0.34) &&
        persistentFrames >= Math.ceil(verification.length * 0.42) &&
        targetDirectedFrames >= Math.ceil(verification.length * 0.2)
      ? "High"
      : "Medium";
    candidates.push({
      rawTime,
      confidence,
      reason: onsetIndex < index
        ? "The first faint return-color pixels were connected to a verified settled lane-light state."
        : "The first return-color flash was followed by a verified settled lane-light state.",
      score: roundTime(peak + persistentFrames - expectedPenalty),
      kind: "Lane-light finish reversal",
      method: "First finish flash with settled-color verification",
      rgb: signalColors[onsetIndex],
      distanceToBefore: roundTime(computeColorDistance(signalColors[onsetIndex], calibration.beforeStartRGB)),
      distanceToAfter: roundTime(computeColorDistance(signalColors[onsetIndex], calibration.afterStartRGB)),
      persistenceFrames: persistentFrames,
    });
  }

  if (!candidates.length) {
    return {
      detected: false,
      confidence: "None",
      reason: "The selected lane light never showed a connected return-color flash sequence followed by a settled state.",
      threshold: roundTime(signalThreshold),
      samples,
      candidates: [],
      baselineRgb,
    };
  }

  // Official time is a cross-check used by App auto-acceptance, never a reason
  // to replace the first valid visual reversal with a later one.
  const selected = [...candidates].sort((left, right) => left.rawTime - right.rawTime)[0];
  return {
    detected: true,
    rawTime: selected.rawTime,
    confidence: selected.confidence,
    reason: `Finish detected at the first return-color flash; later flashes and the settled color verified it.`,
    threshold: roundTime(signalThreshold),
    samples,
    candidates: [selected, ...candidates.filter((candidate) => candidate !== selected)].slice(0, 4),
    baselineRgb,
  };
}

function findConnectedPrecursorIndex({
  samples,
  projected,
  plausibleLightLevel,
  strictIndex,
  onsetThreshold,
  frameInterval,
}: {
  samples: FinishColorSample[];
  projected: number[];
  plausibleLightLevel: boolean[];
  strictIndex: number;
  onsetThreshold: number;
  frameInterval: number;
}): number {
  // A 5 fps discovery sample is too sparse to distinguish a dim precursor
  // from unrelated noise. The subsequent 30 fps pass has enough temporal
  // resolution to backtrack safely by at most about seven frames.
  if (frameInterval > 0.075) {
    return strictIndex;
  }

  const earliestTime = samples[strictIndex].time - 0.42;
  let onsetIndex = strictIndex;
  let evidenceFrames = 1;
  let consecutiveGapFrames = 0;
  for (let index = strictIndex - 1; index >= 0 && samples[index].time >= earliestTime; index -= 1) {
    if (projected[index] >= onsetThreshold && plausibleLightLevel[index]) {
      onsetIndex = index;
      evidenceFrames += 1;
      consecutiveGapFrames = 0;
      continue;
    }
    // A single sampled blue/occluded frame is common while the finish unit
    // flashes. Keep looking backward, but two consecutive gaps disconnect an
    // old flicker from the real transition.
    consecutiveGapFrames += 1;
    if (consecutiveGapFrames > 1) {
      break;
    }
  }
  if (onsetIndex === strictIndex || onsetIndex < 2 || evidenceFrames < 3) {
    return strictIndex;
  }

  // Require a clean source-color baseline immediately before the precursor.
  // This prevents a slow exposure drift from being pulled backward merely
  // because a real finish happens later in the same search window.
  const stableBefore = [projected[onsetIndex - 2], projected[onsetIndex - 1]]
    .every((value) => value < onsetThreshold);
  return stableBefore ? onsetIndex : strictIndex;
}

function hasConnectedEvidencePath({
  samples,
  projected,
  plausibleLightLevel,
  startIndex,
  endIndex,
  onsetThreshold,
  maxConnectedGapSeconds,
}: {
  samples: FinishColorSample[];
  projected: number[];
  plausibleLightLevel: boolean[];
  startIndex: number;
  endIndex: number;
  onsetThreshold: number;
  maxConnectedGapSeconds: number;
}): boolean {
  let lastEvidenceTime = samples[startIndex].time;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    if (projected[index] < onsetThreshold || !plausibleLightLevel[index]) continue;
    if (samples[index].time - lastEvidenceTime > maxConnectedGapSeconds + 1e-9) {
      return false;
    }
    lastEvidenceTime = samples[index].time;
  }
  return samples[endIndex].time - lastEvidenceTime <= maxConnectedGapSeconds + 1e-9;
}

function hasStableSourceBefore(
  samples: FinishColorSample[],
  projected: number[],
  index: number,
  onsetThreshold: number,
  lookbackSeconds: number,
): boolean {
  const earliestTime = samples[index].time - lookbackSeconds;
  let stableFrames = 0;
  for (let cursor = index - 1; cursor >= 0 && samples[cursor].time >= earliestTime; cursor -= 1) {
    if (projected[cursor] < onsetThreshold) {
      stableFrames += 1;
      if (stableFrames >= 2) return true;
    } else {
      stableFrames = 0;
    }
  }
  return false;
}

function indicesWhere(start: number, end: number, predicate: (index: number) => boolean): number[] {
  const indices: number[] = [];
  for (let index = start; index <= end; index += 1) {
    if (predicate(index)) indices.push(index);
  }
  return indices;
}

async function sampleFinishColors(
  video: HTMLVideoElement,
  zone: NormalizedZone,
  start: number,
  end: number,
  fps: number,
  calibration: StartLightCalibration,
  signal: AbortSignal | undefined,
  onProgress: (processed: number, total: number) => void,
): Promise<FinishColorSample[]> {
  const times = sampleFramesInRange(start, end, fps);
  const samples: FinishColorSample[] = [];
  const targetDirection = hasCalibration(calibration)
    ? Math.sign(opponent(calibration.beforeStartRGB) - opponent(calibration.afterStartRGB)) || 1
    : 1;
  for (let index = 0; index < times.length; index += 1) {
    throwIfCancelled(signal);
    const sampled = await sampleZoneOpponentColors(video, times[index], zone, targetDirection);
    samples.push({
      time: roundTime(sampled.time),
      averageRgb: sampled.averageRgb,
      directionalRgb: sampled.directionalRgb,
    });
    onProgress(index + 1, times.length);
    if (index % 8 === 7) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return samples;
}

function toResult(
  analysis: FinishAnalysis,
  zone: NormalizedZone,
  calibration: StartLightCalibration,
): StartSignalDetectionResult {
  const debugSamples: StartSignalDebug["samples"] = analysis.samples.map((sample) => ({
    time: sample.time,
    averageRgb: sample.directionalRgb ?? sample.averageRgb,
    colorDistance: computeColorDistance(sample.directionalRgb ?? sample.averageRgb, calibration.afterStartRGB!),
    distanceToBefore: computeColorDistance(sample.directionalRgb ?? sample.averageRgb, calibration.beforeStartRGB!),
    distanceToAfter: computeColorDistance(sample.directionalRgb ?? sample.averageRgb, calibration.afterStartRGB!),
    greenScore: (sample.directionalRgb ?? sample.averageRgb).g -
      Math.max((sample.directionalRgb ?? sample.averageRgb).r, (sample.directionalRgb ?? sample.averageRgb).b),
    blueScore: (sample.directionalRgb ?? sample.averageRgb).b -
      Math.max((sample.directionalRgb ?? sample.averageRgb).r, (sample.directionalRgb ?? sample.averageRgb).g),
  }));
  return {
    detected: analysis.detected,
    rawTime: analysis.rawTime,
    confidence: analysis.confidence,
    reason: analysis.reason,
    threshold: analysis.threshold,
    candidates: analysis.candidates,
    debug: {
      zoneExists: true,
      normalizedZone: zone,
      calibration,
      detectionMethod: "Same-lane finish light reversal",
      framesSampled: analysis.samples.length,
      baselineRgb: analysis.baselineRgb ?? calibration.afterStartRGB,
      maxColorDistance: Math.max(0, ...debugSamples.map((sample) => sample.colorDistance)),
      threshold: analysis.threshold,
      detectedCrossings: analysis.candidates.map((candidate) => ({
        time: candidate.rawTime,
        colorDistance: candidate.rgb && analysis.baselineRgb
          ? roundTime(computeColorDistance(candidate.rgb, analysis.baselineRgb))
          : candidate.score,
      })),
      firstThresholdCrossingTime: analysis.candidates[0]?.rawTime,
      selectedCandidateTime: analysis.rawTime,
      selectedCandidateReason: analysis.reason,
      detectedRawTime: analysis.rawTime,
      topCandidates: analysis.candidates,
      samples: debugSamples,
      failureReason: analysis.detected ? undefined : analysis.reason,
    },
  };
}

function emptyResult(reason: string, zone?: NormalizedZone): StartSignalDetectionResult {
  return {
    detected: false,
    confidence: "None",
    reason,
    threshold: 0,
    candidates: [],
    debug: {
      zoneExists: Boolean(zone),
      normalizedZone: zone,
      detectionMethod: "Same-lane finish light reversal",
      framesSampled: 0,
      maxColorDistance: 0,
      threshold: 0,
      detectedCrossings: [],
      samples: [],
      failureReason: reason,
    },
  };
}

function hasCalibration(calibration: StartLightCalibration): calibration is RequiredCalibration & StartLightCalibration {
  return Boolean(calibration.beforeStartRGB && calibration.afterStartRGB && calibration.colorDelta !== undefined);
}

function opponent(rgb: RGB): number {
  const total = Math.max(1, rgb.r + rgb.g + rgb.b);
  return (rgb.g - rgb.b) / total * 180;
}

function luminance(rgb: RGB): number {
  return rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722;
}

function chroma(rgb: RGB): number {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
}

function averageRgb(colors: RGB[]): RGB {
  if (!colors.length) return { r: 0, g: 0, b: 0 };
  return {
    r: Math.round(colors.reduce((sum, color) => sum + color.r, 0) / colors.length),
    g: Math.round(colors.reduce((sum, color) => sum + color.g, 0) / colors.length),
    b: Math.round(colors.reduce((sum, color) => sum + color.b, 0) / colors.length),
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function findLastIndexAtOrBefore(samples: FinishColorSample[], time: number): number {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].time <= time) {
      return index;
    }
  }
  return 0;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Finish-light detection cancelled.");
    error.name = "AbortError";
    throw error;
  }
}
