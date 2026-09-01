import type {
  Confidence,
  DetectionCandidate,
  NormalizedZone,
  RGB,
  StartLightCalibration,
  StartSignalDetectionResult,
} from "../types";
import { detectStartSignal } from "./detectStartSignal";
import { computeColorDistance, roundTime, sampleFramesInRange, seekTo } from "./videoFrameSampler";

const DISCOVERY_FPS = 5;
const DISCOVERY_MAX_WIDTH = 480;
const DISCOVERY_MAX_HEIGHT = 320;
const PATCH_RADII = [0, 1, 2, 3] as const;
const MIN_START_REGION_Y_NORM = 0.42;
// At 5 fps, a real electronic light reaches a verifiable blue state within
// two sampled steps of its first faint blue tint. A longer gap means an
// athlete, shoe, or shadow changed earlier and the actual light changed later.
const MAX_BLUE_VERIFICATION_DELAY_SECONDS = 0.5;

export interface DownsampledColorFrame {
  time: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GreenBlueDiscovery {
  found: boolean;
  zone?: NormalizedZone;
  transitionTime?: number;
  beforeTime?: number;
  afterTime?: number;
  beforeRgb?: RGB;
  afterRgb?: RGB;
  calibration?: StartLightCalibration;
  confidence: Confidence;
  score: number;
  reason: string;
  laneCandidates?: GreenBlueLaneCandidate[];
}

export interface AutomaticStartLightResult extends GreenBlueDiscovery {
  result?: StartSignalDetectionResult;
  laneResults?: StartSignalDetectionResult[];
}

export interface GreenBlueLaneCandidate {
  zone: NormalizedZone;
  transitionTime: number;
  beforeTime: number;
  afterTime: number;
  beforeRgb: RGB;
  afterRgb: RGB;
  calibration: StartLightCalibration;
  confidence: Confidence;
  score: number;
  /** The verified blue light was later obscured before the search window ended. */
  lightVisibility?: "clear" | "blocked";
}

interface InternalColorCandidate {
  x: number;
  y: number;
  radius: number;
  /** First frame that durably departs from the stable green color. */
  frameIndex: number;
  /** Later frame that confirms the transition reached blue. */
  verifiedBlueFrameIndex: number;
  beforeRgb: RGB;
  afterRgb: RGB;
  /** Average color of the sustained green run before the flip; stabler than one frame. */
  stableBeforeRgb: RGB;
  /** Average color of the confirmed blue frames after the flip. */
  stableAfterRgb: RGB;
  baselineGreen: number;
  afterBlue: number;
  blueRatio: number;
  colorDelta: number;
  localizedOpponentShift: number;
  laterOccluded: boolean;
  score: number;
}

interface AutomaticStartLightOptions {
  video: HTMLVideoElement;
  searchStart: number;
  searchEnd: number;
  startBodyZone?: NormalizedZone;
  expectedStartTime?: number;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
}

export interface GreenBlueAnalysisOptions {
  /** Climber's start-position zone; the lane light sits below and near it. */
  startBodyZone?: NormalizedZone;
  /** Exact audio cue, when available, boosts the lane transition at that time. */
  expectedStartTime?: number;
}

/** Locates a fixed light that is green before start and remains blue afterward. */
export async function detectAutomaticStartLight({
  video,
  searchStart,
  searchEnd,
  startBodyZone,
  expectedStartTime,
  signal,
  onProgress,
}: AutomaticStartLightOptions): Promise<AutomaticStartLightResult> {
  // Exact protocol audio is authoritative and narrows expensive pixel scanning
  // to the relevant few seconds. If audio is unavailable, discovery still scans
  // the complete user clip as a visual-only fallback.
  const discoveryStart = expectedStartTime === undefined
    ? searchStart
    : Math.max(searchStart, expectedStartTime - 2.2);
  const discoveryEnd = expectedStartTime === undefined
    ? searchEnd
    : Math.min(searchEnd, expectedStartTime + 2.8);
  const times = sampleFramesInRange(discoveryStart, discoveryEnd, DISCOVERY_FPS)
    .filter((time) => time <= discoveryEnd + 1e-7);
  if (times.length < 6) {
    return emptyDiscovery("The start search window is too short to locate a green-to-blue light.");
  }

  const frames = await captureDiscoveryFrames(video, times, signal, onProgress);
  checkCancelled(signal);
  const discovery = analyzeGreenBlueFrames(frames, { startBodyZone, expectedStartTime });
  if (!discovery.found || !discovery.zone || !discovery.calibration || discovery.transitionTime === undefined) {
    return discovery;
  }

  const laneCandidates = discovery.laneCandidates?.slice(0, 3) ?? [discoveryToLaneCandidate(discovery)];
  const refinedPairs: Array<{ lane: GreenBlueLaneCandidate; result: StartSignalDetectionResult }> = [];
  for (const lane of laneCandidates) {
    const refined = await detectStartSignal({
      video,
      zone: lane.zone,
      // Coarse discovery is only 0.2 s per frame. A narrow backtrack captures
      // the first faint source frame without reopening older athlete/shadow
      // transients such as the reproducible false 8.9 s candidate in 12.24.
      searchStart: Math.max(
        searchStart,
        lane.transitionTime - 0.35,
        expectedStartTime === undefined ? 0 : expectedStartTime - 0.25,
      ),
      searchEnd: Math.min(searchEnd, Math.max(lane.afterTime + 0.5, lane.transitionTime + 0.9)),
      sensitivity: lane.confidence === "Low" ? "high" : "medium",
      lightVisibility: lane.lightVisibility ?? "clear",
      profile: "calibrated",
      calibration: lane.calibration,
      fps: 30,
      colorSamplingMode: "opponent",
      signal,
    });
    checkCancelled(signal);
    if (refined.detected && refined.rawTime !== undefined) {
      const refinementBacktrackedToDifferentEvent = Math.abs(refined.rawTime - lane.transitionTime) > 0.28;
      if (refinementBacktrackedToDifferentEvent) {
        const coarseLaneResult = buildCoarseResult({
          found: true,
          ...laneToDiscoveryFields(lane),
          reason: "Fine refinement reached an older unrelated color event; the sustained coarse lane transition was retained.",
          laneCandidates,
        });
        coarseLaneResult.debug.calibration = refined.debug.calibration ?? lane.calibration;
        refinedPairs.push({ lane, result: coarseLaneResult });
        continue;
      }
      refined.debug.detectionMethod = "Automatically located green-to-blue start light";
      refined.reason = `ClimbIQ found a green-to-blue lane sensor automatically. ${refined.reason}`;
      refined.candidates = refined.candidates?.map((candidate) => ({
        ...candidate,
        method: "Automatic green-to-blue light detection",
      }));
      refinedPairs.push({ lane, result: refined });
    } else {
      // Do not let one easy/bright lane erase a valid faint or partly blocked
      // lane merely because its 30 fps refinement was inconclusive.
      const coarseLaneResult = buildCoarseResult({
          found: true,
          ...laneToDiscoveryFields(lane),
          reason: "The lane passed sustained coarse verification but fine refinement was inconclusive.",
          laneCandidates,
        });
      coarseLaneResult.debug.calibration = refined.debug.calibration ?? lane.calibration;
      refinedPairs.push({ lane, result: coarseLaneResult });
    }
  }

  if (refinedPairs.length) {
    const primary = refinedPairs[0];
    return {
      ...discovery,
      ...laneToDiscoveryFields(primary.lane),
      result: primary.result,
      laneCandidates: refinedPairs.map((pair) => pair.lane),
      laneResults: refinedPairs.map((pair) => pair.result),
    };
  }

  return {
    ...discovery,
    result: buildCoarseResult(discovery),
    laneResults: laneCandidates.map((lane) => buildCoarseResult({
      found: true,
      ...laneToDiscoveryFields(lane),
      reason: discovery.reason,
      laneCandidates,
    })),
    reason: `${discovery.reason} Fine frame refinement was inconclusive, so the coarse color transition is marked for review.`,
  };
}

export function analyzeGreenBlueFrames(
  frames: DownsampledColorFrame[],
  options?: GreenBlueAnalysisOptions,
): GreenBlueDiscovery {
  if (frames.length < 6) {
    return emptyDiscovery("At least six color frames are required.");
  }
  const { width, height } = frames[0];
  if (width < 4 || height < 4 || frames.some((frame) => frame.width !== width || frame.height !== height)) {
    return emptyDiscovery("Color scan frames have inconsistent dimensions.");
  }

  const candidates: InternalColorCandidate[] = [];
  const globalColors = frames.map(averageFrame);

  for (const radius of PATCH_RADII) {
    const stride = Math.max(1, radius + 1);
    const firstY = Math.max(radius, Math.ceil(height * MIN_START_REGION_Y_NORM / stride) * stride);
    for (let y = firstY; y < height - radius; y += stride) {
      const yNorm = y / height;
      for (let x = radius; x < width - radius; x += stride) {
        const patchColors: Array<RGB | undefined> = new Array(frames.length);
        const colorAt = (index: number): RGB =>
          (patchColors[index] ??= averagePatch(frames[index], x, y, radius));

        for (let blueFrameIndex = 2; blueFrameIndex < frames.length; blueFrameIndex += 1) {
          const verifiedBlueRgb = colorAt(blueFrameIndex);
          const afterBlue = blueSignal(verifiedBlueRgb);
          if (afterBlue < 0.65 || verifiedBlueRgb.b < 8) {
            continue;
          }
          // A later sustained-blue run verifies that this is the lane light.
          const remainingEnd = Math.min(frames.length, blueFrameIndex + 12);
          const blueSamples: Array<{ index: number; color: RGB }> = [];
          let remainingCount = 0;
          for (let index = blueFrameIndex; index < remainingEnd; index += 1) {
            const rgb = colorAt(index);
            remainingCount += 1;
            if (blueSignal(rgb) >= 0.5 && rgb.b >= 8) {
              blueSamples.push({ index, color: rgb });
            }
          }
          let contiguousBlueFrames = 0;
          for (let index = blueFrameIndex; index < frames.length; index += 1) {
            const rgb = colorAt(index);
            if (blueSignal(rgb) < 0.5 || rgb.b < 8) {
              break;
            }
            contiguousBlueFrames += 1;
          }
          const tailStart = Math.max(blueFrameIndex, frames.length - 4);
          let terminalBlueFrames = 0;
          for (let index = tailStart; index < frames.length; index += 1) {
            const rgb = colorAt(index);
            if (blueSignal(rgb) >= 0.5 && rgb.b >= 8) {
              terminalBlueFrames += 1;
            }
          }
          const terminalFrameCount = frames.length - tailStart;
          const blueRatio = remainingCount ? blueSamples.length / remainingCount : 0;
          if (contiguousBlueFrames < Math.min(2, frames.length - blueFrameIndex)) {
            continue;
          }
          // A complete climb contains a later finish reversal, so the start
          // light need not still be blue at the end of the uploaded video.
          // Ten coarse frames (about two seconds) is long enough to reject a
          // passing shoe/object while preserving the real start state.
          const hasLongPostStartState = contiguousBlueFrames >= 10;
          const remainsBlue = blueRatio >= 0.55 && (
            terminalBlueFrames >= Math.max(1, Math.ceil(terminalFrameCount * 0.5)) ||
            hasLongPostStartState
          );

          // Intermediate fade frames can still be green-dominant. Build the
          // baseline from the greenest recent samples, then timestamp the first
          // durable color departure and use these blue frames only as proof.
          const lookbackStart = Math.max(0, blueFrameIndex - 10);
          const greenBaselineSamples = Array.from(
            { length: blueFrameIndex - lookbackStart },
            (_, offset) => ({ index: lookbackStart + offset, color: colorAt(lookbackStart + offset) }),
          )
            .filter((sample) => isGreenish(sample.color))
            .sort((left, right) => greenSignal(right.color) - greenSignal(left.color))
            .slice(0, 5);
          if (greenBaselineSamples.length < 2) {
            continue;
          }
          const greenBaselineColors = greenBaselineSamples.map((sample) => sample.color);
          const baselineRgb = averageRgbList(greenBaselineColors);
          const stableAfterSamples = blueSamples.slice(0, 6);
          const stableAfterRgb = averageRgbList(stableAfterSamples.map((sample) => sample.color));
          const baselineGreen = greenSignal(baselineRgb);
          const colorDelta = computeColorDistance(baselineRgb, stableAfterRgb);
          const globalBeforeRgb = averageRgbList(greenBaselineSamples.map((sample) => globalColors[sample.index]));
          const globalAfterRgb = averageRgbList(stableAfterSamples.map((sample) => globalColors[sample.index]));
          const localOpponentShift = greenBlueOpponent(baselineRgb) - greenBlueOpponent(stableAfterRgb);
          const globalOpponentShift = greenBlueOpponent(globalBeforeRgb) - greenBlueOpponent(globalAfterRgb);
          const localizedOpponentShift = localOpponentShift - globalOpponentShift;
          const beforeLuminance = relativeLuminance(baselineRgb);
          const afterLuminance = relativeLuminance(stableAfterRgb);
          if (
            baselineGreen < 0.65 || baselineRgb.g < 8 || colorDelta < 3 ||
            localOpponentShift < 0.9 ||
            localizedOpponentShift < Math.max(0.6, localOpponentShift * 0.18) ||
            stableAfterRgb.b < baselineRgb.b - 2 ||
            afterLuminance < beforeLuminance * 0.65
          ) {
            continue;
          }

          const correctedBaselineOpponent = greenBlueOpponent(baselineRgb) - greenBlueOpponent(globalBeforeRgb);
          const correctedOpponentAt = (index: number): number =>
            greenBlueOpponent(colorAt(index)) - greenBlueOpponent(globalColors[index]);
          const baselineDistances = greenBaselineSamples.map((sample) =>
            Math.abs(correctedOpponentAt(sample.index) - correctedBaselineOpponent),
          );
          const baselineDistance = medianNumber(baselineDistances);
          const baselineDeviation = medianNumber(
            baselineDistances.map((value) => Math.abs(value - baselineDistance)),
          );
          const departureThreshold = Math.max(
            0.45,
            localizedOpponentShift * 0.04,
            baselineDistance + Math.max(0.3, baselineDeviation * 4),
          );
          const stableGreenLimit = Math.max(0.6, localizedOpponentShift * 0.035, baselineDistance + baselineDeviation * 3);
          let onsetFrameIndex = -1;
          const earliestBlueDirectedOnset = Math.max(
            lookbackStart + 2,
            frames.findIndex((frame) =>
              frame.time >= frames[blueFrameIndex].time - MAX_BLUE_VERIFICATION_DELAY_SECONDS,
            ),
          );
          for (let index = earliestBlueDirectedOnset; index <= blueFrameIndex; index += 1) {
            const previousStable = [index - 2, index - 1].every((previousIndex) =>
              isGreenish(colorAt(previousIndex)) &&
              Math.abs(correctedOpponentAt(previousIndex) - correctedBaselineOpponent) <= stableGreenLimit,
            );
            const departure = correctedBaselineOpponent - correctedOpponentAt(index);
            if (!previousStable || departure < departureThreshold) {
              continue;
            }
            const lookAheadEnd = Math.min(blueFrameIndex + 1, index + 3);
            let departedFrames = 0;
            for (let nextIndex = index; nextIndex < lookAheadEnd; nextIndex += 1) {
              if (correctedBaselineOpponent - correctedOpponentAt(nextIndex) >= departureThreshold) {
                departedFrames += 1;
              }
            }
            if (departedFrames >= Math.min(2, lookAheadEnd - index)) {
              onsetFrameIndex = index;
              break;
            }
          }
          if (onsetFrameIndex < 0) {
            continue;
          }
          const blueVerificationDelay = frames[blueFrameIndex].time - frames[onsetFrameIndex].time;
          if (blueVerificationDelay > MAX_BLUE_VERIFICATION_DELAY_SECONDS + 1e-7) {
            continue;
          }
          // The exact same/same/different audio cue is authoritative enough to
          // retain an initially sustained blue verification even when the
          // athlete covers the sensor later. Unguided scans still require blue
          // through the tail, which keeps passing blue objects review-only.
          const laterOccluded = !remainsBlue && isCueAlignedLaterOcclusion({
            frames,
            colorAt,
            onsetFrameIndex,
            blueFrameIndex,
            contiguousBlueFrames,
            expectedStartTime: options?.expectedStartTime,
          });
          if (!remainsBlue && !laterOccluded) {
            continue;
          }
          const previousRgb = colorAt(onsetFrameIndex - 1);

          const temporalBoost = options?.expectedStartTime === undefined
            ? 0
            : Math.max(-100, 160 - Math.abs(frames[onsetFrameIndex].time - options.expectedStartTime) * 400);
          const score = Math.min(baselineGreen, 30) * 0.7 + Math.min(afterBlue, 30) * 0.9 +
            Math.min(colorDelta, 50) * 0.25 + Math.min(localizedOpponentShift, 30) * 4 +
            blueRatio * 30 - radius * 1.5 - blueVerificationDelay * 20 + temporalBoost +
            startBoxPositionBoost(x / width, yNorm, options?.startBodyZone);
          candidates.push({
            x,
            y,
            radius,
            frameIndex: onsetFrameIndex,
            verifiedBlueFrameIndex: blueFrameIndex,
            beforeRgb: previousRgb,
            afterRgb: colorAt(onsetFrameIndex),
            stableBeforeRgb: baselineRgb,
            stableAfterRgb,
            baselineGreen,
            afterBlue,
            blueRatio,
            colorDelta,
            localizedOpponentShift,
            laterOccluded,
            score,
          });
          break;
        }
      }
    }
  }

  if (!candidates.length) {
    return emptyDiscovery("No localized lower-wall region changed from stable green to persistent blue after frame-wide color drift and dark occlusions were removed. Audio fallback will be used.");
  }

  const separated = selectSpatialCandidates(candidates, width, height).slice(0, 4);
  const laneCandidates = separated.map((candidate) => candidateToLane(candidate, frames, width, height));
  const best = laneCandidates[0];
  return {
    found: true,
    ...laneToDiscoveryFields(best),
    laneCandidates,
    reason: `Found ${laneCandidates.length} possible lane light${laneCandidates.length === 1 ? "" : "s"}; timing starts at the first sustained departure from green and later blue frames verify the change.`,
  };
}

function isCueAlignedLaterOcclusion({
  frames,
  colorAt,
  onsetFrameIndex,
  blueFrameIndex,
  contiguousBlueFrames,
  expectedStartTime,
}: {
  frames: DownsampledColorFrame[];
  colorAt: (index: number) => RGB;
  onsetFrameIndex: number;
  blueFrameIndex: number;
  contiguousBlueFrames: number;
  expectedStartTime?: number;
}): boolean {
  if (
    expectedStartTime === undefined ||
    Math.abs(frames[onsetFrameIndex].time - expectedStartTime) > 0.45
  ) {
    return false;
  }

  const firstCoveredIndex = blueFrameIndex + contiguousBlueFrames;
  if (firstCoveredIndex >= frames.length) {
    return false;
  }
  const tailStart = Math.max(firstCoveredIndex, frames.length - 4);
  const terminalColors = frames.slice(tailStart).map((_, offset) => colorAt(tailStart + offset));
  if (terminalColors.length < 2) {
    return false;
  }
  const coveredFrames = terminalColors.filter((rgb) => !isGreenish(rgb) && blueSignal(rgb) < 0.5).length;
  return coveredFrames >= Math.max(2, Math.ceil(terminalColors.length * 0.67));
}

/**
 * Scores how plausible a lane-light location is. The start box is mounted at the
 * base of the wall below the first two holds, so lower-frame candidates are boosted
 * and, when a Start Body Zone exists, candidates near or below the climber win.
 */
function startBoxPositionBoost(xNorm: number, yNorm: number, startBodyZone?: NormalizedZone): number {
  let boost = yNorm * 26;
  // Cropped and portrait videos can place the physical floor surprisingly high,
  // so upper-frame position lowers confidence instead of hard-rejecting a cue.
  if (yNorm < 0.12) {
    boost -= 28;
  }
  if (startBodyZone) {
    const zoneWidth = Math.max(0.02, startBodyZone.x2 - startBodyZone.x1);
    const zoneCenterX = (startBodyZone.x1 + startBodyZone.x2) / 2;
    const horizontalDistance = Math.max(0, Math.abs(xNorm - zoneCenterX) - zoneWidth * 1.5);
    boost -= Math.min(30, horizontalDistance * 90);
    const zoneMidY = (startBodyZone.y1 + startBodyZone.y2) / 2;
    if (yNorm >= zoneMidY) {
      boost += 18;
    } else if (yNorm < startBodyZone.y1) {
      boost -= 25;
    }
  }
  return boost;
}

function selectSpatialCandidates(
  candidates: InternalColorCandidate[],
  width: number,
  height: number,
): InternalColorCandidate[] {
  const selected: InternalColorCandidate[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    const isDuplicate = selected.some((existing) => {
      const distance = Math.hypot(
        (candidate.x - existing.x) / width,
        (candidate.y - existing.y) / height,
      );
      return distance < 0.1 && Math.abs(candidate.frameIndex - existing.frameIndex) <= 2;
    });
    if (!isDuplicate) {
      selected.push(candidate);
    }
    if (selected.length >= 6) {
      break;
    }
  }
  return selected;
}

function candidateToLane(
  candidate: InternalColorCandidate,
  frames: DownsampledColorFrame[],
  width: number,
  height: number,
): GreenBlueLaneCandidate {
  const transitionFrame = frames[candidate.frameIndex];
  const beforeFrame = frames[candidate.frameIndex - 1];
  const verifiedBlueFrame = frames[candidate.verifiedBlueFrameIndex];
  const positionIsUncertain = candidate.y / height < 0.2;
  const confidence: Confidence = !positionIsUncertain && candidate.baselineGreen >= 18 && candidate.afterBlue >= 14 &&
      candidate.colorDelta >= 35 && candidate.blueRatio >= 0.75 && candidate.localizedOpponentShift >= 12
    ? "High"
    : !positionIsUncertain && candidate.baselineGreen >= 3 && candidate.afterBlue >= 2.5 &&
        candidate.colorDelta >= 8 && candidate.localizedOpponentShift >= 3
      ? "Medium"
      : "Low";
  // Calibrate on the averaged sustained colors rather than the two frames around
  // the flip: a mid-fade transition frame would poison later 30 fps refinement.
  const calibration: StartLightCalibration = {
    beforeStartRGB: candidate.stableBeforeRgb,
    afterStartRGB: candidate.stableAfterRgb,
    colorDelta: roundMetric(computeColorDistance(candidate.stableBeforeRgb, candidate.stableAfterRgb)),
    calibrationFrameBeforeTime: beforeFrame.time,
    calibrationFrameAfterTime: verifiedBlueFrame.time,
  };
  return {
    zone: zoneAround(candidate.x, candidate.y, width, height, candidate.radius),
    transitionTime: transitionFrame.time,
    beforeTime: beforeFrame.time,
    afterTime: verifiedBlueFrame.time,
    beforeRgb: candidate.beforeRgb,
    afterRgb: candidate.afterRgb,
    calibration,
    confidence,
    score: roundMetric(candidate.score),
    lightVisibility: candidate.laterOccluded ? "blocked" : "clear",
  };
}

function laneToDiscoveryFields(lane: GreenBlueLaneCandidate): Omit<GreenBlueDiscovery, "found" | "reason" | "laneCandidates"> {
  return {
    zone: lane.zone,
    transitionTime: lane.transitionTime,
    beforeTime: lane.beforeTime,
    afterTime: lane.afterTime,
    beforeRgb: lane.beforeRgb,
    afterRgb: lane.afterRgb,
    calibration: lane.calibration,
    confidence: lane.confidence,
    score: lane.score,
  };
}

function discoveryToLaneCandidate(discovery: GreenBlueDiscovery): GreenBlueLaneCandidate {
  return {
    zone: discovery.zone!,
    transitionTime: discovery.transitionTime!,
    beforeTime: discovery.beforeTime!,
    afterTime: discovery.afterTime!,
    beforeRgb: discovery.beforeRgb!,
    afterRgb: discovery.afterRgb!,
    calibration: discovery.calibration!,
    confidence: discovery.confidence,
    score: discovery.score,
  };
}

async function captureDiscoveryFrames(
  video: HTMLVideoElement,
  times: number[],
  signal?: AbortSignal,
  onProgress?: (processed: number, total: number) => void,
): Promise<DownsampledColorFrame[]> {
  const scale = Math.min(1, DISCOVERY_MAX_WIDTH / video.videoWidth, DISCOVERY_MAX_HEIGHT / video.videoHeight);
  const width = Math.max(32, Math.round(video.videoWidth * scale));
  const height = Math.max(24, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable for automatic light discovery.");
  }

  const frames: DownsampledColorFrame[] = [];
  for (let index = 0; index < times.length; index += 1) {
    checkCancelled(signal);
    await seekTo(video, times[index]);
    checkCancelled(signal);
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    frames.push({
      time: roundTime(video.currentTime),
      width,
      height,
      data: new Uint8ClampedArray(pixels),
    });
    onProgress?.(index + 1, times.length);
    await yieldToMain();
  }
  return frames;
}

function buildCoarseResult(discovery: GreenBlueDiscovery): StartSignalDetectionResult {
  const rawTime = discovery.transitionTime!;
  const beforeRgb = discovery.beforeRgb!;
  const afterRgb = discovery.afterRgb!;
  const calibration = discovery.calibration!;
  const confidence: Confidence = discovery.confidence === "High" ? "Medium" : "Low";
  const candidate: DetectionCandidate = {
    rawTime,
    confidence,
    reason: "First sustained departure from green; later blue frames verified the automatically located sensor change.",
    score: discovery.score,
    kind: "Automatic green-to-blue transition",
    method: "Automatic green-to-blue light detection",
    rgb: afterRgb,
    persistenceFrames: 2,
  };
  return {
    detected: true,
    rawTime,
    confidence,
    reason: "ClimbIQ located the sensor automatically and marked its first sustained departure from green; later blue frames verified the change. Timestamp resolution is approximately 0.20s because fine refinement was inconclusive.",
    threshold: Math.max(1, calibration.colorDelta ?? 1),
    candidates: [candidate],
    debug: {
      zoneExists: true,
      normalizedZone: discovery.zone,
      calibration,
      detectionMethod: "Automatic green-departure discovery with later blue verification (coarse)",
      framesSampled: 2,
      baselineRgb: beforeRgb,
      maxColorDistance: calibration.colorDelta ?? 0,
      threshold: Math.max(1, calibration.colorDelta ?? 1),
      detectedCrossings: [{ time: rawTime, colorDistance: calibration.colorDelta ?? 0 }],
      firstThresholdCrossingTime: rawTime,
      selectedCandidateTime: rawTime,
      selectedCandidateReason: candidate.reason,
      detectedRawTime: rawTime,
      topCandidates: [candidate],
      samples: [
        {
          time: discovery.beforeTime!,
          averageRgb: beforeRgb,
          colorDistance: 0,
          greenScore: greenDominance(beforeRgb),
          blueScore: blueDominance(beforeRgb),
        },
        {
          time: rawTime,
          averageRgb: afterRgb,
          colorDistance: calibration.colorDelta ?? 0,
          greenScore: greenDominance(afterRgb),
          blueScore: blueDominance(afterRgb),
        },
      ],
    },
  };
}

function isGreenish(rgb: RGB): boolean {
  return greenSignal(rgb) >= 0.5 && rgb.g >= 8;
}

function averageRgbList(colors: RGB[]): RGB {
  if (!colors.length) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: Math.round(colors.reduce((sum, color) => sum + color.r, 0) / colors.length),
    g: Math.round(colors.reduce((sum, color) => sum + color.g, 0) / colors.length),
    b: Math.round(colors.reduce((sum, color) => sum + color.b, 0) / colors.length),
  };
}

function medianNumber(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function averagePatch(frame: DownsampledColorFrame, centerX: number, centerY: number, radius: number): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const left = Math.max(0, centerX - radius);
  const right = Math.min(frame.width - 1, centerX + radius);
  const top = Math.max(0, centerY - radius);
  const bottom = Math.min(frame.height - 1, centerY + radius);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = (y * frame.width + x) * 4;
      r += frame.data[index] ?? 0;
      g += frame.data[index + 1] ?? 0;
      b += frame.data[index + 2] ?? 0;
      count += 1;
    }
  }
  return count ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) } : { r: 0, g: 0, b: 0 };
}

function averageFrame(frame: DownsampledColorFrame): RGB {
  const red = new Uint32Array(256);
  const green = new Uint32Array(256);
  const blue = new Uint32Array(256);
  let count = 0;
  for (let index = 0; index < frame.data.length; index += 4) {
    red[frame.data[index] ?? 0] += 1;
    green[frame.data[index + 1] ?? 0] += 1;
    blue[frame.data[index + 2] ?? 0] += 1;
    count += 1;
  }
  return count
    ? {
        r: trimmedHistogramMean(red, count, 0.1),
        g: trimmedHistogramMean(green, count, 0.1),
        b: trimmedHistogramMean(blue, count, 0.1),
      }
    : { r: 0, g: 0, b: 0 };
}

function trimmedHistogramMean(histogram: Uint32Array, count: number, trimRatio: number): number {
  let trimLow = Math.floor(count * trimRatio);
  let trimHigh = Math.floor(count * trimRatio);
  let total = 0;
  let kept = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    let amount = histogram[value];
    const removed = Math.min(amount, trimLow);
    amount -= removed;
    trimLow -= removed;
    histogram[value] = amount;
  }
  for (let value = histogram.length - 1; value >= 0; value -= 1) {
    let amount = histogram[value];
    const removed = Math.min(amount, trimHigh);
    amount -= removed;
    trimHigh -= removed;
    histogram[value] = amount;
  }
  for (let value = 0; value < histogram.length; value += 1) {
    total += value * histogram[value];
    kept += histogram[value];
  }
  return kept ? total / kept : 0;
}

function zoneAround(x: number, y: number, width: number, height: number, radius = 0): NormalizedZone {
  const halfWidth = Math.max(radius + 2, 3, Math.round(width * 0.007));
  const halfHeight = Math.max(radius + 2, 3, Math.round(height * 0.009));
  return {
    id: "startLight",
    label: "Auto-detected green-to-blue start light",
    x1: Math.max(0, (x - halfWidth) / width),
    y1: Math.max(0, (y - halfHeight) / height),
    x2: Math.min(1, (x + halfWidth) / width),
    y2: Math.min(1, (y + halfHeight) / height),
  };
}

function greenDominance(rgb: RGB): number {
  return rgb.g - Math.max(rgb.r, rgb.b);
}

function blueDominance(rgb: RGB): number {
  return rgb.b - Math.max(rgb.r, rgb.g);
}

function greenSignal(rgb: RGB): number {
  return Math.max(greenDominance(rgb), chromaticDominance(rgb.g, rgb.r, rgb.b) * 180);
}

function blueSignal(rgb: RGB): number {
  return Math.max(blueDominance(rgb), chromaticDominance(rgb.b, rgb.r, rgb.g) * 180);
}

function greenBlueOpponent(rgb: RGB): number {
  const total = rgb.r + rgb.g + rgb.b;
  return total > 0 ? (rgb.g - rgb.b) / total * 180 : 0;
}

function relativeLuminance(rgb: RGB): number {
  return rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722;
}

function chromaticDominance(primary: number, otherA: number, otherB: number): number {
  const total = primary + otherA + otherB;
  return total > 0 ? (primary - Math.max(otherA, otherB)) / total : 0;
}

function emptyDiscovery(reason: string): GreenBlueDiscovery {
  return { found: false, confidence: "None", score: 0, reason };
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Automatic start-light discovery cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
