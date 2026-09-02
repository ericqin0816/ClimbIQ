import { describe, expect, it } from "vitest";
import {
  computeAverageRgb,
  computeDirectionalOpponentWeightedRgb,
  computeOpponentWeightedRgb,
  hasUsableVideoMetadata,
} from "./videoFrameSampler";

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
