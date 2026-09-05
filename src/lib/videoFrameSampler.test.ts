import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeAverageRgb,
  computeDirectionalOpponentWeightedRgb,
  computeOpponentWeightedRgb,
  hasUsableVideoMetadata,
  captureFrame,
  captureVideoPixels,
  seekTo,
  sampleFramesInRange,
} from "./videoFrameSampler";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded frame sampling plans", () => {
  it("preserves normal frame grids", () => {
    expect(sampleFramesInRange(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
  it("refuses nonfinite and non-progressing ranges", () => {
    for (const values of [[0, Infinity, 30], [Infinity, Infinity, 30], [0, 1, Infinity], [NaN, 1, 30], [1e20, 1e20, 30], [0, 1, Number.MIN_VALUE]]) {
      expect(sampleFramesInRange(...values as [number, number, number])).toEqual([]);
    }
  });
  it("refuses excessive allocations instead of truncating the requested scan", () => {
    expect(sampleFramesInRange(0, 1_000_000, 30)).toEqual([]);
  });
});

describe("video seek readiness", () => {
  it("does not treat a matching cursor as decoded while a seek is still active", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout });
    const video = Object.assign(new EventTarget(), {
      currentTime: 2, duration: 20, videoWidth: 720, videoHeight: 1280, readyState: 2, seeking: true,
    }) as unknown as HTMLVideoElement;
    let finished = false;
    const pending = seekTo(video, 2).then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    video.dispatchEvent(new Event("seeked")); await pending;
    expect(finished).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects invalid seek times before creating listeners or timers", async () => {
    for (const time of [NaN, Infinity, -Infinity]) {
      await expect(seekTo({} as HTMLVideoElement, time)).rejects.toThrow("must be finite");
    }
  });
});

describe("pixel-only frame capture", () => {
  it("does not encode discarded PNGs for analysis callers", () => {
    const pixels = tinySensorImage({ r: 48, g: 76, b: 49 });
    const context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => "data:image/png;base64,test") };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const video = { videoWidth: 10, videoHeight: 10 } as HTMLVideoElement;
    expect(captureVideoPixels(video).imageData).toBe(pixels);
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(captureFrame(video).dataUrl).toBe("data:image/png;base64,test");
    expect(canvas.toDataURL).toHaveBeenCalledExactlyOnceWith("image/png");
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 10, 10);
  });
  it("retains the metadata and missing-canvas failures", () => {
    expect(() => captureVideoPixels({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toThrow("before video metadata");
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(() => captureVideoPixels({ videoWidth: 10, videoHeight: 10 } as HTMLVideoElement)).toThrow("Canvas 2D context");
  });
});

describe("opponent-color zone sampling", () => {
  it("preserves a tiny green sensor that full-crop averaging nearly erases", () => {
    const image = tinySensorImage({ r: 48, g: 76, b: 49 });
    const average = computeAverageRgb(image);
    const opponent = computeOpponentWeightedRgb(image);

    expect(opponent.g - opponent.b).toBeGreaterThan(average.g - average.b);
    expect(opponent.g).toBeGreaterThan(opponent.b);
  });

  it("preserves the same tiny sensor after it changes to blue", () => {
    const opponent = computeOpponentWeightedRgb(tinySensorImage({ r: 48, g: 49, b: 77 }));
    expect(opponent.b).toBeGreaterThan(opponent.g);
  });

  it("finds a faint green return even when brighter residual blue pixels remain", () => {
    const image = mixedSensorImage();
    const absolute = computeOpponentWeightedRgb(image);
    const towardGreen = computeDirectionalOpponentWeightedRgb(image, 1);

    expect(absolute.b).toBeGreaterThan(absolute.g);
    expect(towardGreen.g).toBeGreaterThan(towardGreen.b);
  });
});

describe("video metadata readiness", () => {
  it("requires finite positive duration and both video dimensions", () => {
    expect(hasUsableVideoMetadata({ readyState: 1, duration: 20, videoWidth: 1080, videoHeight: 1920 })).toBe(true);
    expect(hasUsableVideoMetadata({ readyState: 1, duration: Number.POSITIVE_INFINITY, videoWidth: 1080, videoHeight: 1920 })).toBe(false);
    expect(hasUsableVideoMetadata({ readyState: 1, duration: 20, videoWidth: 1080, videoHeight: 0 })).toBe(false);
    expect(hasUsableVideoMetadata({ readyState: 0, duration: 20, videoWidth: 1080, videoHeight: 1920 })).toBe(false);
  });
});

function tinySensorImage(sensor: { r: number; g: number; b: number }): ImageData {
  const width = 10;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 60;
    data[index + 1] = 60;
    data[index + 2] = 60;
    data[index + 3] = 255;
  }
  for (const pixel of [44, 45]) {
    const index = pixel * 4;
    data[index] = sensor.r;
    data[index + 1] = sensor.g;
    data[index + 2] = sensor.b;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function mixedSensorImage(): ImageData {
  const width = 10;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const color = pixel < 14
      ? { r: 50, g: 42, b: 135 }
      : pixel < 28
        ? { r: 52, g: 72, b: 55 }
        : { r: 65, g: 65, b: 65 };
    data[index] = color.r;
    data[index + 1] = color.g;
    data[index + 2] = color.b;
    data[index + 3] = 255;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
