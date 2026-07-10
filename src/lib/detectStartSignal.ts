import type {
  Confidence,
  DetectionCandidate,
  NormalizedZone,
  RGB,
  Sensitivity,
  StartDetectionProfile,
  StartLightCalibration,
  StartSignalDebug,
  StartSignalDetectionResult,
} from "../types";
import { computeColorDistance, normalizedZoneToPixelRect, sampleFramesInRange, sampleZoneAverageColor } from "./videoFrameSampler";

interface DetectStartSignalOptions {
  video: HTMLVideoElement;
  zone?: NormalizedZone;
  searchStart: number;
  searchEnd: number;
  sensitivity: Sensitivity;
  lightVisibility?: "clear" | "blocked";
  profile?: StartDetectionProfile;
  calibration?: StartLightCalibration;
  fps?: number;
  signal?: AbortSignal;
}

const SENSITIVITY_THRESHOLDS: Record<Sensitivity, number> = {
  low: 45,
  medium: 28,
  high: 18,
};

const REQUIRED_FRAMES: Record<Sensitivity, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

const SHARP_CHANGE_THRESHOLDS: Record<Sensitivity, number> = {
  low: 14,
  medium: 8,
  high: 5,
};

export async function detectStartSignal({
  video,
  zone,
  searchStart,
  searchEnd,
  sensitivity,
  lightVisibility = "clear",
  profile = "auto",
  calibration,
  fps = 10,
  signal,
}: DetectStartSignalOptions): Promise<StartSignalDetectionResult> {
  const threshold = SENSITIVITY_THRESHOLDS[sensitivity];
  const debug: StartSignalDebug = {
    zoneExists: Boolean(zone),
    normalizedZone: zone,
    pixelZone: zone ? normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight) : undefined,
    calibration,
    detectionMethod: hasCalibration(calibration) && profile !== "auto" ? "Calibrated light transition" : "Generic color-distance detection",
    framesSampled: 0,
    maxColorDistance: 0,
    threshold,
    detectedCrossings: [],
    samples: [],
  };

  if (!zone) {
    debug.failureReason = "Start Light Zone is not set.";
    return result(false, "Start Signal not detected. Start Light Zone is not set.", "None", threshold, debug);
  }

  if (searchEnd <= searchStart) {
    debug.failureReason = "Start search window end must be after the start.";
    return result(false, "Start Signal not detected. Search window is invalid.", "None", threshold, debug);
  }

  const times = sampleFramesInRange(searchStart, searchEnd, fps);
  if (times.length < 4) {
    debug.failureReason = "Search window is too short for sustained color detection.";
    return result(false, "Start Signal not detected. Search window is too short.", "None", threshold, debug);
  }

  try {
    for (const time of times) {
      throwIfCancelled(signal);
      const sample = await sampleZoneAverageColor(video, time, zone);
      throwIfCancelled(signal);
      debug.samples.push({
        time: sample.time,
        averageRgb: sample.averageRgb,
        colorDistance: 0,
        greenScore: sample.averageRgb.g - Math.max(sample.averageRgb.r, sample.averageRgb.b),
        blueScore: sample.averageRgb.b - Math.max(sample.averageRgb.r, sample.averageRgb.g),
      });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    debug.framesSampled = debug.samples.length;
    debug.failureReason = error instanceof Error ? error.message : "Unknown start signal detection error.";
    return result(false, "Start Signal not detected. Frame sampling failed.", "None", threshold, debug);
  }

  debug.framesSampled = debug.samples.length;
  const baselineSamples = debug.samples.filter((sample) => sample.time <= searchStart + 0.5);
  const baseline = averageRgb(baselineSamples.map((sample) => sample.averageRgb));
  debug.baselineRgb = baseline;

  const baselineGreenScore = averageNumber(baselineSamples.map((sample) => sample.greenScore));
  const baselineBlueScore = averageNumber(baselineSamples.map((sample) => sample.blueScore));

  for (const sample of debug.samples) {
    sample.colorDistance = computeColorDistance(sample.averageRgb, baseline);
    debug.maxColorDistance = Math.max(debug.maxColorDistance, sample.colorDistance);
    if (sample.colorDistance >= threshold) {
      debug.detectedCrossings.push({ time: sample.time, colorDistance: roundMetric(sample.colorDistance) });
    }
  }

  smoothColorDistances(debug.samples);
  applyCalibrationDistances(debug.samples, calibration);
  debug.firstThresholdCrossingTime = debug.samples.find((sample) => (sample.smoothedColorDistance ?? 0) >= threshold)?.time;
  const strongestSample = getStrongestSample(debug.samples);
  debug.strongestSignalTime = strongestSample?.time;

  const requiredFrames = REQUIRED_FRAMES[sensitivity];
  const shouldUseCalibration = hasCalibration(calibration) && (profile === "auto" || profile === "calibrated" || profile === "blocked" || profile === "manual");
  if (shouldUseCalibration) {
    const calibratedResult = detectCalibratedTransition({
      samples: debug.samples,
      searchStart,
      searchEnd,
      requiredFrames: profile === "blocked" ? Math.max(1, requiredFrames - 1) : requiredFrames,
      calibration: calibration as RequiredCalibration,
      manualReviewOnly: profile === "manual",
      blockedMode: profile === "blocked" || lightVisibility === "blocked",
    });
    debug.detectionMethod = "Calibrated light transition";
    debug.topCandidates = calibratedResult.candidates;
    debug.selectedCandidateTime = calibratedResult.selected?.rawTime;
    debug.selectedCandidateReason = calibratedResult.selected?.reason;

    if (calibratedResult.selected && profile !== "manual") {
      debug.detectedRawTime = calibratedResult.selected.rawTime;
      return result(
        true,
        calibratedResult.selected.reason,
        calibratedResult.selected.confidence,
        threshold,
        debug,
        calibratedResult.selected.rawTime,
        calibratedResult.candidates,
      );
    }

    debug.failureReason = calibratedResult.failureReason;
    return result(false, "Start Signal not detected.", "None", threshold, debug, undefined, calibratedResult.candidates);
  }

  const candidates = buildStartCandidates({
    samples: debug.samples,
    searchStart,
    searchEnd,
    threshold,
    requiredFrames,
    sharpChangeThreshold: SHARP_CHANGE_THRESHOLDS[sensitivity],
    baselineGreenScore,
    baselineBlueScore,
    blockedLightMode: lightVisibility === "blocked",
    manualReviewOnly: profile === "manual",
  });
  debug.topCandidates = candidates;

  const selectedCandidate = profile === "manual"
    ? undefined
    : selectStartCandidate(candidates, searchStart, searchEnd, threshold, requiredFrames, lightVisibility === "blocked");
  if (!selectedCandidate) {
    if (strongestSample && isNearEnd(strongestSample.time, searchEnd)) {
      debug.failureReason = "Strongest signal occurred at the end of the search window. Increase the window or adjust the Start Light Zone.";
    } else if (strongestSample && strongestSample.colorDistance >= threshold * 0.75) {
      debug.failureReason = "No reliable start found. Review the candidate list or tighten the Start Light Zone.";
    } else {
      debug.failureReason = debug.maxColorDistance > 4
        ? `No meaningful color change reached ${formatNumber(threshold * 0.75)} candidate strength.`
        : "Color change was extremely low in the Start Light Zone.";
    }

    return result(false, "Start Signal not detected.", "None", threshold, debug, undefined, candidates);
  }

  debug.detectedRawTime = selectedCandidate.rawTime;
  debug.selectedCandidateTime = selectedCandidate.rawTime;
  debug.selectedCandidateReason = selectedCandidate.reason;

  const strongestLater = strongestSample && Math.abs(strongestSample.time - selectedCandidate.rawTime) > 0.001;
  const boundaryNote = selectedCandidate.boundaryRisk
    ? " This may be inaccurate because it occurs at the edge of the search window."
    : "";
  const reason = strongestLater
    ? "Selected the first sustained color-change onset instead of the largest later signal."
    : selectedCandidate.reason;
  const selectedSample = debug.samples.find((sample) => sample.time === selectedCandidate.rawTime);
  const colorCueBoost = selectedSample
    ? baselineGreenScore - selectedSample.greenScore > 8 && selectedSample.blueScore - baselineBlueScore > 8
    : false;
  const confidence = selectedCandidate.confidence === "Low"
    ? "Low"
    : getConfidence(selectedCandidate.score, threshold, colorCueBoost, selectedCandidate.persistenceFrames ?? 1, requiredFrames);

  const blockedNote = lightVisibility === "blocked"
    ? " Because the light may be blocked, the visible color change can occur slightly after the true start."
    : "";
  return result(true, `${reason}${boundaryNote}${blockedNote}`, confidence, threshold, debug, selectedCandidate.rawTime, candidates);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Start-light detection cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function buildStartCandidates({
  samples,
  searchStart,
  searchEnd,
  threshold,
  requiredFrames,
  sharpChangeThreshold,
  baselineGreenScore,
  baselineBlueScore,
  blockedLightMode,
  manualReviewOnly,
}: {
  samples: StartSignalDebug["samples"];
  searchStart: number;
  searchEnd: number;
  threshold: number;
  requiredFrames: number;
  sharpChangeThreshold: number;
  baselineGreenScore: number;
  baselineBlueScore: number;
  blockedLightMode: boolean;
  manualReviewOnly: boolean;
}): DetectionCandidate[] {
  const candidates = new Map<string, DetectionCandidate>();
  const elevatedThreshold = threshold * 0.75;

  samples.forEach((sample, index) => {
    const smoothed = sample.smoothedColorDistance ?? sample.colorDistance;
    const delta = sample.deltaFromPrevious ?? 0;
    const persistenceFrames = countElevatedFrames(samples, index, elevatedThreshold);
    const greenDrop = baselineGreenScore - sample.greenScore;
    const blueRise = sample.blueScore - baselineBlueScore;
    const hasGreenBlueShift = greenDrop > 6 && blueRise > 6 && smoothed >= threshold * 0.5;
    const crossesThreshold = smoothed >= threshold;
    const sharpJump = delta >= sharpChangeThreshold && smoothed >= threshold * 0.55;
    const earliestWeakShift = blockedLightMode && delta >= sharpChangeThreshold * 0.45 && smoothed >= threshold * 0.3;

    if (crossesThreshold || sharpJump || hasGreenBlueShift || earliestWeakShift) {
      const kind = crossesThreshold
        ? "First visible color shift"
        : hasGreenBlueShift
          ? "Green-to-blue shift"
          : earliestWeakShift
            ? "Earliest weak color shift"
            : "First visible color shift";
      const boundaryRisk = isNearEnd(sample.time, searchEnd) || isNearStart(sample.time, searchStart);
      const score = roundMetric(smoothed);
      candidates.set(candidateKey(sample.time, kind), {
        rawTime: sample.time,
        confidence: getCandidateConfidence(score, threshold, persistenceFrames, requiredFrames, boundaryRisk),
        reason: `${kind}. ${persistenceFrames} elevated sample${persistenceFrames === 1 ? "" : "s"} after onset.`,
        score,
        kind,
        method: "Generic color-distance detection",
        rgb: sample.averageRgb,
        boundaryRisk,
        persistenceFrames,
      });
    }
  });

  const strongest = getStrongestSample(samples);
  if (strongest && (strongest.smoothedColorDistance ?? strongest.colorDistance) >= threshold * 0.6) {
    const score = roundMetric(strongest.smoothedColorDistance ?? strongest.colorDistance);
    const index = samples.indexOf(strongest);
    const boundaryRisk = isNearEnd(strongest.time, searchEnd) || isNearStart(strongest.time, searchStart);
    candidates.set(candidateKey(strongest.time, "Strongest color change"), {
      rawTime: strongest.time,
      confidence: boundaryRisk ? "Low" : score >= threshold ? "Medium" : "Low",
      reason: boundaryRisk
        ? "Strongest color change, but it occurs at the edge of the search window."
        : "Strongest color change for manual review.",
      score,
      kind: "Strongest color change",
      method: "Generic color-distance detection",
      rgb: strongest.averageRgb,
      boundaryRisk,
      persistenceFrames: index >= 0 ? countElevatedFrames(samples, index, threshold * 0.75) : 1,
    });
  }

  return Array.from(candidates.values())
    .sort((a, b) => candidateRank(a, threshold, requiredFrames) - candidateRank(b, threshold, requiredFrames))
    .slice(0, manualReviewOnly ? 5 : 3);
}

type RequiredCalibration = Required<Pick<StartLightCalibration, "beforeStartRGB" | "afterStartRGB" | "colorDelta">>;

function detectCalibratedTransition({
  samples,
  searchStart,
  searchEnd,
  requiredFrames,
  calibration,
  manualReviewOnly,
  blockedMode,
}: {
  samples: StartSignalDebug["samples"];
  searchStart: number;
  searchEnd: number;
  requiredFrames: number;
  calibration: RequiredCalibration;
  manualReviewOnly: boolean;
  blockedMode: boolean;
}): { selected?: DetectionCandidate; candidates: DetectionCandidate[]; failureReason?: string } {
  const candidates = new Map<string, DetectionCandidate>();
  const minAfterAdvantage = Math.max(2, calibration.colorDelta * 0.08);

  samples.forEach((sample, index) => {
    const distanceToBefore = sample.distanceToBefore ?? 0;
    const distanceToAfter = sample.distanceToAfter ?? 0;
    const afterAdvantage = distanceToBefore - distanceToAfter;
    const afterLike = afterAdvantage >= minAfterAdvantage || distanceToAfter < distanceToBefore;
    const persistenceFrames = countAfterLikeFrames(samples, index, minAfterAdvantage);
    const boundaryRisk = isNearEnd(sample.time, searchEnd) || isNearStart(sample.time, searchStart);
    const weakEarly = blockedMode && afterAdvantage >= minAfterAdvantage * 0.4;

    if (afterLike || weakEarly) {
      const kind = weakEarly && !afterLike ? "Earliest weak calibrated shift" : "Calibrated light transition";
      const confidence = getCalibratedConfidence({
        colorDelta: calibration.colorDelta,
        afterAdvantage,
        persistenceFrames,
        requiredFrames,
        boundaryRisk,
      });
      candidates.set(candidateKey(sample.time, kind), {
        rawTime: sample.time,
        confidence,
        reason: `Frame became closer to calibrated after-start color for ${persistenceFrames} consecutive sample${persistenceFrames === 1 ? "" : "s"}.`,
        score: roundMetric(afterAdvantage),
        kind,
        method: "Calibrated light transition",
        rgb: sample.averageRgb,
        distanceToBefore: roundMetric(distanceToBefore),
        distanceToAfter: roundMetric(distanceToAfter),
        boundaryRisk,
        persistenceFrames,
      });
    }
  });

  const ranked = Array.from(candidates.values())
    .sort((a, b) => candidateRank(a, Math.max(1, calibration.colorDelta), requiredFrames, blockedMode) - candidateRank(b, Math.max(1, calibration.colorDelta), requiredFrames, blockedMode))
    .slice(0, manualReviewOnly ? 5 : 3);
  const selected = manualReviewOnly
    ? undefined
    : ranked.find((candidate) =>
      !candidate.boundaryRisk &&
      (candidate.persistenceFrames ?? 0) >= requiredFrames &&
      candidate.score >= minAfterAdvantage,
    );

  if (!selected) {
    const boundaryOnly = ranked.length > 0 && ranked.every((candidate) => candidate.boundaryRisk);
    return {
      candidates: ranked,
      failureReason: boundaryOnly
        ? "Calibrated transition candidates are near the search-window boundary. Expand or shift the search window."
        : "No reliable calibrated transition found. Review candidates or reset before/after samples.",
    };
  }

  return { selected, candidates: ranked };
}

function applyCalibrationDistances(samples: StartSignalDebug["samples"], calibration?: StartLightCalibration): void {
  if (!hasCalibration(calibration)) {
    return;
  }

  for (const sample of samples) {
    sample.distanceToBefore = roundMetric(computeColorDistance(sample.averageRgb, calibration.beforeStartRGB));
    sample.distanceToAfter = roundMetric(computeColorDistance(sample.averageRgb, calibration.afterStartRGB));
    sample.afterScore = roundMetric(sample.distanceToBefore - sample.distanceToAfter);
  }
}

function countAfterLikeFrames(samples: StartSignalDebug["samples"], startIndex: number, minAfterAdvantage: number): number {
  let count = 0;
  for (let index = startIndex; index < samples.length; index += 1) {
    const advantage = (samples[index].distanceToBefore ?? 0) - (samples[index].distanceToAfter ?? 0);
    if (advantage >= minAfterAdvantage || (samples[index].distanceToAfter ?? Infinity) < (samples[index].distanceToBefore ?? 0)) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function getCalibratedConfidence({
  colorDelta,
  afterAdvantage,
  persistenceFrames,
  requiredFrames,
  boundaryRisk,
}: {
  colorDelta: number;
  afterAdvantage: number;
  persistenceFrames: number;
  requiredFrames: number;
  boundaryRisk: boolean;
}): Confidence {
  if (boundaryRisk || colorDelta < 12) {
    return "Low";
  }
  if (colorDelta >= 35 && afterAdvantage >= colorDelta * 0.2 && persistenceFrames >= requiredFrames) {
    return "High";
  }
  if (colorDelta >= 18 && persistenceFrames >= Math.min(2, requiredFrames)) {
    return "Medium";
  }
  return "Low";
}

function hasCalibration(calibration?: StartLightCalibration): calibration is RequiredCalibration {
  return Boolean(calibration?.beforeStartRGB && calibration.afterStartRGB && calibration.colorDelta !== undefined);
}

function selectStartCandidate(
  candidates: DetectionCandidate[],
  searchStart: number,
  searchEnd: number,
  threshold: number,
  requiredFrames: number,
  blockedLightMode: boolean,
): DetectionCandidate | undefined {
  const reliable = candidates
    .filter((candidate) => !isNearEnd(candidate.rawTime, searchEnd))
    .filter((candidate) => !isNearStart(candidate.rawTime, searchStart) || candidate.score >= threshold * 1.5)
    .filter((candidate) => candidate.score >= threshold * (blockedLightMode ? 0.3 : 0.75))
    .filter((candidate) =>
      blockedLightMode ||
      (candidate.persistenceFrames ?? 1) >= requiredFrames ||
      candidate.score >= threshold,
    );

  return reliable.sort((a, b) => candidateRank(a, threshold, requiredFrames, blockedLightMode) - candidateRank(b, threshold, requiredFrames, blockedLightMode))[0];
}

function smoothColorDistances(samples: StartSignalDebug["samples"]): void {
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.colorDistance ?? samples[index].colorDistance;
    const current = samples[index].colorDistance;
    const next = samples[index + 1]?.colorDistance ?? samples[index].colorDistance;
    samples[index].smoothedColorDistance = roundMetric((previous + current + next) / 3);
  }

  for (let index = 0; index < samples.length; index += 1) {
    samples[index].deltaFromPrevious = roundMetric(
      index === 0 ? 0 : (samples[index].smoothedColorDistance ?? 0) - (samples[index - 1].smoothedColorDistance ?? 0),
    );
  }
}

function getStrongestSample(samples: StartSignalDebug["samples"]): StartSignalDebug["samples"][number] | undefined {
  return samples.reduce<StartSignalDebug["samples"][number] | undefined>((strongest, sample) => {
    const signal = sample.smoothedColorDistance ?? sample.colorDistance;
    const strongestSignal = strongest ? strongest.smoothedColorDistance ?? strongest.colorDistance : -Infinity;
    return signal > strongestSignal ? sample : strongest;
  }, undefined);
}

function candidateRank(candidate: DetectionCandidate, threshold: number, requiredFrames: number, blockedLightMode = false): number {
  const boundaryPenalty = candidate.boundaryRisk ? 100000 : 0;
  const persistenceBonus = Math.min(candidate.persistenceFrames ?? 0, requiredFrames) * 20;
  const strengthBonus = Math.min(candidate.score / threshold, 2) * 10;
  const weakShiftBonus = blockedLightMode && candidate.kind === "Earliest weak color shift" ? 35 : 0;
  const timeWeight = blockedLightMode ? 135 : 100;
  return boundaryPenalty + candidate.rawTime * timeWeight - persistenceBonus - strengthBonus - weakShiftBonus;
}

function countElevatedFrames(samples: StartSignalDebug["samples"], startIndex: number, elevatedThreshold: number): number {
  let count = 0;
  for (let index = startIndex; index < samples.length; index += 1) {
    if ((samples[index].smoothedColorDistance ?? samples[index].colorDistance) >= elevatedThreshold) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function getCandidateConfidence(
  signal: number,
  threshold: number,
  persistenceFrames: number,
  requiredFrames: number,
  boundaryRisk: boolean,
): Confidence {
  if (boundaryRisk) {
    return "Low";
  }
  const ratio = threshold > 0 ? signal / threshold : 0;
  if (ratio >= 1.5 && persistenceFrames >= requiredFrames) {
    return "High";
  }
  if (ratio >= 1 && persistenceFrames >= Math.min(2, requiredFrames)) {
    return "Medium";
  }
  return "Low";
}

function getConfidence(
  distance: number,
  threshold: number,
  colorCueBoost: boolean,
  persistenceFrames: number,
  requiredFrames: number,
): Confidence {
  const ratio = threshold > 0 ? distance / threshold : 0;
  if ((ratio >= 1.55 || (ratio >= 1.3 && colorCueBoost)) && persistenceFrames >= requiredFrames) {
    return "High";
  }
  if (ratio >= 1 || colorCueBoost || persistenceFrames >= Math.min(2, requiredFrames)) {
    return "Medium";
  }
  return "Low";
}

function isNearEnd(time: number, searchEnd: number): boolean {
  return time >= searchEnd - 0.25;
}

function isNearStart(time: number, searchStart: number): boolean {
  return time <= searchStart + 0.1;
}

function averageRgb(values: RGB[]): RGB {
  if (!values.length) {
    return { r: 0, g: 0, b: 0 };
  }

  return {
    r: Math.round(values.reduce((sum, rgb) => sum + rgb.r, 0) / values.length),
    g: Math.round(values.reduce((sum, rgb) => sum + rgb.g, 0) / values.length),
    b: Math.round(values.reduce((sum, rgb) => sum + rgb.b, 0) / values.length),
  };
}

function averageNumber(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function candidateKey(time: number, kind: string): string {
  return `${time.toFixed(3)}-${kind}`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatNumber(value: number): string {
  return value.toFixed(3);
}

function result(
  detected: boolean,
  reason: string,
  confidence: Confidence,
  threshold: number,
  debug: StartSignalDebug,
  rawTime?: number,
  candidates?: DetectionCandidate[],
): StartSignalDetectionResult {
  return {
    detected,
    rawTime,
    confidence,
    reason,
    threshold,
    debug,
    candidates,
  };
}
