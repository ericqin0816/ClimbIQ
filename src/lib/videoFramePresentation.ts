import { readDecodedVideoFrameTime } from "./decodedVideoFrame";

export type FramePresentation =
  | { status: "pending" | "unsupported" | "unavailable" }
  | { status: "available"; mediaTime: number; cursorTime: number; source: string;
      method?: "video-frame"; durationSeconds?: number };

/** Observe compositor timestamps without slowing pixel-analysis seeks. */
export function observeVideoFramePresentation(
  video: HTMLVideoElement,
  onUpdate: (presentation: FramePresentation) => void,
  timeoutMs = 250,
): () => void {
  // Unlike compositor callbacks, this also works for paused/offscreen videos.
  // Reading the current frame must not change playback or set its timestamp.
  if (typeof globalThis.VideoFrame === "function") {
    let active = true;
    const source = video.src;
    const invalidate = () => { if (active) onUpdate({ status: "pending" }); };
    const publish = () => {
      if (!active || video.src !== source) return;
      if (video.seeking) { invalidate(); return; }
      const frame = readDecodedVideoFrameTime(video);
      onUpdate(frame ? { status: "available", ...frame } : { status: "unavailable" });
    };
    const invalidatingEvents = ["seeking", "emptied", "loadstart"];
    const readyEvents = ["seeked", "loadeddata", "pause"];
    invalidatingEvents.forEach(event => video.addEventListener(event, invalidate));
    readyEvents.forEach(event => video.addEventListener(event, publish));
    publish();
    return () => {
      active = false;
      invalidatingEvents.forEach(event => video.removeEventListener(event, invalidate));
      readyEvents.forEach(event => video.removeEventListener(event, publish));
    };
  }
  if (typeof video.requestVideoFrameCallback !== "function") {
    onUpdate({ status: "unsupported" });
    return () => undefined;
  }
  let active = true;
  let callbackId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let seekStartedAt = performance.now();
  const source = video.src;
  let pendingFrame: { mediaTime: number; cursorTime: number; source: string } | undefined;
  const clearTimer = () => { if (timeoutId !== undefined) clearTimeout(timeoutId); timeoutId = undefined; };
  const invalidate = () => {
    clearTimer();
    seekStartedAt = performance.now();
    pendingFrame = undefined;
    onUpdate({ status: "pending" });
    timeoutId = setTimeout(() => { if (active) onUpdate({ status: "unavailable" }); }, timeoutMs);
  };
  const publish = () => {
    if (pendingFrame && !video.seeking && video.src === source &&
        Math.abs(pendingFrame.cursorTime - video.currentTime) <= 0.000001) {
      clearTimer();
      onUpdate({ status: "available", ...pendingFrame });
    }
  };
  const callback: VideoFrameRequestCallback = (_now, metadata) => {
    if (!active) return;
    if (video.src === source && Number.isFinite(metadata.mediaTime) &&
        metadata.mediaTime >= 0 && metadata.mediaTime <= video.duration + 0.001 &&
        Number.isFinite(metadata.presentationTime) && metadata.presentationTime >= seekStartedAt - 0.5 &&
        Math.abs(metadata.mediaTime - video.currentTime) <= 0.5) {
      // Chrome can present the requested frame before dispatching `seeked`.
      // Retain that new presentation, then publish it once the seek settles.
      pendingFrame = { mediaTime: metadata.mediaTime, cursorTime: video.currentTime, source };
      publish();
    }
    callbackId = video.requestVideoFrameCallback(callback);
  };
  video.addEventListener("seeking", invalidate);
  video.addEventListener("seeked", publish);
  video.addEventListener("emptied", invalidate);
  video.addEventListener("loadstart", invalidate);
  invalidate();
  callbackId = video.requestVideoFrameCallback(callback);
  return () => {
    active = false;
    clearTimer();
    if (callbackId !== undefined) video.cancelVideoFrameCallback(callbackId);
    video.removeEventListener("seeking", invalidate);
    video.removeEventListener("seeked", publish);
    video.removeEventListener("emptied", invalidate);
    video.removeEventListener("loadstart", invalidate);
  };
}

/** A native frame timestamp is usable only for this source and unchanged cursor. */
export function resolvePresentedFrameTime(video: Pick<HTMLVideoElement, "src" | "currentTime" | "seeking">, presentation: FramePresentation): number | undefined {
  return presentation.status === "available" && !video.seeking && presentation.source === video.src &&
    Math.abs(presentation.cursorTime - video.currentTime) <= 0.000001
    ? presentation.mediaTime : undefined;
}
