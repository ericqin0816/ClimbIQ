import type { NormalizedZone } from "../types";
import { readDecodedVideoFrameTime } from "./decodedVideoFrame";
import { clamp, normalizedZoneToPixelRect, sampleFramesInRange, seekTo } from "./videoFrameSampler";

export interface FinishReviewFrame {
  cursorTime: number;
  rawTime: number;
  timeSource: "decoded-frame" | "cursor";
  imageUrl: string;
}
export interface FinishReviewScan {
  start: number;
  end: number;
  sampledFrames: number;
  comparedFrames: number;
  nativeTimedFrames: number;
  reason: string;
  frames: FinishReviewFrame[];
  suggestedRawTime?: number;
}

/** This is a user-selected search area, never a detected or verified pad. */
export function normalizeFinishPadZone(value: Pick<NormalizedZone, "x1" | "x2" | "y1" | "y2">): NormalizedZone | undefined {
  if (![value.x1, value.x2, value.y1, value.y2].every(Number.isFinite)) return undefined;
  const x1 = clamp(Math.min(value.x1, value.x2), 0, 1);
  const y1 = clamp(Math.min(value.y1, value.y2), 0, 1);
  const x2 = clamp(Math.max(value.x1, value.x2), 0, 1);
  const y2 = clamp(Math.max(value.y1, value.y2), 0, 1);
  if (x2 - x1 <= 0.005 || y2 - y1 <= 0.005 || (x2 - x1) * (y2 - y1) > 0.25) return undefined;
  return { id: "finishPad", label: "Finish Pad Review Area", x1, y1, x2, y2 };
}

export function finishReviewWindow(center: number, duration: number, startSignal?: number | null) {
  if (!Number.isFinite(center) || !Number.isFinite(duration) || duration <= 0 || center < 0 || center >= duration ||
      (startSignal != null && (!Number.isFinite(startSignal) || startSignal < 0 || startSignal >= duration))) return undefined;
  const start = Math.max(startSignal ?? 0, center - 1.25, 0);
  const end = Math.min(duration - 0.001, center + 1.25);
  return end - start >= 0.2 ? { start, end } : undefined;
}

export function finishReviewCrop(zone?: NormalizedZone): NormalizedZone {
  if (!zone) return { id: "finishPad", label: "Upper-wall overview", x1: 0.2, x2: 0.8, y1: 0, y2: 0.35 };
  const padX = Math.max(0.025, (zone.x2 - zone.x1) * 0.6);
  const padY = Math.max(0.025, (zone.y2 - zone.y1) * 0.6);
  return { ...zone, x1: Math.max(0, zone.x1 - padX), x2: Math.min(1, zone.x2 + padX),
    y1: Math.max(0, zone.y1 - padY), y2: Math.min(1, zone.y2 + padY) };
}

export function captureFinishReviewFrame(video: HTMLVideoElement, zone: NormalizedZone, maxSize = 480): FinishReviewFrame {
  if (video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("Pause and wait for the video frame.");
  const rect = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight, "cover");
  const scale = Math.min(1, maxSize / Math.max(rect.width, rect.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Finish close-up is unavailable in this browser.");
  context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  const decoded = readDecodedVideoFrameTime(video);
  return { cursorTime: video.currentTime, rawTime: decoded?.mediaTime ?? video.currentTime,
    timeSource: decoded ? "decoded-frame" : "cursor", imageUrl: canvas.toDataURL("image/jpeg", 0.88) };
}

/** Exposure-centered pixel change is a navigation aid, not contact evidence. */
export function finishPadChange(before: Uint8ClampedArray, after: Uint8ClampedArray): number {
  if (!before.length || before.length !== after.length || before.length % 4) return 0;
  const differences: number[] = [];
  for (let i = 0; i < before.length; i += 4) differences.push(
    ((after[i] - before[i]) + (after[i + 1] - before[i + 1]) + (after[i + 2] - before[i + 2])) / 3);
  const sorted = [...differences].sort((a, b) => a - b);
  const exposure = sorted[Math.floor(sorted.length / 2)];
  return differences.reduce((sum, value) => sum + Math.abs(value - exposure), 0) / differences.length;
}

export async function scanFinishPadReview(options: {
  video: HTMLVideoElement; zone: NormalizedZone; center: number; startSignal?: number | null;
  signal?: AbortSignal; onProgress?: (message: string) => void;
}): Promise<FinishReviewScan> {
  const { video, signal } = options;
  const zone = normalizeFinishPadZone(options.zone);
  const window = finishReviewWindow(options.center, video.duration, options.startSignal);
  if (!zone || !window) throw new Error("Mark a small pad area and choose a review time after Start.");
  const source = video.src;
  const check = () => { if (signal?.aborted || video.src !== source) throw new Error("Finish rescan cancelled. Accepted timing was kept."); };
  const rect = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight, "cover");
  const canvas = document.createElement("canvas");
  canvas.width = 48; canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Finish rescan canvas is unavailable.");
  const times = sampleFramesInRange(window.start, window.end, 15);
  const samples: Array<{ cursorTime: number; rawTime: number; key: string; score: number }> = [];
  const seen = new Set<string>();
  let nativeTimedFrames = 0;
  let previous: Uint8ClampedArray | undefined;
  for (let index = 0; index < times.length; index += 1) {
    check(); await seekTo(video, times[index]); check();
    const decoded = readDecodedVideoFrameTime(video);
    const key = decoded ? `frame:${decoded.mediaTime}` : `cursor:${video.currentTime}`;
    if (!seen.has(key)) {
      context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, 48, 48);
      const data = context.getImageData(0, 0, 48, 48).data;
      samples.push({ cursorTime: video.currentTime, rawTime: decoded?.mediaTime ?? video.currentTime,
        key, score: previous ? finishPadChange(previous, data) : 0 });
      previous = data; seen.add(key);
      if (decoded) nativeTimedFrames += 1;
    }
    options.onProgress?.(`Inspecting marked pad: ${index + 1}/${times.length} frames…`);
    if (index % 6 === 5) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (samples.length < 3) throw new Error("Too few distinct frames to compare. Try a longer or higher-frame-rate recording.");
  const peak = samples.reduce((best, sample, index) => sample.score > samples[best].score ? index : best, 0);
  const hasChange = samples[peak].score >= 4;
  const centerIndex = hasChange ? peak : Math.floor(samples.length / 2);
  const first = Math.max(0, Math.min(samples.length - 5, centerIndex - 2));
  const frames: FinishReviewFrame[] = [];
  for (const sample of samples.slice(first, first + 5)) {
    check(); await seekTo(video, sample.cursorTime); check();
    const frame = captureFinishReviewFrame(video, finishReviewCrop(zone), 320);
    if (frame.timeSource !== "decoded-frame" || !frames.some(other => other.timeSource === "decoded-frame" && other.rawTime === frame.rawTime)) frames.push(frame);
  }
  return { ...window, sampledFrames: times.length, comparedFrames: samples.length, nativeTimedFrames, frames,
    suggestedRawTime: hasChange ? samples[peak].rawTime : undefined,
    reason: hasChange
      ? "Largest local appearance change in the marked area. It may be an approaching hand, contact, a shadow or camera movement. Inspect the full video; no finish was accepted."
      : "No clear local appearance change in this window. Nearby frames are shown for manual inspection; no finish was accepted." };
}
