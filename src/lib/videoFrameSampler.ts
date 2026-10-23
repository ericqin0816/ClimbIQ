import type { FrameSample, NormalizedZone, RGB, ZonePixelRect } from "../types";
import { readDecodedVideoFrameTime, type DecodedVideoFrameTime } from "./decodedVideoFrame";

const SEEK_EPSILON_SECONDS = 0.004;
const MAX_UNOBSERVED_TAIL_SECONDS = 0.15;

export interface PartialSourceObservation {
  requestedTime: number;
  observedThroughTime: number;
  lastFrameRawTime: number;
  lastFrameDurationSeconds: number;
  containerDuration: number;
  reason: string;
  isEventAccuracyBound: false;
}

class DecodedFrameNotReadyError extends Error {
  constructor(readonly source: string, readonly cursorTime: number,
    readonly mediaTime: number, readonly durationSeconds: number) {
    super("Decoded video frame did not catch up to the seek cursor.");
    this.name = "DecodedFrameNotReadyError";
  }
}

/** Strict seeking remains the default. A finish scan may explicitly salvage a
 * bounded container tail by re-seeking INSIDE an exposed native interval. This
 * proves only that interval's pixels, never the requested tail or track end.
 */
export async function seekToFrameObservation(video: HTMLVideoElement, time: number, options?: {
  exact?: boolean; allowUnobservedTail?: boolean; signal?: AbortSignal;
}): Promise<{ requestedTime: number; cursorTime: number; decoded?: DecodedVideoFrameTime;
  partialSourceObservation?: PartialSourceObservation }> {
  const source = video.src;
  const check = () => {
    if (options?.signal?.aborted || video.src !== source) {
      const error = new Error("Video frame observation cancelled.");
      error.name = "AbortError";
      throw error;
    }
  };
  check();
  try {
    await seekTo(video, time, { exact: options?.exact });
  } catch (error) {
    check();
    if (!options?.allowUnobservedTail || !(error instanceof DecodedFrameNotReadyError)) throw error;
    const { mediaTime, durationSeconds, cursorTime } = error;
    const observedThroughTime = mediaTime + durationSeconds;
    // These bounds limit salvage, not a claim that this is the final video
    // frame. Interior stale frames and larger missing regions still fail.
    if (error.source !== source || Math.abs(video.currentTime - cursorTime) > 1e-7 ||
      time > video.duration || video.duration - cursorTime > MAX_UNOBSERVED_TAIL_SECONDS ||
      video.duration - observedThroughTime > MAX_UNOBSERVED_TAIL_SECONDS ||
      durationSeconds < 0.0001 || cursorTime < observedThroughTime + 0.005 ||
      cursorTime - observedThroughTime > MAX_UNOBSERVED_TAIL_SECONDS ||
      observedThroughTime >= video.duration) throw error;
    const inside = mediaTime + durationSeconds / 2;
    await seekTo(video, inside, { exact: true });
    check();
    const decoded = readDecodedVideoFrameTime(video);
    if (!decoded || decoded.durationSeconds === undefined ||
      Math.abs(decoded.mediaTime - mediaTime) > 0.000001 ||
      Math.abs(decoded.durationSeconds - durationSeconds) > 0.000001 ||
      video.currentTime < decoded.mediaTime || video.currentTime >= decoded.mediaTime + decoded.durationSeconds) {
      throw new Error("The exposed tail frame could not be independently re-seeked inside its native interval.");
    }
    return { requestedTime: time, cursorTime: video.currentTime, decoded,
      partialSourceObservation: {
        requestedTime: time, observedThroughTime, lastFrameRawTime: decoded.mediaTime,
        lastFrameDurationSeconds: decoded.durationSeconds, containerDuration: video.duration,
        reason: `The requested container tail at ${time.toFixed(3)}s was not observed. Native pixels were verified only through ${observedThroughTime.toFixed(6)}s; the final video-track boundary is unknown. Finish requires frame review.`,
        isEventAccuracyBound: false,
      } };
  }
  check();
  return { requestedTime: time, cursorTime: video.currentTime, decoded: readDecodedVideoFrameTime(video) };
}
// One private crop surface per decoder. No frames, URLs or sampling decisions
// are retained, and the surface becomes collectible with its video element.
const zoneSurfaces = new WeakMap<HTMLVideoElement, { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }>();

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (hasUsableVideoMetadata(video)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Video metadata timed out."));
    }, 10000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    const onLoaded = () => {
      cleanup();
      if (hasUsableVideoMetadata(video)) resolve();
      else reject(new Error("Video metadata is incomplete or has an invalid duration."));
    };

    const onError = () => {
      cleanup();
      reject(new Error("Video metadata failed to load."));
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

export function hasUsableVideoMetadata(
  video: Pick<HTMLVideoElement, "readyState" | "duration" | "videoWidth" | "videoHeight">,
): boolean {
  return video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0 &&
    video.videoWidth > 0 && video.videoHeight > 0;
}

export async function seekTo(video: HTMLVideoElement, time: number, options?: { exact?: boolean }): Promise<void> {
  if (!Number.isFinite(time)) throw new Error("Video seek time must be finite.");
  await waitForMetadata(video);

  const clampedTime = clamp(time, 0, Math.max(0, video.duration - 0.001));
  const epsilon = options?.exact ? 1e-7 : SEEK_EPSILON_SECONDS;
  if (!video.seeking && Math.abs(video.currentTime - clampedTime) < epsilon && video.readyState >= 2) {
    await waitForDecodedSeek(video);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Seek timed out at ${clampedTime.toFixed(3)}s.`));
      }
    }, 4000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    const onSeeked = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onError = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Video seek failed at ${clampedTime.toFixed(3)}s.`));
      }
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = clampedTime;
  });
  await waitForDecodedSeek(video);
}

/** Some decoders dispatch seeked while their previous native frame is still
 * exposed. Do not calibrate or sample that stale image at the new cursor.
 * Missing WebCodecs/duration keeps the existing explicit timing fallback.
 */
export async function waitForDecodedSeek(video: HTMLVideoElement): Promise<void> {
  if (typeof globalThis.VideoFrame !== "function" || !video.src) return;
  const source = video.src, cursor = video.currentTime;
  const deadline = Date.now() + 200;
  while (true) {
    if (video.src !== source || Math.abs(video.currentTime - cursor) > 1e-7) {
      const error = new Error("Video changed during decoded-frame readiness check.");
      error.name = "AbortError";
      throw error;
    }
    let frame: VideoFrame;
    try { frame = new VideoFrame(video); } catch { return; }
    let ready: boolean;
    let observedTime: number;
    let observedDuration: number;
    try {
      const timestamp = frame.timestamp / 1e6;
      const duration = frame.duration === null ? undefined : frame.duration / 1e6;
      if (!Number.isFinite(timestamp) || timestamp < 0 || duration === undefined ||
          !Number.isFinite(duration) || duration <= 0 || duration > 1) return;
      observedTime = timestamp;
      observedDuration = duration;
      // VFR metadata can end a few milliseconds before the next PTS. The
      // native walker resolves those small gaps with deduplicated forward seeks.
      ready = timestamp <= cursor + 0.0001 && cursor < timestamp + duration + 0.005;
    } finally { frame.close(); }
    if (ready) return;
    if (Date.now() >= deadline) throw new DecodedFrameNotReadyError(source, cursor, observedTime, observedDuration);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

export function captureVideoPixels(video: HTMLVideoElement): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
} {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    throw new Error("Cannot capture a frame before video metadata is loaded.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  context.drawImage(video, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);

  return {
    canvas,
    context,
    imageData,
  };
}

/** Encode an image only for callers that actually display or export it. */
export function captureFrame(video: HTMLVideoElement): ReturnType<typeof captureVideoPixels> & { dataUrl: string } {
  const pixels = captureVideoPixels(video);
  return { ...pixels, dataUrl: pixels.canvas.toDataURL("image/png") };
}

export async function sampleFrameAt(video: HTMLVideoElement, time: number): Promise<FrameSample> {
  try {
    await seekTo(video, time);
    const captured = captureVideoPixels(video);
    return {
      requestedTime: time,
      actualTime: video.currentTime,
      averageRgb: computeAverageRgb(captured.imageData),
      success: true,
    };
  } catch (error) {
    return {
      requestedTime: time,
      actualTime: video.currentTime,
      averageRgb: { r: 0, g: 0, b: 0 },
      success: false,
      error: error instanceof Error ? error.message : "Unknown frame sampling error.",
    };
  }
}

export async function sampleZoneAverageColor(
  video: HTMLVideoElement,
  time: number,
  zone: NormalizedZone,
  pixelBounds: "extent" | "cover" = "extent",
): Promise<{ time: number; averageRgb: RGB; pixelZone: ZonePixelRect }> {
  await seekTo(video, time);
  const { imageData, pixelZone } = captureZoneImageData(video, zone, pixelBounds);

  return {
    time: video.currentTime,
    averageRgb: computeAverageRgb(imageData),
    pixelZone,
  };
}

/**
 * Samples the pixels carrying the strongest green-vs-blue opponent signal.
 * Automatic lane sensors are often only a few pixels inside a mostly gray crop;
 * averaging the entire crop erases them before calibrated refinement begins.
 */
export async function sampleZoneOpponentColor(
  video: HTMLVideoElement,
  time: number,
  zone: NormalizedZone,
): Promise<{ time: number; averageRgb: RGB; pixelZone: ZonePixelRect }> {
  await seekTo(video, time);
  const { imageData, pixelZone } = captureZoneImageData(video, zone);
  return {
    time: video.currentTime,
    averageRgb: computeOpponentWeightedRgb(imageData),
    pixelZone,
  };
}

/**
 * Captures one crop and returns both the strongest absolute green/blue pixels
 * and pixels ranked toward a requested opponent-color direction. Finish lights
 * can contain residual bright blue pixels during their first faint green flash;
 * an absolute-only rank keeps selecting those old blue pixels and hides onset.
 */
export async function sampleZoneOpponentColors(
  video: HTMLVideoElement,
  time: number,
  zone: NormalizedZone,
  targetDirection: number,
): Promise<{ time: number; averageRgb: RGB; directionalRgb: RGB; pixelZone: ZonePixelRect }> {
  await seekTo(video, time);
  const { imageData, pixelZone } = captureZoneImageData(video, zone);
  return {
    time: video.currentTime,
    averageRgb: computeOpponentWeightedRgb(imageData),
    directionalRgb: computeDirectionalOpponentWeightedRgb(imageData, targetDirection),
    pixelZone,
  };
}

export async function sampleZoneMotion(
  video: HTMLVideoElement,
  timeA: number,
  timeB: number,
  zone: NormalizedZone,
): Promise<{ time: number; motionScore: number; pixelZone: ZonePixelRect }> {
  await seekTo(video, timeA);
  const frameA = captureZoneImageData(video, zone);
  await seekTo(video, timeB);
  const frameB = captureZoneImageData(video, zone);

  return {
    time: video.currentTime,
    motionScore: computeMotionScore(frameA.imageData, frameB.imageData),
    pixelZone: frameB.pixelZone,
  };
}

export function sampleFramesInRange(start: number, end: number, fps: number): number[] {
  if (![start, end, fps].every(Number.isFinite) || end < start || fps <= 0) {
    return [];
  }

  const step = 1 / fps;
  // Invalid/imported ranges must not create an infinite UI-thread loop or an
  // unbounded allocation. Refuse instead of silently truncating a video scan.
  if (!Number.isFinite(step) || start + step <= start || (end - start) * fps > 100_000) return [];
  const times: number[] = [];
  for (let time = start; time <= end + step * 0.25; time += step) {
    times.push(roundTime(time));
  }
  return times;
}

export function normalizedZoneToPixelRect(
  zone: NormalizedZone,
  width: number,
  height: number,
  pixelBounds: "extent" | "cover" = "extent",
): ZonePixelRect {
  const left = clamp(Math.min(zone.x1, zone.x2), 0, 1);
  const top = clamp(Math.min(zone.y1, zone.y2), 0, 1);
  const right = clamp(Math.max(zone.x1, zone.x2), 0, 1);
  const bottom = clamp(Math.max(zone.y1, zone.y2), 0, 1);

  // Existing calibrated sensors depend on extent-based crops. Keep that
  // sampling contract unless a caller explicitly requests edge coverage.
  // Broadly changing their pixel membership requires separate validation.
  if (pixelBounds === "extent") {
    const x = Math.floor(left * width);
    const y = Math.floor(top * height);
    return {
      x: clamp(x, 0, Math.max(0, width - 1)),
      y: clamp(y, 0, Math.max(0, height - 1)),
      width: Math.min(Math.max(1, Math.ceil((right - left) * width)), width - x),
      height: Math.min(Math.max(1, Math.ceil((bottom - top) * height)), height - y),
    };
  }

  // Convert edges independently: ceil((right-left)*width) can both include
  // an extra pixel through roundoff and omit a genuinely fractional right
  // edge. Snap only machine-precision noise around integer pixel boundaries.
  const snapPixelEdge = (value: number) => {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8 ? nearest : value;
  };
  const x = clamp(Math.floor(snapPixelEdge(left * width)), 0, Math.max(0, width - 1));
  const y = clamp(Math.floor(snapPixelEdge(top * height)), 0, Math.max(0, height - 1));
  const pixelWidth = Math.max(1, Math.ceil(snapPixelEdge(right * width)) - x);
  const pixelHeight = Math.max(1, Math.ceil(snapPixelEdge(bottom * height)) - y);

  return {
    x,
    y,
    width: Math.min(pixelWidth, width - x),
    height: Math.min(pixelHeight, height - y),
  };
}

export function computeAverageRgb(imageData: ImageData): RGB {
  const { data } = imageData;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let index = 0; index < data.length; index += 4) {
    r += data[index] ?? 0;
    g += data[index + 1] ?? 0;
    b += data[index + 2] ?? 0;
    count += 1;
  }

  if (count === 0) {
    return { r: 0, g: 0, b: 0 };
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

export function computeOpponentWeightedRgb(imageData: ImageData): RGB {
  const pixels: Array<{ score: number; r: number; g: number; b: number }> = [];
  for (let index = 0; index < imageData.data.length; index += 4) {
    const r = imageData.data[index] ?? 0;
    const g = imageData.data[index + 1] ?? 0;
    const b = imageData.data[index + 2] ?? 0;
    const total = Math.max(1, r + g + b);
    const opponent = Math.abs(g - b) / total;
    const brightnessWeight = 0.35 + 0.65 * Math.sqrt(total / 765);
    pixels.push({ score: opponent * brightnessWeight, r, g, b });
  }
  if (!pixels.length) {
    return { r: 0, g: 0, b: 0 };
  }
  pixels.sort((left, right) => right.score - left.score);
  const selectedCount = Math.min(64, Math.max(2, Math.ceil(pixels.length * 0.12)));
  const selected = pixels.slice(0, selectedCount);
  return {
    r: Math.round(selected.reduce((sum, pixel) => sum + pixel.r, 0) / selected.length),
    g: Math.round(selected.reduce((sum, pixel) => sum + pixel.g, 0) / selected.length),
    b: Math.round(selected.reduce((sum, pixel) => sum + pixel.b, 0) / selected.length),
  };
}

/** Selects the sensor pixels that point most strongly toward green (+1) or blue (-1). */
export function computeDirectionalOpponentWeightedRgb(imageData: ImageData, targetDirection: number): RGB {
  const direction = Math.sign(targetDirection) || 1;
  const pixels: Array<{ score: number; r: number; g: number; b: number }> = [];
  for (let index = 0; index < imageData.data.length; index += 4) {
    const r = imageData.data[index] ?? 0;
    const g = imageData.data[index + 1] ?? 0;
    const b = imageData.data[index + 2] ?? 0;
    const total = Math.max(1, r + g + b);
    const opponent = direction * (g - b) / total;
    const brightnessWeight = 0.35 + 0.65 * Math.sqrt(total / 765);
    pixels.push({ score: opponent * brightnessWeight, r, g, b });
  }
  if (!pixels.length) {
    return { r: 0, g: 0, b: 0 };
  }
  pixels.sort((left, right) => right.score - left.score);
  const selectedCount = Math.min(64, Math.max(2, Math.ceil(pixels.length * 0.12)));
  const selected = pixels.slice(0, selectedCount);
  return {
    r: Math.round(selected.reduce((sum, pixel) => sum + pixel.r, 0) / selected.length),
    g: Math.round(selected.reduce((sum, pixel) => sum + pixel.g, 0) / selected.length),
    b: Math.round(selected.reduce((sum, pixel) => sum + pixel.b, 0) / selected.length),
  };
}

export function computeColorDistance(rgb: RGB, baseline: RGB): number {
  return Math.sqrt((rgb.r - baseline.r) ** 2 + (rgb.g - baseline.g) ** 2 + (rgb.b - baseline.b) ** 2);
}

export function computeMotionScore(frameA: ImageData, frameB: ImageData): number {
  const length = Math.min(frameA.data.length, frameB.data.length);
  if (length === 0) {
    return 0;
  }

  let totalDifference = 0;
  let pixelCount = 0;

  for (let index = 0; index < length; index += 4) {
    const dr = Math.abs((frameA.data[index] ?? 0) - (frameB.data[index] ?? 0));
    const dg = Math.abs((frameA.data[index + 1] ?? 0) - (frameB.data[index + 1] ?? 0));
    const db = Math.abs((frameA.data[index + 2] ?? 0) - (frameB.data[index + 2] ?? 0));
    totalDifference += (dr + dg + db) / 3;
    pixelCount += 1;
  }

  return pixelCount > 0 ? totalDifference / pixelCount : 0;
}

export function captureZoneImageData(
  video: HTMLVideoElement,
  zone: NormalizedZone,
  pixelBounds: "extent" | "cover" = "extent",
): { imageData: ImageData; pixelZone: ZonePixelRect } {
  const pixelZone = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight, pixelBounds);
  let surface = zoneSurfaces.get(video);
  if (!surface) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D context is unavailable.");
    surface = { canvas, context };
    zoneSurfaces.set(video, surface);
  }
  const { canvas, context } = surface;
  if (canvas.width !== pixelZone.width) canvas.width = pixelZone.width;
  if (canvas.height !== pixelZone.height) canvas.height = pixelZone.height;
  // A transparent source must never composite over the previous observation.
  context.clearRect(0, 0, pixelZone.width, pixelZone.height);
  context.drawImage(
    video,
    pixelZone.x,
    pixelZone.y,
    pixelZone.width,
    pixelZone.height,
    0,
    0,
    pixelZone.width,
    pixelZone.height,
  );
  const imageData = context.getImageData(0, 0, pixelZone.width, pixelZone.height);
  return { imageData, pixelZone };
}

export function roundTime(time: number): number {
  return Math.round(time * 1000) / 1000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
