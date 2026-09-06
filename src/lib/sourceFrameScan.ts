import {
  readDecodedVideoFrameTime,
  type DecodedVideoFrameTime,
} from "./decodedVideoFrame";
import { seekTo } from "./videoFrameSampler";
import { sanitizeSourceSampleTiming } from "./sourceSampleTiming";

export interface SourceFrameObservation {
  cursorTime: number;
  rawTime: number;
  decoded?: DecodedVideoFrameTime;
}
export interface SourceFrameScanSummary {
  observations: number;
  nativeFrames: number;
  duplicateFramesSkipped: number;
  usedDurationSteps: number;
  isAccuracyBound: false;
}

/** Visit native frames in a short refinement window. Source duration drives
 * the next seek when available; an explicit cursor grid is the fallback.
 * Throws on cancellation, source replacement, stalled decoding or budget
 * exhaustion so an incomplete pass cannot masquerade as dense verification.
 */
export async function scanSourceFrames(options: {
  video: HTMLVideoElement;
  start: number;
  end: number;
  fallbackFps?: number;
  maxFrames?: number;
  signal?: AbortSignal;
  onFrame: (frame: SourceFrameObservation) => void | Promise<void>;
}): Promise<SourceFrameScanSummary> {
  const { video, start, end, signal, onFrame } = options;
  const fps = options.fallbackFps ?? 30;
  const maxFrames = options.maxFrames ?? 512;
  if (
    ![start, end, fps, video.duration].every(Number.isFinite) ||
    start < 0 ||
    end <= start ||
    end > video.duration ||
    fps <= 0 ||
    fps > 240 ||
    !Number.isInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 4096
  ) {
    throw new Error("Invalid source-frame refinement window or budget.");
  }
  const source = video.src;
  const check = () => {
    if (signal?.aborted || video.src !== source) {
      const error = new Error("Source-frame refinement cancelled.");
      error.name = "AbortError";
      throw error;
    }
  };
  const summary: SourceFrameScanSummary = {
    observations: 0,
    nativeFrames: 0,
    duplicateFramesSkipped: 0,
    usedDurationSteps: 0,
    isAccuracyBound: false,
  };
  const seen = new Set<number>();
  const limit = Math.min(end, video.duration - 0.001);
  if (limit < start)
    throw new Error("Source-frame refinement has no decodable window.");
  let cursor = start;
  let stalled = 0;
  let timingMode: "native" | "cursor" | undefined;
  for (let attempts = 0; cursor <= limit + 1e-9; attempts++) {
    check();
    if (attempts >= maxFrames * 4 || summary.observations >= maxFrames)
      throw new Error(
        "Source-frame refinement exceeded its bounded frame budget.",
      );
    await seekTo(video, cursor, { exact: true });
    check();
    let decoded = readDecodedVideoFrameTime(video);
    if (
      decoded &&
      sanitizeSourceSampleTiming(video.currentTime, {
        decodedFrameRawTime: decoded.mediaTime,
        sourceFrameDurationSeconds: decoded.durationSeconds,
      }).decodedFrameRawTime === undefined
    )
      decoded = undefined;
    timingMode ??= decoded ? "native" : "cursor";
    if (timingMode === "native" && !decoded)
      throw new Error(
        "Source-frame timing became unavailable during refinement.",
      );
    if (timingMode === "cursor") decoded = undefined;
    const rawTime = decoded?.mediaTime ?? video.currentTime;
    if (decoded && seen.has(rawTime)) {
      summary.duplicateFramesSkipped++;
      // A duration can land just short of the next PTS in variable-rate media.
      // Small bounded forward retries are not additional observations.
      const durationAvailable = decoded.durationSeconds !== undefined;
      if (++stalled > (durationAvailable ? 8 : Math.ceil(fps)))
        throw new Error(
          "Source-frame refinement could not advance the decoded frame.",
        );
      cursor += durationAvailable ? Math.min(0.005, 1 / fps / 4) : 1 / fps;
      continue;
    }
    stalled = 0;
    if (decoded) {
      seen.add(rawTime);
      summary.nativeFrames++;
    }
    await onFrame({ cursorTime: video.currentTime, rawTime, decoded });
    check();
    summary.observations++;
    const duration = decoded?.durationSeconds;
    if (
      decoded &&
      duration !== undefined &&
      duration >= 0.0001 &&
      duration <= 1
    ) {
      const next = rawTime + duration + Math.min(0.0001, duration / 100);
      if (next > cursor + 1e-7) {
        cursor = next;
        summary.usedDurationSteps++;
      } else cursor += Math.min(0.005, 1 / fps / 4);
    } else cursor += 1 / fps;
    if (summary.observations % 8 === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return summary;
}
