import type { FrameSample, NormalizedZone, RGB, ZonePixelRect } from "../types";

const SEEK_EPSILON_SECONDS = 0.004;

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

export async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  await waitForMetadata(video);

  const clampedTime = clamp(time, 0, Math.max(0, video.duration - 0.001));
  if (Math.abs(video.currentTime - clampedTime) < SEEK_EPSILON_SECONDS && video.readyState >= 2) {
    return;
  }

  return new Promise((resolve, reject) => {
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
}

export function captureFrame(video: HTMLVideoElement): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
  dataUrl: string;
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
    dataUrl: canvas.toDataURL("image/png"),
  };
}

export async function sampleFrameAt(video: HTMLVideoElement, time: number): Promise<FrameSample> {
  try {
    await seekTo(video, time);
    const captured = captureFrame(video);
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
): Promise<{ time: number; averageRgb: RGB; pixelZone: ZonePixelRect }> {
  await seekTo(video, time);
  const { imageData, pixelZone } = captureZoneImageData(video, zone);

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
  if (end < start || fps <= 0) {
    return [];
  }

  const step = 1 / fps;
  const times: number[] = [];
  for (let time = start; time <= end + step * 0.25; time += step) {
    times.push(roundTime(time));
  }
  return times;
}

export function normalizedZoneToPixelRect(zone: NormalizedZone, width: number, height: number): ZonePixelRect {
  const left = clamp(Math.min(zone.x1, zone.x2), 0, 1);
  const top = clamp(Math.min(zone.y1, zone.y2), 0, 1);
  const right = clamp(Math.max(zone.x1, zone.x2), 0, 1);
  const bottom = clamp(Math.max(zone.y1, zone.y2), 0, 1);

  const x = Math.floor(left * width);
  const y = Math.floor(top * height);
  const pixelWidth = Math.max(1, Math.ceil((right - left) * width));
  const pixelHeight = Math.max(1, Math.ceil((bottom - top) * height));

  return {
    x: clamp(x, 0, Math.max(0, width - 1)),
    y: clamp(y, 0, Math.max(0, height - 1)),
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
): { imageData: ImageData; pixelZone: ZonePixelRect } {
  const pixelZone = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = pixelZone.width;
  canvas.height = pixelZone.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }
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
