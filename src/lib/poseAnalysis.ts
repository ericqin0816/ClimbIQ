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
const MODEL_RELATIVE_PATH = "models/pose_landmarker_full.task";
const MODEL_EXPECTED_BYTES = 9_398_198;
const MODEL_SHA256 = "4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad";

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
    minPoseDetectionConfidence: 0.2,
    minPosePresenceConfidence: 0.2,
    minTrackingConfidence: 0.25,
    outputSegmentationMasks: false,
  });

  const frames: BiomechanicsFrame[] = [];
  const runWarnings = new Set<string>();
  let previousCenter: NormalizedPoint | undefined;
  let previousCenterTime: number | undefined;
  let highestTrackedY: number | undefined;
  let missedFrames = 0;
  let lastInferenceTimestamp = -1;
  const cropCanvas = document.createElement("canvas");
  const cropContext = cropCanvas.getContext("2d", { alpha: false });

  try {
    if (!cropContext) {
      throw new Error("Center-of-mass analysis could not create a video crop canvas on this device.");
    }
    for (let index = 0; index < times.length; index += 1) {
      checkCancelled(isCancelled, signal);
      const requestedTime = times[index];
      await seekTo(video, requestedTime);
      checkCancelled(isCancelled, signal);
      const actualTime = video.currentTime;
      const searchRegion = buildPoseSearchRegion(
        calibration,
        identityZone,
        previousCenter,
        poseRecoveryStep(index, settings.sampleFps),
        poseRecoveryStep(missedFrames, settings.sampleFps),
      );
      renderPoseCrop(video, searchRegion, cropCanvas, cropContext);
      lastInferenceTimestamp = nextPoseInferenceTimestamp(requestedTime, lastInferenceTimestamp);
      let detectedLandmarks = mapPoseCandidatesFromRegion(
        landmarker.detectForVideo(cropCanvas, lastInferenceTimestamp).landmarks,
        searchRegion,
      );
      const elapsedSincePrevious = previousCenterTime === undefined
        ? 0
        : Math.max(0, actualTime - previousCenterTime);
      let selection = selectTrackedPose(
        detectedLandmarks,
        identityZone,
        previousCenter,
        elapsedSincePrevious,
        calibration,
        highestTrackedY,
      );
      // A tight crop can either miss the climber entirely or see only a nearby
      // partial/person candidate that identity matching rejects. Retry both
      // cases on the same decoded frame at a wider scale. Every inference gets
      // a strictly increasing VIDEO timestamp.
      if (!selection.selected) {
        const recoveryRegion = buildPoseRecoverySearchRegion(
          searchRegion,
          calibration,
          previousCenter,
        );
        if (!regionsEqual(searchRegion, recoveryRegion)) {
          renderPoseCrop(video, recoveryRegion, cropCanvas, cropContext);
          lastInferenceTimestamp = nextPoseInferenceTimestamp(requestedTime, lastInferenceTimestamp);
          const recoveryLandmarks = mapPoseCandidatesFromRegion(
            landmarker.detectForVideo(cropCanvas, lastInferenceTimestamp).landmarks,
            recoveryRegion,
          );
          const recoverySelection = selectTrackedPose(
            recoveryLandmarks,
            identityZone,
            previousCenter,
            elapsedSincePrevious,
            calibration,
            highestTrackedY,
          );
          if (recoverySelection.selected || !detectedLandmarks.length) {
            detectedLandmarks = recoveryLandmarks;
            selection = recoverySelection;
          }
        }
      }
      if (selection.warning) {
        runWarnings.add(selection.warning);
      }

      const landmarks = selection.selected ? toStoredLandmarks(selection.selected.landmarks) : [];
      if (selection.selected) {
        previousCenter = selection.selected.center;
        previousCenterTime = actualTime;
        highestTrackedY = highestTrackedY === undefined
          ? selection.selected.center.y
          : Math.min(highestTrackedY, selection.selected.center.y);
        missedFrames = 0;
      } else {
        missedFrames += 1;
      }
      const imageEstimate = computeImageCom(landmarks, settings);
      const wallEstimate = computeWallCom(landmarks, calibrationValidation.matrix, settings);
      const valid = Boolean(imageEstimate.point && wallEstimate.point);
      frames.push({
        rawTime: roundMetric(actualTime),
        climbTime: roundMetric(actualTime - startRawTime),
        poseDetected: detectedLandmarks.length > 0,
        poseSelected: landmarks.length > 0,
        poseCandidateCount: detectedLandmarks.length,
        landmarks,
        imageCom: imageEstimate.point,
        wallCom: wallEstimate.point,
        massCoverage: roundMetric(Math.min(imageEstimate.massCoverage, wallEstimate.massCoverage)),
        meanVisibility: roundMetric(Math.min(imageEstimate.meanVisibility, wallEstimate.meanVisibility)),
        valid,
        warning: !landmarks.length
          ? detectedLandmarks.length
            ? selection.warning ?? "A person was found but could not be safely associated with the climber."
            : "No person was detected in the current wall search region."
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
  if (kinematics.metrics.detectedFrames === 0) {
    runWarnings.add("No person was detected. Confirm that the wall corners and Start Body Zone surround the climber at the beginning of the selected range.");
  } else if ((kinematics.metrics.selectedFrames ?? 0) === 0) {
    runWarnings.add("People were detected, but none could be safely associated with the climber. Tighten the Start Body Zone around the athlete only.");
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
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
  if (settings.minMassCoverage < 0.7 || settings.minMassCoverage > 1) {
    throw new Error("Minimum visible body mass must stay between 70% and 100%.");
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
  calibration?: WallCalibration,
  highestTrackedY?: number,
): PoseSelectionResult {
  const anchored = candidates
    .map((landmarks) => ({ landmarks, center: poseAnchor(landmarks) }))
    .filter((candidate): candidate is { landmarks: NormalizedLandmark[]; center: NormalizedPoint } => Boolean(candidate.center));
  if (!anchored.length) {
    return { warning: "No pose with a usable hip or shoulder anchor was detected." };
  }

  // Calibration describes the selected 3 m lane, not the whole two-lane
  // wall. Keep that lane as a permanent identity constraint after the start
  // crop has established the athlete. Recovery crops intentionally widen to
  // find a missed climber, so filtering anchors here is what prevents a person
  // in the neighboring lane from taking over after a gap. The caller retains
  // the unfiltered candidate array for poseDetected/poseCandidateCount.
  const laneCandidates = calibration
    ? anchored.filter((candidate) => poseAnchorInsideLaneCorridor(candidate.center, calibration))
    : anchored;
  if (!laneCandidates.length) {
    return { warning: "Pose was rejected because every detected person was outside the selected climbing lane." };
  }

  const scored = laneCandidates
    .map((candidate) => ({
      ...candidate,
      score: previousCenter ? pointDistance(candidate.center, previousCenter) : 0,
    }))
    .sort((left, right) => left.score - right.score);

  // A Start Body Zone is an identity hint, not a reason to discard the only
  // person in the first frame. This fallback prevents a slightly tight zone
  // from turning an otherwise valid single-athlete clip into 0% tracking.
  if (!previousCenter && scored.length === 1) {
    return { selected: scored[0] };
  }

  if (previousCenter) {
    const maxDistance = clampNumber(0.12 + elapsedSincePrevious * 0.45, 0.12, 0.4);
    const backtrackLimit = highestTrackedY === undefined
      ? Number.POSITIVE_INFINITY
      : highestTrackedY + verticalIdentityBacktrackAllowance(calibration);
    const plausible = scored.filter((candidate) =>
      candidate.score <= maxDistance &&
      candidate.center.y <= backtrackLimit &&
      (!calibration || plausibleLaneContinuity(previousCenter, candidate.center, elapsedSincePrevious, calibration))
    );
    if (!plausible.length) {
      return { warning: "Pose was rejected because no detection plausibly matched the tracked climber." };
    }
    if (plausible.length > 1 && plausible[1].score - plausible[0].score < Math.max(0.025, plausible[0].score * 0.35)) {
      // Pose Landmarker can briefly return two nearly overlapping candidates
      // for one athlete. Once identity is established, retaining the closest
      // very-near match is safer than dropping the frame and losing the moving
      // crop. Still reject genuinely ambiguous candidates farther away so a
      // bystander cannot take over the track after a gap.
      const continuityLockDistance = Math.min(0.06, maxDistance * 0.5);
      if (plausible[0].score <= continuityLockDistance) {
        return { selected: plausible[0] };
      }
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
  // At the distant upper wall MediaPipe often loses one side of the torso
  // while the other shoulder and hip remain stable. Keep the moving crop on
  // that athlete; the stricter COM mass check still decides whether the frame
  // is good enough for metrics.
  const visibleShoulders = [leftShoulder, rightShoulder].filter(usableAnchor);
  const visibleHips = [leftHip, rightHip].filter(usableAnchor);
  const partialTorso = [...visibleShoulders, ...visibleHips];
  if (visibleShoulders.length && visibleHips.length && partialTorso.length >= 2) {
    return {
      x: meanCoordinate(partialTorso, "x"),
      y: meanCoordinate(partialTorso, "y"),
    };
  }
  return undefined;
}

function meanCoordinate(landmarks: NormalizedLandmark[], axis: "x" | "y"): number {
  return landmarks.reduce((sum, landmark) => sum + landmark[axis], 0) / landmarks.length;
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
  try {
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
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new PoseAnalysisCancelledError();
    }
    throw error;
  }
}

export interface PoseSearchRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PoseCropRaster {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * Converts a normalized search region into the source and destination pixels
 * used by drawImage. Keeping this separate makes the crop math deterministic
 * and prevents unnecessarily large temporary canvases on high-resolution
 * phone videos.
 */
export function buildPoseCropRaster(
  videoWidth: number,
  videoHeight: number,
  region: PoseSearchRegion,
  maxOutputDimension = 768,
): PoseCropRaster {
  if (videoWidth <= 0 || videoHeight <= 0 || maxOutputDimension <= 0) {
    throw new Error("Pose crop dimensions must be positive.");
  }
  const left = clampNumber(region.left, 0, 1);
  const top = clampNumber(region.top, 0, 1);
  const right = clampNumber(region.right, 0, 1);
  const bottom = clampNumber(region.bottom, 0, 1);
  if (right <= left || bottom <= top) {
    throw new Error("Pose crop region must have a positive width and height.");
  }

  const sourceWidth = (right - left) * videoWidth;
  const sourceHeight = (bottom - top) * videoHeight;
  // Very small high-wall crops are often below the detector's useful input
  // size on preview-resolution video elements. Upscaling cannot invent source
  // detail, but it prevents MediaPipe from doing its first pose proposal on a
  // tiny canvas. Keep the short edge at least 192 px when the output cap allows
  // it, while retaining the existing 768 px memory ceiling.
  const maximumScale = maxOutputDimension / Math.max(sourceWidth, sourceHeight);
  const minimumUsefulScale = 192 / Math.min(sourceWidth, sourceHeight);
  const outputScale = Math.min(maximumScale, Math.max(1, minimumUsefulScale));
  return {
    sourceX: left * videoWidth,
    sourceY: top * videoHeight,
    sourceWidth,
    sourceHeight,
    outputWidth: Math.max(1, Math.round(sourceWidth * outputScale)),
    outputHeight: Math.max(1, Math.round(sourceHeight * outputScale)),
  };
}

/** Maps landmarks normalized to a cropped canvas back into full-video space. */
export function mapPoseLandmarksFromRegion(
  landmarks: NormalizedLandmark[],
  region: PoseSearchRegion,
): NormalizedLandmark[] {
  const width = region.right - region.left;
  const height = region.bottom - region.top;
  return landmarks.map((landmark) => ({
    ...landmark,
    x: region.left + landmark.x * width,
    y: region.top + landmark.y * height,
    // MediaPipe's landmark depth uses approximately the same normalized scale
    // as x, so convert it to the full-frame x scale as well.
    z: landmark.z * width,
  }));
}

export function nextPoseInferenceTimestamp(requestedRawTime: number, previousTimestamp: number): number {
  return Math.max(Math.round(requestedRawTime * 1000), Math.floor(previousTimestamp) + 1);
}

function mapPoseCandidatesFromRegion(
  candidates: NormalizedLandmark[][],
  region: PoseSearchRegion,
): NormalizedLandmark[][] {
  return candidates.map((landmarks) => mapPoseLandmarksFromRegion(landmarks, region));
}

function renderPoseCrop(
  video: HTMLVideoElement,
  region: PoseSearchRegion,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): void {
  const raster = buildPoseCropRaster(video.videoWidth, video.videoHeight, region);
  if (canvas.width !== raster.outputWidth || canvas.height !== raster.outputHeight) {
    canvas.width = raster.outputWidth;
    canvas.height = raster.outputHeight;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    video,
    raster.sourceX,
    raster.sourceY,
    raster.sourceWidth,
    raster.sourceHeight,
    0,
    0,
    raster.outputWidth,
    raster.outputHeight,
  );
}

/**
 * Recovery was tuned at 5 fps. Express its counters in the same elapsed-time
 * units at every supported sample rate so 15 fps cannot sweep past the athlete
 * three times as fast after a missed detection. Inference still runs at the
 * requested sample rate; only the search schedule uses this common cadence.
 */
export function poseRecoveryStep(frameCount: number, sampleFps: number): number {
  if (!Number.isFinite(frameCount) || frameCount < 0 || !Number.isFinite(sampleFps) || sampleFps <= 0) {
    return 0;
  }
  return Math.floor(frameCount * 5 / sampleFps + 1e-9);
}

/**
 * Keeps the athlete large enough for the on-device detector; whole-frame
 * inference can reduce a climber on a 15 m wall to only a few detector pixels.
 * sampleIndex and missedFrames are recovery steps at a shared 5 Hz cadence.
 */
export function buildPoseSearchRegion(
  calibration: WallCalibration,
  identityZone?: NormalizedZone,
  previousCenter?: NormalizedPoint,
  sampleIndex = 0,
  missedFrames = 0,
): PoseSearchRegion {
  const xs = calibration.corners.map((corner) => corner.image.x);
  const ys = calibration.corners.map((corner) => corner.image.y);
  const wallLeft = Math.min(...xs);
  const wallRight = Math.max(...xs);
  const wallTop = Math.min(...ys);
  const wallBottom = Math.max(...ys);
  const wallHeight = Math.max(0.12, wallBottom - wallTop);
  let centerX = (wallLeft + wallRight) / 2;
  let centerY: number;
  let cropWidth: number;
  let cropHeight: number;

  if (previousCenter) {
    centerX = previousCenter.x;
    centerY = previousCenter.y;
    const baseSize = poseCropSizeAtY(calibration, centerY, wallHeight);
    cropWidth = baseSize.width;
    cropHeight = baseSize.height;

    if (missedFrames < 4) {
      // A crop centered on the last hip position leaves too little room in the
      // direction a speed climber is actually travelling. This is most costly
      // in the upper half, where the athlete is small and one missed proposal
      // can make a wider retry prefer the larger person below. Lead the crop
      // upward, progressively more after a miss, while retaining the previous
      // anchor well inside the crop for pauses and normal body compression.
      const wallProgress = clampNumber((wallBottom - previousCenter.y) / wallHeight, 0, 1);
      const upwardLeadRatio = clampNumber(
        0.06 + wallProgress * 0.1 + missedFrames * 0.07,
        0.06,
        0.32,
      );
      centerY -= cropHeight * upwardLeadRatio;
      const continuityExpansion = 1 + missedFrames * 0.18;
      cropWidth = Math.min(0.82, cropWidth * continuityExpansion);
      cropHeight = Math.min(0.58, cropHeight * continuityExpansion);
    } else {
      // Never throw an established high-wall track back to the floor. Search
      // locally around, and mostly above, its last reliable anchor. Each full
      // pass shifts farther upward while modestly widening the crop.
      const recoveryStep = missedFrames - 4;
      const localScan = LOCAL_TRACK_RECOVERY_PATTERN[recoveryStep % LOCAL_TRACK_RECOVERY_PATTERN.length];
      const recoveryCycle = Math.floor(recoveryStep / LOCAL_TRACK_RECOVERY_PATTERN.length);
      centerX += localScan.x * cropWidth;
      centerY += (localScan.y - recoveryCycle * 0.55) * cropHeight;
      const recoveryExpansion = clampNumber(1.25 + recoveryCycle * 0.18, 1.25, 1.75);
      cropWidth = Math.min(0.84, cropWidth * recoveryExpansion);
      cropHeight = Math.min(0.6, cropHeight * recoveryExpansion);
    }
  } else if (!previousCenter && identityZone && missedFrames < 2) {
    centerX = (identityZone.x1 + identityZone.x2) / 2;
    const identityHeight = Math.abs(identityZone.y2 - identityZone.y1);
    centerY = Math.max(identityZone.y1, identityZone.y2) - identityHeight * 0.4;
    const baseSize = poseCropSizeAtY(calibration, centerY, wallHeight);
    cropWidth = baseSize.width;
    cropHeight = baseSize.height;
    // Keep the athlete large enough for MediaPipe. The previous 2.2x zone
    // expansion could turn an automatic body zone into a near-full-frame crop.
    cropWidth = Math.max(cropWidth, Math.abs(identityZone.x2 - identityZone.x1) * 1.25);
    cropHeight = Math.max(cropHeight, identityHeight * 1.35);
  } else {
    // After two misses, stop retrying the identical start crop. Expand and
    // scan bottom-to-top so an initially hidden climber can still be acquired.
    const recoveryStep = Math.max(0, missedFrames - (identityZone ? 2 : 0));
    const scanStep = identityZone ? recoveryStep : sampleIndex;
    const scanIndex = scanStep % 5;
    const expansion = clampNumber(1 + recoveryStep * 0.18, 1, 1.65);
    const bottomSize = poseCropSizeAtY(calibration, wallBottom, wallHeight);
    const usableTravel = Math.max(0, wallHeight - bottomSize.height);
    centerY = wallBottom - bottomSize.height / 2 - usableTravel * (scanIndex / 4);
    const laneAtScan = laneGeometryAtY(calibration, centerY);
    const baseSize = poseCropSizeAtY(calibration, centerY, wallHeight);
    cropWidth = baseSize.width;
    cropHeight = baseSize.height;
    if (identityZone) {
      centerX = laneAtScan.centerX;
      cropWidth = Math.max(cropWidth, Math.abs(identityZone.x2 - identityZone.x1) * 1.35);
      cropHeight = Math.max(cropHeight, Math.abs(identityZone.y2 - identityZone.y1) * 1.45);
    } else {
      centerX = laneAtScan.centerX;
    }
    cropWidth = Math.min(0.86, cropWidth * expansion);
    cropHeight = Math.min(0.64, cropHeight * expansion);
  }

  return fitRegion(centerX, centerY, cropWidth, cropHeight);
}

const LOCAL_TRACK_RECOVERY_PATTERN: ReadonlyArray<NormalizedPoint> = [
  { x: 0, y: -0.25 },
  { x: -0.2, y: -0.65 },
  { x: 0.2, y: -0.65 },
  { x: 0, y: -1.05 },
  { x: -0.3, y: 0.2 },
  { x: 0.3, y: 0.2 },
];

/**
 * Estimates the selected lane's apparent width at a video y-coordinate. The
 * standardized wall narrows toward the top in portrait recordings, so using
 * the full bottom width there makes the athlete too small for pose inference.
 */
function laneGeometryAtY(
  calibration: WallCalibration,
  y: number,
): { centerX: number; width: number; perspectiveScale: number } {
  const bottomLeft = calibration.corners.find((corner) => corner.id === "bottomLeft") ?? calibration.corners[0];
  const bottomRight = calibration.corners.find((corner) => corner.id === "bottomRight") ?? calibration.corners[1];
  const topRight = calibration.corners.find((corner) => corner.id === "topRight") ?? calibration.corners[2];
  const topLeft = calibration.corners.find((corner) => corner.id === "topLeft") ?? calibration.corners[3];
  // Interpolate each side independently. Automatic calibrations are often
  // slightly skewed trapezoids, so a single average y-progress can move the
  // lane boundary toward the neighboring athlete near the top.
  const leftX = interpolateEdgeXAtY(bottomLeft.image, topLeft.image, y);
  const rightX = interpolateEdgeXAtY(bottomRight.image, topRight.image, y);
  const bottomWidth = Math.max(0.05, Math.abs(bottomRight.image.x - bottomLeft.image.x));
  const width = Math.max(0.04, Math.abs(rightX - leftX));
  return {
    centerX: (leftX + rightX) / 2,
    width,
    perspectiveScale: clampNumber(width / bottomWidth, 0.45, 1.15),
  };
}

function interpolateEdgeXAtY(bottom: NormalizedPoint, top: NormalizedPoint, y: number): number {
  const denominator = bottom.y - top.y;
  const progress = Math.abs(denominator) < 1e-6
    ? 0.5
    : clampNumber((bottom.y - y) / denominator, 0, 1);
  return bottom.x + (top.x - bottom.x) * progress;
}

export interface PoseLaneCorridor {
  left: number;
  right: number;
}

/**
 * Returns the selected lane's horizontal anchor corridor at a given image y.
 * The proportional margin shrinks with perspective near the wall top. A small
 * fixed floor absorbs pose jitter and approximate-calibration error without
 * extending far enough to include the center of the neighboring lane.
 */
export function poseLaneCorridorAtY(
  calibration: WallCalibration,
  y: number,
): PoseLaneCorridor {
  const lane = laneGeometryAtY(calibration, y);
  if (calibration.source === "automatic-approximate") {
    // The inferred lane's inner edge is the physical divider between the two
    // speed lanes. A large symmetric error margin there overlaps the adjacent
    // lane and lets its athlete become a legal identity candidate. Keep the
    // generous tolerance at the outside wall edge, but only a small pose-jitter
    // allowance at the shared boundary.
    const outsideMargin = Math.max(0.012, lane.width * 0.28);
    const sharedBoundaryMargin = Math.max(0.008, lane.width * 0.08);
    const reason = calibration.reason?.toLowerCase() ?? "";
    const selectedLeftLane = reason.includes("left-lane")
      ? true
      : reason.includes("right-lane")
        ? false
        : lane.centerX < 0.5;
    return selectedLeftLane
      ? {
          left: clampNumber(lane.centerX - lane.width / 2 - outsideMargin, 0, 1),
          right: clampNumber(lane.centerX + lane.width / 2 + sharedBoundaryMargin, 0, 1),
        }
      : {
          left: clampNumber(lane.centerX - lane.width / 2 - sharedBoundaryMargin, 0, 1),
          right: clampNumber(lane.centerX + lane.width / 2 + outsideMargin, 0, 1),
        };
  }

  const margin = Math.max(0.012, lane.width * 0.22);
  return {
    left: clampNumber(lane.centerX - lane.width / 2 - margin, 0, 1),
    right: clampNumber(lane.centerX + lane.width / 2 + margin, 0, 1),
  };
}

function poseAnchorInsideLaneCorridor(
  anchor: NormalizedPoint,
  calibration: WallCalibration,
): boolean {
  const corridor = poseLaneCorridorAtY(calibration, anchor.y);
  return anchor.x >= corridor.left && anchor.x <= corridor.right;
}

function plausibleLaneContinuity(
  previous: NormalizedPoint,
  candidate: NormalizedPoint,
  elapsedSeconds: number,
  calibration: WallCalibration,
): boolean {
  const previousCorridor = poseLaneCorridorAtY(calibration, previous.y);
  const candidateCorridor = poseLaneCorridorAtY(calibration, candidate.y);
  const corridorSpan = Math.max(
    previousCorridor.right - previousCorridor.left,
    candidateCorridor.right - candidateCorridor.left,
  );
  // At normal sample intervals this blocks a discontinuous sideways teleport.
  // After a real detection gap, the allowance grows until the athlete can
  // legitimately traverse the full selected lane, but never beyond it.
  const timeAllowance = 0.065 + Math.max(0, elapsedSeconds) * 0.3;
  return Math.abs(candidate.x - previous.x) <= Math.min(corridorSpan, timeAllowance);
}

/**
 * A speed climber's hip can dip during compression, but it should not jump a
 * large distance back down the wall after already reaching a higher point.
 * Keeping this allowance independent of the detection-gap duration prevents a
 * slower neighboring athlete from eventually becoming plausible just because
 * the intended climber was missed for several frames.
 */
function verticalIdentityBacktrackAllowance(calibration?: WallCalibration): number {
  if (!calibration) {
    return 0.085;
  }
  const ys = calibration.corners.map((corner) => corner.image.y);
  const wallHeight = Math.max(0.12, Math.max(...ys) - Math.min(...ys));
  // This also absorbs the occasional shoulder-to-hip anchor transition when
  // the distant athlete's hips become visible again on the next frame.
  return clampNumber(wallHeight * 0.09, 0.065, 0.09);
}

function poseCropSizeAtY(
  calibration: WallCalibration,
  y: number,
  wallHeight: number,
): { width: number; height: number } {
  const lane = laneGeometryAtY(calibration, y);
  return {
    width: clampNumber(lane.width * 1.4, 0.2, 0.68),
    height: clampNumber(wallHeight * 0.34 * lane.perspectiveScale, 0.18, 0.5),
  };
}

export function expandPoseSearchRegion(region: PoseSearchRegion, factor: number): PoseSearchRegion {
  const centerX = (region.left + region.right) / 2;
  const centerY = (region.top + region.bottom) / 2;
  const width = Math.min(0.94, (region.right - region.left) * Math.max(1, factor));
  const height = Math.min(0.82, (region.bottom - region.top) * Math.max(1, factor));
  return fitRegion(centerX, centerY, width, height);
}

/**
 * Builds the same-frame retry crop after a tight tracking crop did not produce
 * a safe identity match. In the upper wall the likely target is above the last
 * anchor, while a second climber is commonly below it. Biasing the retry upward
 * keeps the small target prominent instead of centering the larger neighbor.
 */
export function buildPoseRecoverySearchRegion(
  region: PoseSearchRegion,
  calibration: WallCalibration,
  previousCenter?: NormalizedPoint,
): PoseSearchRegion {
  if (!previousCenter) {
    return expandPoseSearchRegion(region, 1.55);
  }

  const ys = calibration.corners.map((corner) => corner.image.y);
  const wallTop = Math.min(...ys);
  const wallBottom = Math.max(...ys);
  const wallHeight = Math.max(0.12, wallBottom - wallTop);
  const wallProgress = clampNumber((wallBottom - previousCenter.y) / wallHeight, 0, 1);
  if (wallProgress < 0.32) {
    return expandPoseSearchRegion(region, 1.55);
  }

  const width = region.right - region.left;
  const height = region.bottom - region.top;
  const centerX = (region.left + region.right) / 2;
  const centerY = (region.top + region.bottom) / 2 - height * (0.12 + wallProgress * 0.08);
  return fitRegion(
    centerX,
    centerY,
    Math.min(0.82, width * 1.35),
    Math.min(0.62, height * 1.4),
  );
}

function regionsEqual(left: PoseSearchRegion, right: PoseSearchRegion): boolean {
  return Math.abs(left.left - right.left) < 1e-6 &&
    Math.abs(left.top - right.top) < 1e-6 &&
    Math.abs(left.right - right.right) < 1e-6 &&
    Math.abs(left.bottom - right.bottom) < 1e-6;
}

function fitRegion(centerX: number, centerY: number, width: number, height: number): PoseSearchRegion {
  const safeWidth = clampNumber(width, 0.1, 1);
  const safeHeight = clampNumber(height, 0.1, 1);
  const left = clampNumber(centerX - safeWidth / 2, 0, 1 - safeWidth);
  const top = clampNumber(centerY - safeHeight / 2, 0, 1 - safeHeight);
  return {
    left,
    top,
    right: left + safeWidth,
    bottom: top + safeHeight,
  };
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
