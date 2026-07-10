import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  BiomechanicsSettings,
  NormalizedPoint,
  NormalizedZone,
  PoseLandmarkPoint,
  WallCalibration,
} from "../types";
import { applyTrajectoryKinematics, computeImageCom, computeWallCom } from "./biomechanics";
import { sampleFramesInRange, seekTo } from "./videoFrameSampler";
import { validateWallCalibration } from "./wallCalibration";

const MEDIAPIPE_WASM_RELATIVE_PATH = "mediapipe/wasm";
const MODEL_RELATIVE_PATH = "models/pose_landmarker_lite.task";
const MODEL_EXPECTED_BYTES = 5_777_746;
const MODEL_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";

export interface PoseAnalysisProgress {
  phase: "loading" | "analyzing" | "finalizing";
  processed: number;
  total: number;
}

export interface AnalyzePoseVideoOptions {
  video: HTMLVideoElement;
  startRawTime: number;
  endRawTime: number;
  settings: BiomechanicsSettings;
  calibration: WallCalibration;
  identityZone?: NormalizedZone;
  onProgress?: (progress: PoseAnalysisProgress) => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

export class PoseAnalysisCancelledError extends Error {
  constructor() {
    super("Pose analysis cancelled.");
    this.name = "PoseAnalysisCancelledError";
  }
}

export async function analyzePoseVideo({
  video,
  startRawTime,
  endRawTime,
  settings,
  calibration,
  identityZone,
  onProgress,
  isCancelled,
  signal,
}: AnalyzePoseVideoOptions): Promise<BiomechanicsResult> {
  validateAnalysisInput(video, startRawTime, endRawTime, settings);
  const calibrationValidation = validateWallCalibration(calibration);
  if (!calibrationValidation.valid || !calibrationValidation.matrix) {
    throw new Error(calibrationValidation.error ?? "Wall calibration is invalid.");
  }

  const times = buildPoseSampleTimes(startRawTime, endRawTime, settings.sampleFps);
  if (times.length < 3) {
    throw new Error("Biomechanics analysis needs at least three sampled frames.");
  }
  if (times.length > 450) {
    throw new Error("Analysis range is too long. Reduce the range or sample rate to 450 frames or fewer.");
  }

  onProgress?.({ phase: "loading", processed: 0, total: times.length });
  checkCancelled(isCancelled, signal);

  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  checkCancelled(isCancelled, signal);
  const modelAssetBuffer = await loadVerifiedModel(signal);
  checkCancelled(isCancelled, signal);
  const vision = await FilesetResolver.forVisionTasks(assetUrl(MEDIAPIPE_WASM_RELATIVE_PATH));
  checkCancelled(isCancelled, signal);
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetBuffer,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numPoses: 2,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
    outputSegmentationMasks: false,
  });

  const frames: BiomechanicsFrame[] = [];
  const runWarnings = new Set<string>();
  let previousCenter: NormalizedPoint | undefined;
  let previousCenterTime: number | undefined;

  try {
    for (let index = 0; index < times.length; index += 1) {
      checkCancelled(isCancelled, signal);
      const requestedTime = times[index];
      await seekTo(video, requestedTime);
      checkCancelled(isCancelled, signal);
      const actualTime = video.currentTime;
      const detection = landmarker.detectForVideo(video, Math.round(requestedTime * 1000));
      const selection = selectTrackedPose(
        detection.landmarks,
        identityZone,
        previousCenter,
        previousCenterTime === undefined ? 0 : Math.max(0, actualTime - previousCenterTime),
      );
      if (selection.warning) {
        runWarnings.add(selection.warning);
      }

      const landmarks = selection.selected ? toStoredLandmarks(selection.selected.landmarks) : [];
      if (selection.selected) {
        previousCenter = selection.selected.center;
        previousCenterTime = actualTime;
      }
      const imageEstimate = computeImageCom(landmarks, settings);
      const wallEstimate = computeWallCom(landmarks, calibrationValidation.matrix, settings);
      const valid = Boolean(imageEstimate.point && wallEstimate.point);
      frames.push({
        rawTime: roundMetric(actualTime),
        climbTime: roundMetric(actualTime - startRawTime),
        poseDetected: landmarks.length > 0,
        landmarks,
        imageCom: imageEstimate.point,
        wallCom: wallEstimate.point,
        massCoverage: roundMetric(Math.min(imageEstimate.massCoverage, wallEstimate.massCoverage)),
        meanVisibility: roundMetric(Math.min(imageEstimate.meanVisibility, wallEstimate.meanVisibility)),
        valid,
        warning: !landmarks.length
          ? selection.warning ?? "No pose detected."
          : !valid
            ? `Insufficient visible body mass (${Math.round(Math.min(imageEstimate.massCoverage, wallEstimate.massCoverage) * 100)}%).`
            : undefined,
      });

      onProgress?.({ phase: "analyzing", processed: index + 1, total: times.length });
      await yieldToBrowser();
    }
  } finally {
    landmarker.close();
  }

  checkCancelled(isCancelled, signal);
  onProgress?.({ phase: "finalizing", processed: times.length, total: times.length });
  const kinematics = applyTrajectoryKinematics(frames, settings, calibration);
  for (const warning of kinematics.warnings) {
    runWarnings.add(warning);
  }
  if (kinematics.metrics.validFrames < 3) {
    runWarnings.add("Fewer than three valid COM frames were found; velocity metrics are not reliable.");
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Lite",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime,
    endRawTime,
    identityZone: identityZone ? { ...identityZone } : undefined,
    settings: { ...settings },
    frames: kinematics.frames,
    metrics: kinematics.metrics,
    warnings: Array.from(runWarnings),
  };
}

function validateAnalysisInput(
  video: HTMLVideoElement,
  startRawTime: number,
  endRawTime: number,
  settings: BiomechanicsSettings,
): void {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error("Load a video and wait for its metadata before running biomechanics.");
  }
  if (!Number.isFinite(startRawTime) || !Number.isFinite(endRawTime) || startRawTime < 0 || endRawTime <= startRawTime) {
    throw new Error("Biomechanics end time must be after its start time.");
  }
  if (endRawTime > video.duration + 0.001) {
    throw new Error("Biomechanics range extends beyond the video duration.");
  }
  if (![5, 10, 15].includes(settings.sampleFps)) {
    throw new Error("Choose a supported biomechanics sample rate: 5, 10, or 15 fps.");
  }
  if (settings.minMassCoverage < 0.8 || settings.minMassCoverage > 1) {
    throw new Error("Minimum visible body mass must stay between 80% and 100%.");
  }
}

export interface PoseSelectionResult {
  selected?: { landmarks: NormalizedLandmark[]; center: NormalizedPoint };
  warning?: string;
}

export function selectTrackedPose(
  candidates: NormalizedLandmark[][],
  identityZone?: NormalizedZone,
  previousCenter?: NormalizedPoint,
  elapsedSincePrevious = 0,
): PoseSelectionResult {
  const scored = candidates
    .map((landmarks) => ({ landmarks, center: poseAnchor(landmarks) }))
    .filter((candidate): candidate is { landmarks: NormalizedLandmark[]; center: NormalizedPoint } => Boolean(candidate.center))
    .map((candidate) => ({
      ...candidate,
      score: previousCenter ? pointDistance(candidate.center, previousCenter) : 0,
    }))
    .sort((left, right) => left.score - right.score);
  if (!scored.length) {
    return { warning: "No pose with a usable hip or shoulder anchor was detected." };
  }

  if (previousCenter) {
    const maxDistance = clampNumber(0.12 + elapsedSincePrevious * 0.45, 0.12, 0.4);
    const plausible = scored.filter((candidate) => candidate.score <= maxDistance);
    if (!plausible.length) {
      return { warning: "Pose was rejected because no detection plausibly matched the tracked climber." };
    }
    if (plausible.length > 1 && plausible[1].score - plausible[0].score < Math.max(0.025, plausible[0].score * 0.35)) {
      return { warning: "Pose was rejected because two people were equally plausible identity matches." };
    }
    return { selected: plausible[0] };
  }

  if (!identityZone) {
    return scored.length === 1
      ? { selected: scored[0] }
      : { warning: "Multiple people were detected without a Start Body Zone, so no athlete was selected." };
  }

  const zoneCenter = {
    x: (identityZone.x1 + identityZone.x2) / 2,
    y: (identityZone.y1 + identityZone.y2) / 2,
  };
  const inZone = scored.filter((candidate) => insideZone(candidate.center, identityZone));
  if (inZone.length === 1) {
    return { selected: inZone[0] };
  }
  if (inZone.length > 1) {
    return { warning: "More than one person anchor was inside the Start Body Zone, so identity was ambiguous." };
  }
  const byZoneDistance = scored
    .map((candidate) => ({ ...candidate, zoneDistance: pointDistance(candidate.center, zoneCenter) }))
    .sort((left, right) => left.zoneDistance - right.zoneDistance);
  const zoneDiagonal = Math.hypot(identityZone.x2 - identityZone.x1, identityZone.y2 - identityZone.y1);
  if (byZoneDistance[0].zoneDistance <= Math.max(0.1, zoneDiagonal * 0.75)) {
    return { selected: byZoneDistance[0], warning: "Initial pose was near, but not inside, the Start Body Zone." };
  }
  return { warning: "No detected person matched the Start Body Zone." };
}

function poseAnchor(landmarks: NormalizedLandmark[]): NormalizedPoint | undefined {
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (usableAnchor(leftHip) && usableAnchor(rightHip)) {
    return { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 };
  }
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  if (usableAnchor(leftShoulder) && usableAnchor(rightShoulder)) {
    return { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
  }
  return undefined;
}

function usableAnchor(landmark?: NormalizedLandmark): landmark is NormalizedLandmark {
  return Boolean(landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y) && landmark.visibility >= 0.2);
}

function toStoredLandmarks(landmarks: NormalizedLandmark[]): PoseLandmarkPoint[] {
  return landmarks.flatMap((landmark, index) => {
    if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) || !Number.isFinite(landmark.visibility)) {
      return [];
    }
    return [{
      index,
      x: roundMetric(landmark.x),
      y: roundMetric(landmark.y),
      z: roundMetric(Number.isFinite(landmark.z) ? landmark.z : 0),
      visibility: roundMetric(landmark.visibility),
    }];
  });
}

function insideZone(point: NormalizedPoint, zone: NormalizedZone): boolean {
  const left = Math.min(zone.x1, zone.x2);
  const right = Math.max(zone.x1, zone.x2);
  const top = Math.min(zone.y1, zone.y2);
  const bottom = Math.max(zone.y1, zone.y2);
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function pointDistance(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function buildPoseSampleTimes(start: number, end: number, fps: number): number[] {
  return sampleFramesInRange(start, end, fps).filter((time) => time <= end + 1e-7);
}

async function loadVerifiedModel(signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(assetUrl(MODEL_RELATIVE_PATH), { signal });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || contentType.includes("text/html")) {
    throw new Error("The local pose model is missing or was served as an HTML fallback. Redeploy the complete production build.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== MODEL_EXPECTED_BYTES) {
    throw new Error(`Pose model size check failed (${buffer.byteLength} bytes).`);
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== MODEL_SHA256) {
    throw new Error("Pose model integrity check failed.");
  }
  return new Uint8Array(buffer);
}

function assetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return new URL(`${base}${relativePath.replace(/^\//, "")}`, window.location.origin).toString();
}

function checkCancelled(isCancelled?: () => boolean, signal?: AbortSignal): void {
  if (isCancelled?.() || signal?.aborted) {
    throw new PoseAnalysisCancelledError();
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
}
