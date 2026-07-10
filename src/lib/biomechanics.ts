import type {
  BiomechanicsFrame,
  BiomechanicsMetrics,
  BiomechanicsSettings,
  NormalizedPoint,
  PoseLandmarkPoint,
  WallCalibration,
  WallPoint,
} from "../types";
import type { HomographyMatrix } from "./wallCalibration";
import { projectImagePointToWall } from "./wallCalibration";

interface SpacePoint {
  x: number;
  y: number;
}

interface ResolvedJoint {
  point: SpacePoint;
  visibility: number;
}

interface SegmentDefinition {
  id: string;
  proximal: string;
  distal: string;
  mass: number;
  ratio: number;
  required?: boolean;
}

export interface ComEstimate<TPoint> {
  point?: TPoint;
  massCoverage: number;
  meanVisibility: number;
  usedSegments: string[];
  missingSegments: string[];
}

export const DEFAULT_BIOMECHANICS_SETTINGS: BiomechanicsSettings = {
  sampleFps: 10,
  minVisibility: 0.45,
  minMassCoverage: 0.85,
  smoothingWindowSeconds: 0.2,
  anthropometricModel: "athletevision-published-male-reference",
};

// Published by Pandurevic et al. (2022). Masses total 1.0 exactly.
export const BODY_SEGMENTS: SegmentDefinition[] = [
  { id: "head", proximal: "head", distal: "neck", mass: 0.0694, ratio: 0.5002 },
  { id: "trunk", proximal: "neck", distal: "midHip", mass: 0.4346, ratio: 0.4486, required: true },
  { id: "leftUpperArm", proximal: "leftShoulder", distal: "leftElbow", mass: 0.0271, ratio: 0.5772 },
  { id: "rightUpperArm", proximal: "rightShoulder", distal: "rightElbow", mass: 0.0271, ratio: 0.5772 },
  { id: "leftForearm", proximal: "leftElbow", distal: "leftWrist", mass: 0.0223, ratio: 0.6751 },
  { id: "rightForearm", proximal: "rightElbow", distal: "rightWrist", mass: 0.0223, ratio: 0.6751 },
  { id: "leftThigh", proximal: "leftHip", distal: "leftKnee", mass: 0.1416, ratio: 0.4095, required: true },
  { id: "rightThigh", proximal: "rightHip", distal: "rightKnee", mass: 0.1416, ratio: 0.4095, required: true },
  { id: "leftShank", proximal: "leftKnee", distal: "leftAnkle", mass: 0.0433, ratio: 0.4459 },
  { id: "rightShank", proximal: "rightKnee", distal: "rightAnkle", mass: 0.0433, ratio: 0.4459 },
  { id: "leftFoot", proximal: "leftHeel", distal: "leftToe", mass: 0.0137, ratio: 0.4415 },
  { id: "rightFoot", proximal: "rightHeel", distal: "rightToe", mass: 0.0137, ratio: 0.4415 },
];

const DERIVED_FRAME_WARNINGS = [
  "COM lies outside the calibrated wall quadrilateral.",
  "Implausible wall-plane speed; review pose and calibration.",
] as const;

const LANDMARK_INDEX: Record<string, number> = {
  head: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftToe: 31,
  rightToe: 32,
};

export function computeImageCom(
  landmarks: PoseLandmarkPoint[],
  settings: BiomechanicsSettings = DEFAULT_BIOMECHANICS_SETTINGS,
): ComEstimate<NormalizedPoint> {
  const estimate = computeComInSpace(landmarks, settings, (point) => ({ x: point.x, y: point.y }));
  return {
    ...estimate,
    point: estimate.point ? { x: estimate.point.x, y: estimate.point.y } : undefined,
  };
}

export function computeWallCom(
  landmarks: PoseLandmarkPoint[],
  matrix: HomographyMatrix,
  settings: BiomechanicsSettings = DEFAULT_BIOMECHANICS_SETTINGS,
): ComEstimate<WallPoint> {
  const estimate = computeComInSpace(landmarks, settings, (point) => {
    const projected = projectImagePointToWall(point, matrix);
    return { x: projected.xMeters, y: projected.yMeters };
  });
  return {
    ...estimate,
    point: estimate.point
      ? { xMeters: estimate.point.x, yMeters: estimate.point.y }
      : undefined,
  };
}

export function applyTrajectoryKinematics(
  inputFrames: BiomechanicsFrame[],
  settings: BiomechanicsSettings,
  calibration: WallCalibration,
): { frames: BiomechanicsFrame[]; metrics: BiomechanicsMetrics; warnings: string[] } {
  const deduplicated = new Map<number, BiomechanicsFrame>();
  for (const frame of [...inputFrames].sort((left, right) => left.rawTime - right.rawTime)) {
    if (!Number.isFinite(frame.rawTime)) {
      continue;
    }
    const key = Math.round(frame.rawTime * 1000) / 1000;
    const existing = deduplicated.get(key);
    if (!existing || frame.massCoverage > existing.massCoverage) {
      deduplicated.set(key, resetDerivedKinematics(frame, key));
    }
  }
  const frames = Array.from(deduplicated.values()).sort((left, right) => left.rawTime - right.rawTime);

  for (const frame of frames) {
    frame.extrapolated = Boolean(frame.wallCom && (
      frame.wallCom.xMeters < -1e-6 || frame.wallCom.xMeters > calibration.widthMeters + 1e-6 ||
      frame.wallCom.yMeters < -1e-6 || frame.wallCom.yMeters > calibration.heightMeters + 1e-6
    ));
    if (frame.extrapolated) {
      frame.warning = appendWarning(frame.warning, "COM lies outside the calibrated wall quadrilateral.");
    }
  }

  const chunks = buildContinuousChunks(frames);
  for (const chunk of chunks) {
    for (const frame of chunk) {
      const fittedX = localLinearFit(chunk, frame.rawTime, settings.smoothingWindowSeconds, (sample) => sample.wallCom?.xMeters);
      const fittedY = localLinearFit(chunk, frame.rawTime, settings.smoothingWindowSeconds, (sample) => sample.wallCom?.yMeters);
      if (fittedX && fittedY) {
        frame.smoothedWallCom = { xMeters: fittedX.position, yMeters: fittedY.position };
        if (fittedX.velocity !== undefined && fittedY.velocity !== undefined) {
          frame.velocityXMps = fittedX.velocity;
          frame.velocityYMps = fittedY.velocity;
          frame.verticalSpeedMps = fittedY.velocity;
          frame.speedMps = Math.hypot(fittedX.velocity, fittedY.velocity);
          if (frame.speedMps > 10) {
            frame.warning = appendWarning(frame.warning, "Implausible wall-plane speed; review pose and calibration.");
          }
        }
      }
    }
  }

  const requestedFrames = frames.length;
  const detectedFrames = frames.filter((frame) => frame.poseDetected || frame.landmarks.length > 0).length;
  const validFrames = frames.filter((frame) => frame.valid && frame.wallCom).length;
  const trackingCoverage = requestedFrames ? detectedFrames / requestedFrames : 0;
  const validCoverage = requestedFrames ? validFrames / requestedFrames : 0;
  const meanMassCoverage = validFrames
    ? frames.filter((frame) => frame.valid).reduce((sum, frame) => sum + frame.massCoverage, 0) / validFrames
    : 0;

  let pathLengthMeters = 0;
  let activeDuration = 0;
  let observedChordMeters = 0;
  let observedVerticalGainMeters = 0;
  for (const chunk of chunks) {
    const smoothed = chunk.filter((frame) => frame.smoothedWallCom);
    if (smoothed.length >= 2) {
      activeDuration += smoothed[smoothed.length - 1].rawTime - smoothed[0].rawTime;
      observedChordMeters += wallDistance(smoothed[0].smoothedWallCom!, smoothed[smoothed.length - 1].smoothedWallCom!);
      observedVerticalGainMeters += smoothed[smoothed.length - 1].smoothedWallCom!.yMeters - smoothed[0].smoothedWallCom!.yMeters;
      for (let index = 1; index < smoothed.length; index += 1) {
        pathLengthMeters += wallDistance(smoothed[index - 1].smoothedWallCom!, smoothed[index].smoothedWallCom!);
      }
    }
  }

  const hasMeaningfulPath = pathLengthMeters > 1e-9;
  const verticalGainMeters = activeDuration > 0 ? observedVerticalGainMeters : undefined;
  const pathEfficiency = hasMeaningfulPath
    ? Math.min(1, observedChordMeters / pathLengthMeters)
    : undefined;
  const averageSpeedMps = activeDuration > 0 && hasMeaningfulPath ? pathLengthMeters / activeDuration : undefined;
  const speedValues = frames
    .map((frame) => frame.speedMps)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const peakSpeedMps = settings.sampleFps >= 8 && speedValues.length >= 3
    ? Math.max(...speedValues)
    : undefined;

  const warnings = [
    "Experimental wall-projected 2D COM estimate; it is not a 3D or clinical measurement.",
    "Anthropometric weights use the published adult male reference model and may not match every athlete.",
    "Metric output is valid only for a fixed camera with no pan, tilt, shake, or zoom.",
  ];
  if (trackingCoverage < 0.8) {
    warnings.push("Pose tracking coverage is below 80%; review the detected path.");
  }
  if (validCoverage < 0.7) {
    warnings.push("Too many frames lacked the body segments required for a stable COM estimate.");
  }
  if (frames.some((frame) => frame.extrapolated)) {
    warnings.push("Some COM estimates fall outside the calibrated wall quadrilateral and are extrapolated.");
  }
  if (chunks.length > 1) {
    warnings.push("Tracking contains gaps; path, gain, and efficiency use continuous observed spans only.");
  }
  if (peakSpeedMps === undefined) {
    warnings.push("Peak speed is hidden because the sample rate or usable sample count is too low.");
  }

  const quality = trackingCoverage >= 0.9 && validCoverage >= 0.85 && meanMassCoverage >= 0.92 &&
      !frames.some((frame) => frame.extrapolated || (frame.speedMps ?? 0) > 10)
    ? "High"
    : trackingCoverage >= 0.7 && validCoverage >= 0.6 && meanMassCoverage >= settings.minMassCoverage
      ? "Medium"
      : "Needs review";

  return {
    frames,
    metrics: {
      requestedFrames,
      detectedFrames,
      validFrames,
      trackingCoverage,
      validCoverage,
      meanMassCoverage,
      averageSpeedMps,
      peakSpeedMps,
      verticalGainMeters,
      pathLengthMeters: hasMeaningfulPath ? pathLengthMeters : undefined,
      pathEfficiency,
      quality,
    },
    warnings,
  };
}

function computeComInSpace(
  landmarks: PoseLandmarkPoint[],
  settings: BiomechanicsSettings,
  transform: (point: NormalizedPoint) => SpacePoint,
): ComEstimate<SpacePoint> {
  const byIndex = new Map(landmarks.map((landmark) => [landmark.index, landmark]));
  const joints = new Map<string, ResolvedJoint>();
  for (const [name, index] of Object.entries(LANDMARK_INDEX)) {
    const landmark = byIndex.get(index);
    if (!landmark || !isFiniteLandmark(landmark)) {
      continue;
    }
    try {
      const point = transform(landmark);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        joints.set(name, { point, visibility: landmark.visibility });
      }
    } catch {
      // A point outside a numerically stable projection is treated as unavailable.
    }
  }

  addMidpointJoint(joints, "neck", "leftShoulder", "rightShoulder");
  addMidpointJoint(joints, "midHip", "leftHip", "rightHip");

  let weightedX = 0;
  let weightedY = 0;
  let availableMass = 0;
  let visibilityMass = 0;
  const usedSegments: string[] = [];
  const missingSegments: string[] = [];
  const missingRequired = new Set<string>();

  for (const segment of BODY_SEGMENTS) {
    const proximal = joints.get(segment.proximal);
    const distal = joints.get(segment.distal);
    const visibility = proximal && distal ? Math.min(proximal.visibility, distal.visibility) : 0;
    if (!proximal || !distal || visibility < settings.minVisibility) {
      missingSegments.push(segment.id);
      if (segment.required) {
        missingRequired.add(segment.id);
      }
      continue;
    }
    const segmentX = proximal.point.x + (distal.point.x - proximal.point.x) * segment.ratio;
    const segmentY = proximal.point.y + (distal.point.y - proximal.point.y) * segment.ratio;
    weightedX += segment.mass * segmentX;
    weightedY += segment.mass * segmentY;
    availableMass += segment.mass;
    visibilityMass += segment.mass * visibility;
    usedSegments.push(segment.id);
  }

  const valid = availableMass >= settings.minMassCoverage && missingRequired.size === 0;
  return {
    point: valid ? { x: weightedX / availableMass, y: weightedY / availableMass } : undefined,
    massCoverage: availableMass,
    meanVisibility: availableMass > 0 ? visibilityMass / availableMass : 0,
    usedSegments,
    missingSegments,
  };
}

function addMidpointJoint(joints: Map<string, ResolvedJoint>, name: string, leftName: string, rightName: string): void {
  const left = joints.get(leftName);
  const right = joints.get(rightName);
  if (!left || !right) {
    return;
  }
  joints.set(name, {
    point: {
      x: (left.point.x + right.point.x) / 2,
      y: (left.point.y + right.point.y) / 2,
    },
    visibility: Math.min(left.visibility, right.visibility),
  });
}

function buildContinuousChunks(frames: BiomechanicsFrame[]): BiomechanicsFrame[][] {
  const valid = frames.filter((frame) => frame.valid && frame.wallCom);
  const chunks: BiomechanicsFrame[][] = [];
  for (const frame of valid) {
    const current = chunks[chunks.length - 1];
    if (!current || frame.rawTime - current[current.length - 1].rawTime > 0.25) {
      chunks.push([frame]);
    } else {
      current.push(frame);
    }
  }
  return chunks;
}

function localLinearFit(
  frames: BiomechanicsFrame[],
  targetTime: number,
  windowSeconds: number,
  valueFor: (frame: BiomechanicsFrame) => number | undefined,
): { position: number; velocity?: number } | undefined {
  const window = Math.max(0.05, windowSeconds);
  const neighbors = frames.filter((frame) => Math.abs(frame.rawTime - targetTime) <= window + 1e-9);
  if (!neighbors.length) {
    return undefined;
  }

  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let t0 = 0;
  let t1 = 0;
  for (const frame of neighbors) {
    const value = valueFor(frame);
    if (value === undefined || !Number.isFinite(value)) {
      continue;
    }
    const tau = frame.rawTime - targetTime;
    const sigma = Math.max(window / 2, 0.025);
    const weight = Math.exp(-0.5 * (tau / sigma) ** 2);
    s0 += weight;
    s1 += weight * tau;
    s2 += weight * tau * tau;
    t0 += weight * value;
    t1 += weight * tau * value;
  }
  if (s0 <= 0) {
    return undefined;
  }
  const denominator = s0 * s2 - s1 * s1;
  if (Math.abs(denominator) < 1e-12) {
    return { position: t0 / s0 };
  }
  return {
    position: (s2 * t0 - s1 * t1) / denominator,
    velocity: (s0 * t1 - s1 * t0) / denominator,
  };
}

function isFiniteLandmark(landmark: PoseLandmarkPoint): boolean {
  return Number.isFinite(landmark.x) && Number.isFinite(landmark.y) &&
    Number.isFinite(landmark.visibility) && landmark.x >= -0.25 && landmark.x <= 1.25 &&
    landmark.y >= -0.25 && landmark.y <= 1.25;
}

function appendWarning(existing: string | undefined, next: string): string {
  return existing ? `${existing} ${next}` : next;
}

function resetDerivedKinematics(frame: BiomechanicsFrame, rawTime: number): BiomechanicsFrame {
  const reset = { ...frame, rawTime };
  delete reset.smoothedWallCom;
  delete reset.velocityXMps;
  delete reset.velocityYMps;
  delete reset.speedMps;
  delete reset.verticalSpeedMps;
  delete reset.extrapolated;

  let warning = reset.warning ?? "";
  for (const derivedWarning of DERIVED_FRAME_WARNINGS) {
    warning = warning.replaceAll(derivedWarning, " ");
  }
  const normalizedWarning = warning.replace(/\s+/g, " ").trim();
  if (normalizedWarning) {
    reset.warning = normalizedWarning;
  } else {
    delete reset.warning;
  }
  return reset;
}

function wallDistance(left: WallPoint, right: WallPoint): number {
  return Math.hypot(left.xMeters - right.xMeters, left.yMeters - right.yMeters);
}
