import type { NormalizedZone, PoseLandmarkPoint } from "../types";
import {
  locateFinishTargets,
  locatePadApproach,
  assessPadHandApproach,
  type PadHandSample,
  type PadHandEvidence,
  type FinishTargetCandidate,
} from "./finishPadRecovery";
import { sampleFramesInRange, seekTo } from "./videoFrameSampler";
import { readDecodedVideoFrameTime } from "./decodedVideoFrame";
import { assessSceneContinuity } from "./cameraStability";
import type { TopFinishFrame } from "./detectTopFinishSignal";
import { scanFinishPadReview, type FinishReviewScan } from "./finishReview";

export interface FinishPadRecovery {
  targets: FinishTargetCandidate[];
  target?: NormalizedZone;
  approachRawTime?: number;
  handEvidence?: PadHandEvidence;
  samples: PadHandSample[];
  review?: FinishReviewScan;
  reason: string;
}

/** Local review-only analysis. It never creates COM metrics or accepts timing. */
export async function scanAutomaticFinishPad(options: {
  video: HTMLVideoElement;
  startRawTime: number;
  laneHintZone?: NormalizedZone;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Research probe only: hand proximity is not validated as pad contact. */
  inspectHands?: boolean;
}): Promise<FinishPadRecovery> {
  const { video, signal, onProgress } = options,
    source = video.src;
  const check = () => {
    if (signal?.aborted || source !== video.src)
      throw new Error("Finish target inspection cancelled.");
  };
  const start = options.startRawTime + 3,
    end = Math.min(video.duration - 0.01, options.startRawTime + 30);
  check();
  if (
    !Number.isFinite(start) ||
    options.startRawTime < 0 ||
    !Number.isFinite(end) ||
    end - start < 2 ||
    !options.laneHintZone ||
    !video.videoWidth ||
    !video.videoHeight
  )
    return {
      targets: [],
      samples: [],
      reason:
        "A valid Start and lane hint are required for finish-target recovery.",
    };
  const hint = (options.laneHintZone.x1 + options.laneHintZone.x2) / 2;
  const capture = async (
    times: number[],
    maxHeight: number,
  ): Promise<TopFinishFrame[]> => {
    const scale = Math.min(
      1,
      maxHeight / video.videoHeight,
      (maxHeight * 1.5) / video.videoWidth,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Finish target canvas unavailable.");
    const frames: TopFinishFrame[] = [];
    try {
      for (let i = 0; i < times.length; i++) {
        check();
        await seekTo(video, times[i]);
        check();
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({
          time:
            readDecodedVideoFrameTime(video)?.mediaTime ?? video.currentTime,
          width: canvas.width,
          height: canvas.height,
          data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        });
        onProgress?.(
          `Locating finish targets: ${i + 1}/${times.length} frames…`,
        );
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
    return frames;
  };
  const targetFrames = await capture(
    Array.from({ length: 9 }, (_, i) => start + ((end - start) * i) / 8),
    960,
  );
  check();
  const targets = locateFinishTargets(targetFrames, hint);
  if (targets.length !== 1)
    return {
      targets,
      samples: [],
      reason:
        "No unique persistent finish-target candidate was localized in the selected lane.",
    };
  const target = targets[0].zone;
  const coarse = await capture(sampleFramesInRange(start, end, 5), 320);
  check();
  const approachRawTime = locatePadApproach(coarse, target);
  if (approachRawTime === undefined)
    return {
      targets,
      target,
      samples: [],
      reason:
        "An upper target was located, but no sustained approach from below was found.",
    };
  // Check the local event against neighboring full frames, not a distant
  // start reference that may contain a temporary foreground obstruction.
  const before = [...coarse]
      .reverse()
      .find((f) => f.time <= approachRawTime - 0.4),
    after = coarse.find((f) => f.time >= approachRawTime + 0.4);
  if (!before || !after || !assessSceneContinuity(before, after).continuous)
    return {
      targets,
      target,
      approachRawTime,
      samples: [],
      reason:
        "Camera or scene continuity did not support the proposed target approach.",
    };
  // Inspect only the first approach, not the entire clip's largest change
  // (which could be a later reset). This is navigation, never timing evidence.
  const review = await scanFinishPadReview({
    video,
    zone: target,
    center: approachRawTime + 0.75,
    startSignal: start,
    signal,
    onProgress,
    areaLabel: "automatic target",
    overview: true,
  });
  check();
  review.reason = "Source frames across the first approach, including the strongest local appearance change. Movement and occlusion can resemble contact; no Finish was accepted.";
  if (!options.inspectHands)
    return {
      targets,
      target,
      approachRawTime,
      review,
      samples: [],
      reason:
        "An upper target and first approach window were located automatically. Inspect these source frames for contact; no Finish was accepted.",
    };
  onProgress?.("Inspecting the hand near the finish target…");
  const {
    loadVerifiedModel,
    buildPoseCropRaster,
    mapPoseLandmarksFromRegion,
    nextPoseInferenceTimestamp,
  } = await import("./poseAnalysis");
  const { FilesetResolver, PoseLandmarker } = await import(
    "@mediapipe/tasks-vision"
  );
  check();
  const buffer = await loadVerifiedModel(signal);
  check();
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  const vision = await FilesetResolver.forVisionTasks(
    new URL(`${base}mediapipe/wasm`, window.location.origin).href,
  );
  check();
  const cx = (target.x1 + target.x2) / 2,
    cy = (target.y1 + target.y2) / 2;
  const region = {
    left: Math.max(0, cx - 0.12),
    right: Math.min(1, cx + 0.12),
    top: Math.max(0, cy - 0.05),
    bottom: Math.min(1, cy + 0.24),
  };
  const raster = buildPoseCropRaster(
    video.videoWidth,
    video.videoHeight,
    region,
    640,
  );
  const canvas = document.createElement("canvas");
  canvas.width = raster.outputWidth;
  canvas.height = raster.outputHeight;
  const context = canvas.getContext("2d");
  const samples: PadHandSample[] = [];
  let previousTimestamp = -1;
  const seen = new Set<number>();
  const detector = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetBuffer: buffer, delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 2,
    minPoseDetectionConfidence: 0.2,
    minPosePresenceConfidence: 0.2,
    minTrackingConfidence: 0.25,
    outputSegmentationMasks: false,
  });
  try {
    check();
    if (!context) throw new Error("Hand inspection canvas unavailable.");
    const times = sampleFramesInRange(
      Math.max(start, approachRawTime - 0.5),
      Math.min(end, approachRawTime + 2.0),
      15,
    );
    for (let i = 0; i < times.length; i++) {
      check();
      await seekTo(video, times[i]);
      check();
      const decoded = readDecodedVideoFrameTime(video),
        rawTime = decoded?.mediaTime ?? video.currentTime;
      if (seen.has(rawTime)) continue;
      seen.add(rawTime);
      context.drawImage(
        video,
        raster.sourceX,
        raster.sourceY,
        raster.sourceWidth,
        raster.sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      previousTimestamp = nextPoseInferenceTimestamp(
        times[i],
        previousTimestamp,
      );
      const poses = detector
        .detectForVideo(canvas, previousTimestamp)
        .landmarks.map((p) => mapPoseLandmarksFromRegion(p, region));
      const eligible = poses.filter((p) => {
        const torso = [11, 12, 23, 24]
          .map((j) => p[j])
          .filter((q) => q && q.visibility >= 0.35);
        if (torso.length < 3) return false;
        const x = torso.reduce((s, q) => s + q.x, 0) / torso.length,
          y = torso.reduce((s, q) => s + q.y, 0) / torso.length;
        return Math.abs(x - cx) <= 0.1 && y > cy - 0.01 && y < cy + 0.2;
      });
      // Ambiguous people are a tracking failure, not an invitation to select
      // whichever hand happens to be closest to the target.
      const landmarks: PoseLandmarkPoint[] =
        eligible.length === 1
          ? eligible[0].map((p, index) => ({
              index,
              x: p.x,
              y: p.y,
              z: p.z,
              visibility: p.visibility,
            }))
          : [];
      samples.push({ rawTime, nativeTimed: Boolean(decoded), landmarks });
      onProgress?.(
        `Inspecting finish-target hand approach: ${i + 1}/${times.length} frames…`,
      );
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    detector.close();
    canvas.width = 1;
    canvas.height = 1;
  }
  check();
  const handEvidence = assessPadHandApproach(samples, target);
  return {
    targets,
    target,
    approachRawTime,
    review,
    handEvidence,
    samples,
    reason: handEvidence.reason,
  };
}
