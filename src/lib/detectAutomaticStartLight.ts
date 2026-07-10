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
const DISCOVERY_MAX_WIDTH = 360;
const DISCOVERY_MAX_HEIGHT = 240;
const PATCH_RADII = [0, 1, 2, 3] as const;
// The start box always sits at the base of the wall, below the first and second holds,
// so a real lane light can never be in the top of the frame.
const MIN_START_BOX_Y_NORM = 0.22;

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
}

interface InternalColorCandidate {
  x: number;
  y: number;
  radius: number;
  frameIndex: number;
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
  score: number;
}

interface AutomaticStartLightOptions {
  video: HTMLVideoElement;
  searchStart: number;
  searchEnd: number;
  startBodyZone?: NormalizedZone;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
}

export interface GreenBlueAnalysisOptions {
  /** Climber's start-position zone; the lane light sits below and near it. */
  startBodyZone?: NormalizedZone;
}

/** Locates a fixed light that is green before start and remains blue afterward. */
export async function detectAutomaticStartLight({
  video,
  searchStart,
  searchEnd,
  startBodyZone,
  signal,
  onProgress,
}: AutomaticStartLightOptions): Promise<AutomaticStartLightResult> {
  const times = sampleFramesInRange(searchStart, searchEnd, DISCOVERY_FPS)
    .filter((time) => time <= searchEnd + 1e-7);
  if (times.length < 6) {
    return emptyDiscovery("The start search window is too short to locate a green-to-blue light.");
  }

  const frames = await captureDiscoveryFrames(video, times, signal, onProgress);
  checkCancelled(signal);
  const discovery = analyzeGreenBlueFrames(frames, { startBodyZone });
  if (!discovery.found || !discovery.zone || !discovery.calibration || discovery.transitionTime === undefined) {
    return discovery;
  }

  const laneCandidates = discovery.laneCandidates?.slice(0, 3) ?? [discoveryToLaneCandidate(discovery)];
  const refinedPairs: Array<{ lane: GreenBlueLaneCandidate; result: StartSignalDetectionResult }> = [];
  for (const lane of laneCandidates) {
    const refined = await detectStartSignal({
      video,
      zone: lane.zone,
      searchStart: Math.max(searchStart, lane.transitionTime - 0.9),
      searchEnd: Math.min(searchEnd, lane.transitionTime + 0.9),
      sensitivity: lane.confidence === "Low" ? "high" : "medium",
      lightVisibility: "clear",
      profile: "calibrated",
      calibration: lane.calibration,
      fps: 30,
      signal,
    });
    checkCancelled(signal);
    if (refined.detected && refined.rawTime !== undefined) {
      refined.debug.detectionMethod = "Automatically located green-to-blue start light";
      refined.reason = `ClimbIQ found a green-to-blue lane sensor automatically. ${refined.reason}`;
      refined.candidates = refined.candidates?.map((candidate) => ({
        ...candidate,
        method: "Automatic green-to-blue light detection",
      }));
      refinedPairs.push({ lane, result: refined });
    }
  }

  if (refinedPairs.length) {
    const primary = refinedPairs[0];
    return {
      ...discovery,
      ...laneToDiscoveryFields(primary.lane),
      result: primary.result,
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
  let upperFrameRejections = 0;

  for (const radius of PATCH_RADII) {
    const stride = Math.max(1, radius + 1);
    for (let y = radius; y < height - radius; y += stride) {
      const yNorm = y / height;
      for (let x = radius; x < width - radius; x += stride) {
        const patchColors: Array<RGB | undefined> = new Array(frames.length);
        const colorAt = (index: number): RGB =>
          (patchColors[index] ??= averagePatch(frames[index], x, y, radius));

        for (let frameIndex = 2; frameIndex < frames.length; frameIndex += 1) {
          const afterRgb = colorAt(frameIndex);
          const afterBlue = blueSignal(afterRgb);
          if (afterBlue < 5 || afterRgb.b < 24) {
            continue;
          }
          // The light must have been green for at least two frames right before the
          // flip, but the green run may start anywhere in the window — a light that
          // only arms after recording begins is still found.
          if (!isGreenish(colorAt(frameIndex - 1)) || !isGreenish(colorAt(frameIndex - 2))) {
            continue;
          }
          let runStart = frameIndex - 1;
          while (runStart > 0 && isGreenish(colorAt(runStart - 1))) {
            runStart -= 1;
          }
          const greenRun: RGB[] = [];
          for (let index = runStart; index < frameIndex; index += 1) {
            greenRun.push(colorAt(index));
          }
          const baselineRgb = averageRgbList(greenRun);
          const baselineGreen = greenSignal(baselineRgb);
          if (baselineGreen < 6 || baselineRgb.g < 24) {
            continue;
          }
          const previousRgb = colorAt(frameIndex - 1);
          if (greenSignal(previousRgb) < Math.max(2.5, baselineGreen * 0.18)) {
            continue;
          }
          const colorDelta = computeColorDistance(previousRgb, afterRgb);
          if (colorDelta < 12) {
            continue;
          }
          const remainingEnd = Math.min(frames.length, frameIndex + 12);
          const blueColors: RGB[] = [];
          let remainingCount = 0;
          for (let index = frameIndex; index < remainingEnd; index += 1) {
            const rgb = colorAt(index);
            remainingCount += 1;
            if (blueSignal(rgb) >= 4 && rgb.b >= 22) {
              blueColors.push(rgb);
            }
          }
          const blueRatio = remainingCount ? blueColors.length / remainingCount : 0;
          if (blueColors.length < Math.min(2, remainingCount) || blueRatio < 0.62) {
            continue;
          }

          if (yNorm < MIN_START_BOX_Y_NORM) {
            upperFrameRejections += 1;
            break;
          }

          const score = baselineGreen * 1.1 + afterBlue * 1.3 + colorDelta * 0.28 + blueRatio * 32 + radius * 0.5 +
            startBoxPositionBoost(x / width, yNorm, options?.startBodyZone);
          candidates.push({
            x,
            y,
            radius,
            frameIndex,
            beforeRgb: previousRgb,
            afterRgb,
            stableBeforeRgb: baselineRgb,
            stableAfterRgb: averageRgbList(blueColors.slice(0, 6)),
            baselineGreen,
            afterBlue,
            blueRatio,
            colorDelta,
            score,
          });
          break;
        }
      }
    }
  }

  if (!candidates.length) {
    return emptyDiscovery(
      upperFrameRejections > 0
        ? "Green-to-blue changes appeared only in the upper frame, above where the start box can sit below the first two holds. Motion fallback will be used."
        : "No fixed region changed from sustained green to sustained blue. Motion fallback will be used.",
    );
  }

  const separated = selectSpatialCandidates(candidates, width, height).slice(0, 4);
  const laneCandidates = separated.map((candidate) => candidateToLane(candidate, frames, width, height));
  const best = laneCandidates[0];
  return {
    found: true,
    ...laneToDiscoveryFields(best),
    laneCandidates,
    reason: `Found ${laneCandidates.length} possible lane light${laneCandidates.length === 1 ? "" : "s"} with sustained green→blue behavior in the lower frame, where the start box sits below the first two holds.`,
  };
}

/**
 * Scores how plausible a lane-light location is. The start box is mounted at the
 * base of the wall below the first two holds, so lower-frame candidates are boosted
 * and, when a Start Body Zone exists, candidates near or below the climber win.
 */
function startBoxPositionBoost(xNorm: number, yNorm: number, startBodyZone?: NormalizedZone): number {
  let boost = yNorm * 26;
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
  const confidence: Confidence = candidate.baselineGreen >= 25 && candidate.afterBlue >= 18 &&
      candidate.colorDelta >= 45 && candidate.blueRatio >= 0.75
    ? "High"
    : candidate.baselineGreen >= 9 && candidate.afterBlue >= 7 && candidate.colorDelta >= 20
      ? "Medium"
      : "Low";
  // Calibrate on the averaged sustained colors rather than the two frames around
  // the flip: a mid-fade transition frame would poison later 30 fps refinement.
  const calibration: StartLightCalibration = {
    beforeStartRGB: candidate.stableBeforeRgb,
    afterStartRGB: candidate.stableAfterRgb,
    colorDelta: roundMetric(computeColorDistance(candidate.stableBeforeRgb, candidate.stableAfterRgb)),
    calibrationFrameBeforeTime: beforeFrame.time,
    calibrationFrameAfterTime: transitionFrame.time,
  };
  return {
    zone: zoneAround(candidate.x, candidate.y, width, height, candidate.radius),
    transitionTime: transitionFrame.time,
    beforeTime: beforeFrame.time,
    afterTime: transitionFrame.time,
    beforeRgb: candidate.beforeRgb,
    afterRgb: candidate.afterRgb,
    calibration,
    confidence,
    score: roundMetric(candidate.score),
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
    reason: "First sustained blue frame after the automatically located sensor was green.",
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
    reason: "ClimbIQ located the green-to-blue sensor automatically; timestamp resolution is approximately 0.20s because fine refinement was inconclusive.",
    threshold: Math.max(1, calibration.colorDelta ?? 1),
    candidates: [candidate],
    debug: {
      zoneExists: true,
      normalizedZone: discovery.zone,
      calibration,
      detectionMethod: "Automatic green-to-blue light discovery (coarse)",
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
  return greenSignal(rgb) >= 2.5 && rgb.g >= 24;
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

function zoneAround(x: number, y: number, width: number, height: number, radius = 0): NormalizedZone {
  const halfWidth = Math.max(radius * 2 + 4, 5, Math.round(width * 0.015));
  const halfHeight = Math.max(radius * 2 + 4, 5, Math.round(height * 0.02));
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
