import type { FrameSample, NormalizedZone, RGB, ZonePixelRect } from "../types";

const SEEK_EPSILON_SECONDS = 0.004;

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && Number.isFinite(video.duration) && video.videoWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    const onLoaded = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Video metadata failed to load."));
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
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
  const captured = captureFrame(video);
  const pixelZone = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight);
  const imageData = captured.context.getImageData(pixelZone.x, pixelZone.y, pixelZone.width, pixelZone.height);

  return {
    time: video.currentTime,
    averageRgb: computeAverageRgb(imageData),
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
  const captured = captureFrame(video);
  const pixelZone = normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight);
  const imageData = captured.context.getImageData(pixelZone.x, pixelZone.y, pixelZone.width, pixelZone.height);
  return { imageData, pixelZone };
}

export function roundTime(time: number): number {
  return Math.round(time * 1000) / 1000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
