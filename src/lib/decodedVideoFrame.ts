export interface DecodedVideoFrameTime {
  mediaTime: number;
  cursorTime: number;
  durationSeconds?: number;
  source: string;
  method: "video-frame";
}

/** Read the current source frame without waiting for a compositor callback.
 * Never supply init.timestamp: that would overwrite the timestamp we need.
 * https://www.w3.org/TR/webcodecs/#dom-videoframe-videoframe-image-init
 */
export function readDecodedVideoFrameTime(video: HTMLVideoElement): DecodedVideoFrameTime | undefined {
  if (typeof globalThis.VideoFrame !== "function" || video.seeking || video.readyState < 2 ||
      !video.src || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) return undefined;
  let frame: VideoFrame | undefined;
  try {
    frame = new VideoFrame(video);
    const mediaTime = frame.timestamp / 1_000_000;
    if (!Number.isFinite(mediaTime) || mediaTime < 0 || mediaTime > video.duration + 0.001 ||
        Math.abs(mediaTime - video.currentTime) > 0.5) return undefined;
    const duration = frame.duration === null ? undefined : frame.duration / 1_000_000;
    return { mediaTime, cursorTime: video.currentTime, source: video.src, method: "video-frame",
      durationSeconds: duration !== undefined && Number.isFinite(duration) && duration > 0 && duration <= 1 ? duration : undefined };
  } catch {
    // Older browsers, codec limitations, or a not-yet-decoded frame retain
    // the explicit review fallback instead of preventing video analysis.
    return undefined;
  } finally {
    frame?.close();
  }
}

/** Seek just inside the adjacent source interval, including variable-rate video. */
export function sourceFrameStepTarget(frame: Pick<DecodedVideoFrameTime, "mediaTime" | "durationSeconds">,
  videoDuration: number, direction: -1 | 1): number | undefined {
  const duration = frame.durationSeconds;
  if (!Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(frame.mediaTime) || frame.mediaTime < 0 ||
      frame.mediaTime > videoDuration || duration === undefined || !Number.isFinite(duration) || duration < 0.0001 || duration > 1) return undefined;
  const inside = Math.min(0.0001, duration / 100);
  const target = direction === -1 ? frame.mediaTime - inside : frame.mediaTime + duration + inside;
  return Math.max(0, Math.min(videoDuration - 0.001, target));
}
