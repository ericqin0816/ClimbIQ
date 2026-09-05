import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  Confidence,
  PoseLandmarkPoint,
  WallCalibration,
  WallPoint,
} from "../types";
import { applyTrajectoryKinematics } from "./biomechanics";
import { getStandardSpeedHold } from "./standardSpeedRoute";
import { resolveOfficialFinishRawTime } from "./officialTime";
import { projectImagePointToWall, validateWallCalibration } from "./wallCalibration";

export type BiomechanicsFinishSource = "top-completion" | "accepted-finish" | "analysis-end";

export interface BiomechanicsFinishEvidence {
  peakRawTime?: number;
  peakHeightMeters?: number;
  topZoneReached: boolean;
  upwardGainMeters?: number;
  descentDropMeters?: number;
  descentDurationSeconds?: number;
  downwardProgressRatio?: number;
  descentSamples?: number;
  maximumTrackingGapSeconds?: number;
  hold20HandDistanceMeters?: number;
  hold20HandRawTime?: number;
}

export interface BiomechanicsFinishCutoff {
  /** Inclusive raw-video cutoff for charts, splits, and video overlays. */
  cutoffRawTime: number;
  /** The accepted finish or analysis end before optional top trimming. */
  hardLimitRawTime: number;
  acceptedFinishRawTime?: number;
  source: BiomechanicsFinishSource;
  confidence: Confidence;
  reason: string;
  evidence: BiomechanicsFinishEvidence;
}

export interface DeriveBiomechanicsFinishOptions {
  acceptedFinishRawTime?: number | null;
  calibration?: WallCalibration;
}

export interface TrimmedBiomechanicsFinishResult {
  result: BiomechanicsResult;
  cutoff: BiomechanicsFinishCutoff;
  removedFrames: number;
}

export type AutomaticPoseFinishSource = "accepted-light" | "official-time";

export interface AutomaticPoseFinishBoundary {
  ready: boolean;
  endRawTime?: number;
  source?: AutomaticPoseFinishSource;
  reason: string;
}

export interface ResolveAutomaticPoseFinishOptions {
  startRawTime: number;
  videoDuration: number;
  lightFinishRawTime?: number | null;
  lightFinishAccepted?: boolean;
  officialTotalSeconds?: number | null;
}

/**
 * Resolves a finite climb-only pose boundary. It never falls back to the end
 * of the clip: without an accepted finish or an official total, COM is paused.
 * A review cursor can be a physical top reach, not actual pad contact, and must
 * not silently become an authoritative end boundary for downstream metrics.
 */
export function resolveAutomaticPoseFinishBoundary({
  startRawTime,
  videoDuration,
  lightFinishRawTime,
  lightFinishAccepted = false,
  officialTotalSeconds,
}: ResolveAutomaticPoseFinishOptions): AutomaticPoseFinishBoundary {
  if (!Number.isFinite(startRawTime) || !Number.isFinite(videoDuration) || videoDuration <= startRawTime) {
    return { ready: false, reason: "The video or accepted start is invalid." };
  }
  const lightFinish = finiteNumber(lightFinishRawTime);
  const validLightFinish = lightFinish !== undefined && lightFinish > startRawTime + 0.2 &&
      lightFinish <= videoDuration + 0.001
    ? Math.min(videoDuration, lightFinish)
    : undefined;
  const officialFinish = resolveOfficialFinishRawTime({
    startRawTime,
    videoDuration,
    officialTotalSeconds,
  });

  if (lightFinishAccepted && validLightFinish !== undefined) {
    return {
      ready: true,
      endRawTime: validLightFinish,
      source: "accepted-light",
      reason: "Using the automatically accepted lane-light finish.",
    };
  }
  if (officialFinish !== undefined && officialFinish > startRawTime + 0.2) {
    return {
      ready: true,
      endRawTime: officialFinish,
      source: "official-time",
      reason: "Using the official total-time finish boundary.",
    };
  }
  return {
    ready: false,
    reason: "No finish boundary was verified, so COM analysis was stopped before scanning the descent.",
  };
}

interface ProgressSample {
  frame: BiomechanicsFrame;
  rawTime: number;
  wall: WallPoint;
}

interface Hand20Evidence {
  rawTime: number;
  distanceMeters: number;
}

const HOLD_20 = getStandardSpeedHold(20).wall;
const HAND_LANDMARK_INDICES = [15, 16, 17, 18, 19, 20, 21, 22] as const;

/**
 * Finds an inclusive, safe biomechanics cutoff. The accepted finish is always
 * a hard upper bound. An earlier cutoff is returned only when the tracked
 * athlete credibly completes the top and then remains in a sustained downward
 * trajectory, which prevents a normal upward backstep from ending the climb.
 */
export function deriveBiomechanicsFinishCutoff(
  result: BiomechanicsResult,
  options: DeriveBiomechanicsFinishOptions = {},
): BiomechanicsFinishCutoff {
  const acceptedFinish = finiteNumber(options.acceptedFinishRawTime);
  const analysisEnd = finiteNumber(result.endRawTime) ?? maximumFiniteFrameTime(result.frames) ?? result.startRawTime;
  const hardLimitRawTime = acceptedFinish === undefined
    ? analysisEnd
    : Math.min(acceptedFinish, analysisEnd);
  const baseSource: BiomechanicsFinishSource = acceptedFinish !== undefined && acceptedFinish <= analysisEnd
    ? "accepted-finish"
    : "analysis-end";
  const baseReason = baseSource === "accepted-finish"
    ? "Using the accepted finish because no safe earlier completed-top descent was confirmed."
    : acceptedFinish !== undefined
      ? "Biomechanics analysis already ends before the accepted finish, and no safe earlier completed-top descent was confirmed."
      : "No accepted finish was available; using the biomechanics analysis end."

  const samples = buildProgressSamples(result, hardLimitRawTime);
  const emptyEvidence: BiomechanicsFinishEvidence = { topZoneReached: false };
  if (samples.length < 5) {
    return baseCutoff(
      hardLimitRawTime,
      acceptedFinish,
      baseSource,
      baseReason,
      emptyEvidence,
    );
  }

  const wallHeight = validWallHeight(options.calibration) ?? 15;
  const peakIndex = indexOfHighestSample(samples);
  const peak = samples[peakIndex];
  const minimumBeforePeak = Math.min(...samples.slice(0, peakIndex + 1).map((sample) => sample.wall.yMeters));
  const upwardGain = peak.wall.yMeters - minimumBeforePeak;
  const topZoneThreshold = wallHeight * 0.82;
  const topZoneReached = peak.wall.yMeters >= topZoneThreshold;
  const handEvidence = findHold20HandEvidence(
    result,
    options.calibration,
    hardLimitRawTime,
    peak.rawTime,
  );
  const handSupportedTop = Boolean(
    handEvidence &&
    handEvidence.distanceMeters <= 0.65 &&
    peak.wall.yMeters >= wallHeight * 0.68,
  );

  const descent = evaluateTerminalDescent(samples, peakIndex, result.settings.sampleFps, wallHeight);
  const evidence: BiomechanicsFinishEvidence = {
    peakRawTime: peak.rawTime,
    peakHeightMeters: peak.wall.yMeters,
    topZoneReached,
    upwardGainMeters: upwardGain,
    descentDropMeters: descent.dropMeters,
    descentDurationSeconds: descent.durationSeconds,
    downwardProgressRatio: descent.downwardProgressRatio,
    descentSamples: descent.samples,
    maximumTrackingGapSeconds: descent.maximumGapSeconds,
    hold20HandDistanceMeters: handEvidence?.distanceMeters,
    hold20HandRawTime: handEvidence?.rawTime,
  };

  const enoughUpwardProgress = upwardGain >= Math.max(3, wallHeight * 0.25);
  if (!(topZoneReached || handSupportedTop) || !enoughUpwardProgress || !descent.accepted) {
    return baseCutoff(
      hardLimitRawTime,
      acceptedFinish,
      baseSource,
      baseReason,
      evidence,
    );
  }

  const plateauStart = firstPeakPlateauSample(samples, peakIndex, descent.maximumAllowedGapSeconds, wallHeight);
  const handCanDefineCompletion = handSupportedTop && handEvidence &&
    handEvidence.rawTime >= plateauStart.rawTime - 0.8 &&
    handEvidence.rawTime <= peak.rawTime + 0.4;
  const cutoffRawTime = Math.min(
    hardLimitRawTime,
    handCanDefineCompletion ? handEvidence.rawTime : plateauStart.rawTime,
  );
  const confidence = topCompletionConfidence(result, options.calibration, Boolean(handCanDefineCompletion));
  const reason = handCanDefineCompletion
    ? `Trimmed at the first credible top completion: a tracked hand came within ${handEvidence.distanceMeters.toFixed(2)} m of Hold 20, followed by ${descent.dropMeters.toFixed(2)} m of sustained descent.`
    : `Trimmed at the first credible top plateau (${peak.wall.yMeters.toFixed(2)} m COM height), followed by ${descent.dropMeters.toFixed(2)} m of sustained descent without a return to the top.`;

  return {
    cutoffRawTime,
    hardLimitRawTime,
    acceptedFinishRawTime: acceptedFinish,
    source: "top-completion",
    confidence,
    reason,
    evidence,
  };
}

/** Returns chronological frames at or before the inclusive safe cutoff. */
export function framesThroughBiomechanicsFinish(
  result: BiomechanicsResult,
  cutoff: BiomechanicsFinishCutoff | number,
): BiomechanicsFrame[] {
  const cutoffRawTime = typeof cutoff === "number" ? cutoff : cutoff.cutoffRawTime;
  if (!Number.isFinite(cutoffRawTime)) {
    return [];
  }
  return result.frames
    .filter((frame) => Number.isFinite(frame.rawTime) && frame.rawTime <= cutoffRawTime + 1e-9)
    .sort((left, right) => left.rawTime - right.rawTime);
}

/**
 * Builds a chart/split/overlay-safe result and recomputes every derived metric
 * from only the climb frames. The stored analysis can keep its accepted timing
 * basis while all performance consumers exclude a verified post-finish fall.
 */
export function trimBiomechanicsResultAtFinish(
  result: BiomechanicsResult,
  calibration: WallCalibration,
  options: DeriveBiomechanicsFinishOptions = {},
): TrimmedBiomechanicsFinishResult {
  const cutoff = deriveBiomechanicsFinishCutoff(result, { ...options, calibration });
  const frames = framesThroughBiomechanicsFinish(result, cutoff);
  const removedFrames = Math.max(0, result.frames.length - frames.length);
  if (!removedFrames && Math.abs(cutoff.cutoffRawTime - result.endRawTime) <= 1e-9) {
    return { result, cutoff, removedFrames: 0 };
  }

  const validation = validateWallCalibration(calibration);
  if (!validation.valid || cutoff.cutoffRawTime <= result.startRawTime || frames.length < 1) {
    return { result, cutoff, removedFrames: 0 };
  }
  const recomputed = applyTrajectoryKinematics(frames, result.settings, calibration);
  const trimWarning = cutoff.source === "top-completion"
    ? `Post-finish descent excluded from COM analysis. ${cutoff.reason}`
    : `Frames after the finish boundary at ${cutoff.cutoffRawTime.toFixed(3)}s were excluded from COM analysis.`;
  return {
    result: {
      ...result,
      endRawTime: cutoff.cutoffRawTime,
      frames: recomputed.frames,
      metrics: recomputed.metrics,
      warnings: uniqueStrings([...recomputed.warnings, trimWarning]),
    },
    cutoff,
    removedFrames,
  };
}

function buildProgressSamples(result: BiomechanicsResult, hardLimitRawTime: number): ProgressSample[] {
  return result.frames
    .flatMap((frame): ProgressSample[] => {
      const wall = frame.smoothedWallCom ?? frame.wallCom;
      if (!Number.isFinite(frame.rawTime) || frame.rawTime > hardLimitRawTime + 1e-9 ||
          frame.poseSelected === false || !finiteWallPoint(wall)) {
        return [];
      }
      return [{ frame, rawTime: frame.rawTime, wall }];
    })
    .sort((left, right) => left.rawTime - right.rawTime);
}

function evaluateTerminalDescent(
  samples: ProgressSample[],
  peakIndex: number,
  sampleFps: number,
  wallHeight: number,
): {
  accepted: boolean;
  dropMeters: number;
  durationSeconds: number;
  downwardProgressRatio: number;
  samples: number;
  maximumGapSeconds: number;
  maximumAllowedGapSeconds: number;
} {
  const descentSamples = samples.slice(peakIndex);
  const peak = descentSamples[0];
  const tail = descentSamples.slice(-Math.min(3, descentSamples.length));
  const tailHeight = median(tail.map((sample) => sample.wall.yMeters));
  const dropMeters = Math.max(0, peak.wall.yMeters - tailHeight);
  const durationSeconds = descentSamples.length > 1
    ? descentSamples[descentSamples.length - 1].rawTime - peak.rawTime
    : 0;
  let downwardDistance = 0;
  let upwardDistance = 0;
  let maximumGapSeconds = 0;
  for (let index = 1; index < descentSamples.length; index += 1) {
    const previous = descentSamples[index - 1];
    const current = descentSamples[index];
    maximumGapSeconds = Math.max(maximumGapSeconds, current.rawTime - previous.rawTime);
    const change = current.wall.yMeters - previous.wall.yMeters;
    if (change < 0) downwardDistance += -change;
    if (change > 0) upwardDistance += change;
  }
  const totalMovement = downwardDistance + upwardDistance;
  const downwardProgressRatio = totalMovement > 1e-9 ? downwardDistance / totalMovement : 0;
  const minimumDrop = Math.max(0.8, wallHeight * 0.06);
  const minimumDuration = Math.max(0.45, 3 / Math.max(1, sampleFps));
  const maximumAllowedGapSeconds = Math.max(0.34, 2.25 / Math.max(1, sampleFps));
  const lateSamples = descentSamples.slice(Math.max(1, Math.floor(descentSamples.length * 0.6)));
  const lateMaximum = lateSamples.length
    ? Math.max(...lateSamples.map((sample) => sample.wall.yMeters))
    : peak.wall.yMeters;
  const stayedBelowTop = lateMaximum <= peak.wall.yMeters - minimumDrop * 0.35;
  const accepted = descentSamples.length >= 4 &&
    dropMeters >= minimumDrop &&
    durationSeconds >= minimumDuration &&
    downwardProgressRatio >= 0.65 &&
    maximumGapSeconds <= maximumAllowedGapSeconds + 1e-9 &&
    stayedBelowTop;
  return {
    accepted,
    dropMeters,
    durationSeconds,
    downwardProgressRatio,
    samples: descentSamples.length,
    maximumGapSeconds,
    maximumAllowedGapSeconds,
  };
}

function firstPeakPlateauSample(
  samples: ProgressSample[],
  peakIndex: number,
  maximumGapSeconds: number,
  wallHeight: number,
): ProgressSample {
  const peakHeight = samples[peakIndex].wall.yMeters;
  const tolerance = Math.max(0.14, wallHeight * 0.012);
  let firstIndex = peakIndex;
  while (firstIndex > 0) {
    const previous = samples[firstIndex - 1];
    const current = samples[firstIndex];
    if (current.rawTime - previous.rawTime > maximumGapSeconds + 1e-9 ||
        previous.wall.yMeters < peakHeight - tolerance) {
      break;
    }
    firstIndex -= 1;
  }
  return samples[firstIndex];
}

function findHold20HandEvidence(
  result: BiomechanicsResult,
  calibration: WallCalibration | undefined,
  hardLimitRawTime: number,
  peakRawTime: number,
): Hand20Evidence | undefined {
  const validation = validateWallCalibration(calibration);
  if (!validation.valid || !validation.matrix) {
    return undefined;
  }
  const minimumVisibility = Math.max(0.2, result.settings.minVisibility * 0.7);
  let closest: Hand20Evidence | undefined;
  for (const frame of result.frames) {
    if (!Number.isFinite(frame.rawTime) || frame.rawTime > hardLimitRawTime + 1e-9 ||
        frame.rawTime < peakRawTime - 1.2 || frame.rawTime > peakRawTime + 0.6 ||
        frame.poseSelected === false) {
      continue;
    }
    for (const index of HAND_LANDMARK_INDICES) {
      const landmark = frame.landmarks.find((candidate) => candidate.index === index);
      const distance = handDistanceToHold20(landmark, validation.matrix, minimumVisibility);
      if (distance !== undefined && (!closest || distance < closest.distanceMeters ||
          (Math.abs(distance - closest.distanceMeters) < 1e-9 && frame.rawTime < closest.rawTime))) {
        closest = { rawTime: frame.rawTime, distanceMeters: distance };
      }
    }
  }
  return closest;
}

function handDistanceToHold20(
  landmark: PoseLandmarkPoint | undefined,
  matrix: NonNullable<ReturnType<typeof validateWallCalibration>["matrix"]>,
  minimumVisibility: number,
): number | undefined {
  if (!landmark || landmark.visibility < minimumVisibility ||
      !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) {
    return undefined;
  }
  try {
    const wall = projectImagePointToWall(landmark, matrix);
    const distance = Math.hypot(wall.xMeters - HOLD_20.xMeters, wall.yMeters - HOLD_20.yMeters);
    return Number.isFinite(distance) ? distance : undefined;
  } catch {
    return undefined;
  }
}

function topCompletionConfidence(
  result: BiomechanicsResult,
  calibration: WallCalibration | undefined,
  handSupported: boolean,
): Confidence {
  if (result.metrics.quality === "Needs review" || calibration?.confidence === "Low") {
    return "Low";
  }
  if (handSupported && calibration?.source !== "automatic-approximate" && result.metrics.quality === "High") {
    return "High";
  }
  return "Medium";
}

function baseCutoff(
  cutoffRawTime: number,
  acceptedFinishRawTime: number | undefined,
  source: BiomechanicsFinishSource,
  reason: string,
  evidence: BiomechanicsFinishEvidence,
): BiomechanicsFinishCutoff {
  return {
    cutoffRawTime,
    hardLimitRawTime: cutoffRawTime,
    acceptedFinishRawTime,
    source,
    confidence: source === "accepted-finish" ? "High" : "Low",
    reason,
    evidence,
  };
}

function indexOfHighestSample(samples: ProgressSample[]): number {
  let highestIndex = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].wall.yMeters > samples[highestIndex].wall.yMeters) {
      highestIndex = index;
    }
  }
  return highestIndex;
}

function maximumFiniteFrameTime(frames: BiomechanicsFrame[]): number | undefined {
  const values = frames.map((frame) => frame.rawTime).filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function validWallHeight(calibration?: WallCalibration): number | undefined {
  return calibration && Number.isFinite(calibration.heightMeters) && calibration.heightMeters > 0
    ? calibration.heightMeters
    : undefined;
}

function finiteWallPoint(point?: WallPoint): point is WallPoint {
  return Boolean(point && Number.isFinite(point.xMeters) && Number.isFinite(point.yMeters));
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
