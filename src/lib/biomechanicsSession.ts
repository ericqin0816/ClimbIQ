import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  BiomechanicsSession,
  NormalizedZone,
  WallCalibration,
} from "../types";
import { applyTrajectoryKinematics, DEFAULT_BIOMECHANICS_SETTINGS } from "./biomechanics";
import { validateWallCalibration } from "./wallCalibration";
import { sanitizeSourceSampleTiming } from "./sourceSampleTiming";

const HAND_LANDMARK_INDICES = new Set([15, 16, 17, 18, 19, 20, 21, 22]);

export function createDefaultBiomechanicsSession(): BiomechanicsSession {
  return {
    version: 1,
    settings: { ...DEFAULT_BIOMECHANICS_SETTINGS },
  };
}

/**
 * Keeps COM/chart data plus wrists and distal hand landmarks needed to
 * reproduce Hold 10 contact timing after a local session is reloaded. The
 * rest of the full pose skeleton remains omitted to keep storage bounded.
 */
export function compactBiomechanicsSession(session: BiomechanicsSession): BiomechanicsSession {
  const sanitized = sanitizeBiomechanicsSession(session);
  if (!sanitized.result) {
    return sanitized;
  }
  return {
    ...sanitized,
    result: {
      ...sanitized.result,
      frames: sanitized.result.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter((landmark) => HAND_LANDMARK_INDICES.has(landmark.index)),
      })),
    },
  };
}

export function sanitizeBiomechanicsSession(value: unknown): BiomechanicsSession {
  const fallback = createDefaultBiomechanicsSession();
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const candidate = value as any;
  const settings = {
    sampleFps: [5, 10, 15].includes(Number(candidate.settings?.sampleFps))
      ? Number(candidate.settings.sampleFps)
      : fallback.settings.sampleFps,
    minVisibility: boundedNumber(candidate.settings?.minVisibility, 0.2, 0.9, fallback.settings.minVisibility),
    minMassCoverage: boundedNumber(candidate.settings?.minMassCoverage, 0.7, 1, fallback.settings.minMassCoverage),
    smoothingWindowSeconds: boundedNumber(
      candidate.settings?.smoothingWindowSeconds,
      0.1,
      0.35,
      fallback.settings.smoothingWindowSeconds,
    ),
    anthropometricModel: "athletevision-published-male-reference" as const,
  };

  const calibrationCandidate = candidate.calibration as WallCalibration | undefined;
  const calibration = validateWallCalibration(calibrationCandidate).valid ? calibrationCandidate : undefined;
  const resultCandidate = candidate.result;
  if (!calibration || !resultCandidate || typeof resultCandidate !== "object") {
    return { version: 1, settings, calibration };
  }

  const startRawTime = finiteNumber(resultCandidate.startRawTime);
  const endRawTime = finiteNumber(resultCandidate.endRawTime);
  if (startRawTime === undefined || endRawTime === undefined || startRawTime < 0 || endRawTime <= startRawTime) {
    return { version: 1, settings, calibration };
  }

  const frames = Array.isArray(resultCandidate.frames)
    ? (resultCandidate.frames as unknown[])
        .slice(0, 5000)
        .map((frame) => sanitizeBiomechanicsFrame(frame, settings.minMassCoverage))
        .filter((frame): frame is BiomechanicsFrame => Boolean(frame))
        .filter((frame) => frame.rawTime >= startRawTime - 0.001 && frame.rawTime <= endRawTime + 0.001)
        .map((frame) => ({
          ...frame,
          climbTime: Math.round((frame.rawTime - startRawTime) * 1000) / 1000,
        }))
        .slice(0, 450)
    : [];
  if (!frames.length) {
    return { version: 1, settings, calibration };
  }
  const recomputed = applyTrajectoryKinematics(frames, settings, calibration);
  const result: BiomechanicsResult = {
    version: 1,
    createdAt: typeof resultCandidate.createdAt === "string" ? resultCandidate.createdAt : new Date().toISOString(),
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime,
    endRawTime,
    identityZone: sanitizeBiomechanicsIdentityZone(resultCandidate.identityZone),
    settings,
    frames: recomputed.frames,
    metrics: recomputed.metrics,
    warnings: recomputed.warnings,
  };
  return { version: 1, settings, calibration, result };
}

function sanitizeBiomechanicsFrame(value: unknown, minMassCoverage: number): BiomechanicsFrame | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as any;
  const rawTime = finiteNumber(candidate.rawTime);
  const climbTime = finiteNumber(candidate.climbTime);
  if (rawTime === undefined || climbTime === undefined || rawTime < 0) {
    return null;
  }
  const landmarks = Array.isArray(candidate.landmarks)
    ? candidate.landmarks.slice(0, 33).flatMap((landmark: any) => {
        const index = finiteNumber(landmark?.index);
        const x = finiteNumber(landmark?.x);
        const y = finiteNumber(landmark?.y);
        const z = finiteNumber(landmark?.z);
        const visibility = finiteNumber(landmark?.visibility);
        if (index === undefined || !Number.isInteger(index) || index < 0 || index > 32 || x === undefined || y === undefined || z === undefined ||
          visibility === undefined || x < -0.25 || x > 1.25 || y < -0.25 || y > 1.25 || visibility < 0 || visibility > 1) {
          return [];
        }
        return [{ index, x, y, z, visibility }];
      })
    : [];
  const imageCom = sanitizeNormalizedPoint(candidate.imageCom);
  const wallCom = sanitizeWallPoint(candidate.wallCom);
  const massCoverage = boundedNumber(candidate.massCoverage, 0, 1, 0);
  const meanVisibility = boundedNumber(candidate.meanVisibility, 0, 1, 0);
  const valid = Boolean(candidate.valid === true && imageCom && wallCom && massCoverage >= minMassCoverage);
  const poseSelected = typeof candidate.poseSelected === "boolean"
    ? candidate.poseSelected
    : landmarks.length > 0 || valid;
  const poseDetected = typeof candidate.poseDetected === "boolean"
    ? candidate.poseDetected
    : poseSelected;
  const poseCandidateCount = Number.isInteger(candidate.poseCandidateCount)
    ? Math.max(0, Math.min(2, Number(candidate.poseCandidateCount)))
    : poseDetected ? 1 : 0;
  return {
    rawTime,
    climbTime,
    ...sanitizeSourceSampleTiming(rawTime, candidate),
    poseDetected,
    poseSelected,
    poseCandidateCount,
    landmarks,
    imageCom,
    wallCom,
    massCoverage,
    meanVisibility,
    valid,
    warning: typeof candidate.warning === "string" ? candidate.warning.slice(0, 500) : undefined,
  };
}

function sanitizeNormalizedPoint(value: any) {
  const x = finiteNumber(value?.x);
  const y = finiteNumber(value?.y);
  return x !== undefined && y !== undefined && x >= -0.25 && x <= 1.25 && y >= -0.25 && y <= 1.25
    ? { x, y }
    : undefined;
}

function sanitizeWallPoint(value: any) {
  const xMeters = finiteNumber(value?.xMeters);
  const yMeters = finiteNumber(value?.yMeters);
  return xMeters !== undefined && yMeters !== undefined && xMeters >= -10 && xMeters <= 10 && yMeters >= -10 && yMeters <= 30
    ? { xMeters, yMeters }
    : undefined;
}

function sanitizeBiomechanicsIdentityZone(value: any): NormalizedZone | undefined {
  if (!value || value.id !== "startBody") {
    return undefined;
  }
  const x1 = finiteNumber(value.x1);
  const y1 = finiteNumber(value.y1);
  const x2 = finiteNumber(value.x2);
  const y2 = finiteNumber(value.y2);
  if ([x1, y1, x2, y2].some((coordinate) => coordinate === undefined || coordinate < 0 || coordinate > 1)) {
    return undefined;
  }
  return { id: "startBody", label: "Start Body Zone", x1: x1!, y1: y1!, x2: x2!, y2: y2! };
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = finiteNumber(value);
  return number === undefined || number < min || number > max ? fallback : number;
}
