import { describe, expect, it } from "vitest";
import type { RGB, StartSignalDebug } from "../types";
import { computeColorDistance } from "./videoFrameSampler";
import {
  adaptCalibrationToSampledZone,
  findVerifiedGreenDeparture,
  type RequiredCalibration,
} from "./detectStartSignal";

const GREEN: RGB = { r: 20, g: 210, b: 24 };
const BLUE: RGB = { r: 20, g: 38, b: 220 };
const CALIBRATION: RequiredCalibration = {
  beforeStartRGB: GREEN,
  afterStartRGB: BLUE,
  colorDelta: computeColorDistance(GREEN, BLUE),
};

describe("calibrated green-departure timing", () => {
  it("marks the first intermediate frame and uses later blue only as verification", () => {
    const samples = makeSamples([
      GREEN,
      GREEN,
      GREEN,
      { r: 20, g: 190, b: 45 },
      { r: 20, g: 135, b: 105 },
      BLUE,
      BLUE,
      BLUE,
    ]);

    const result = findVerifiedGreenDeparture(samples, CALIBRATION, 2);
    expect(result?.onsetIndex).toBe(3);
    expect(result?.confirmationIndex).toBe(5);
  });

  it("ignores a one-frame departure that returns to green before the real change", () => {
    const samples = makeSamples([
      GREEN,
      GREEN,
      { r: 20, g: 175, b: 58 },
      GREEN,
      GREEN,
      BLUE,
      BLUE,
      BLUE,
    ]);

    const result = findVerifiedGreenDeparture(samples, CALIBRATION, 2);
    expect(result?.onsetIndex).toBe(5);
  });

  it("keeps the initial baseline clean during a long gradual fade", () => {
    const colors: RGB[] = Array.from({ length: 30 }, (_, index) => {
      if (index < 5) {
        return GREEN;
      }
      if (index >= 25) {
        return BLUE;
      }
      const progress = (index - 4) / 21;
      return {
        r: Math.round(GREEN.r + (BLUE.r - GREEN.r) * progress),
        g: Math.round(GREEN.g + (BLUE.g - GREEN.g) * progress),
        b: Math.round(GREEN.b + (BLUE.b - GREEN.b) * progress),
      };
    });

    const result = findVerifiedGreenDeparture(makeSamples(colors), CALIBRATION, 2);
    expect(result).toBeDefined();
    expect(result!.onsetIndex).toBeLessThanOrEqual(7);
    expect(result!.confirmationIndex).toBeGreaterThan(result!.onsetIndex);
  });

  it("does not invent a start across seeded green-state sensor noise", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = seededRandom(seed);
      const colors = Array.from({ length: 36 }, (_, index) =>
        jitter(GREEN, random, 6, Math.round(Math.sin(index / 6) * 8)),
      );
      expect(findVerifiedGreenDeparture(makeSamples(colors), CALIBRATION, 2), `seed ${seed}`).toBeUndefined();
    }
  });

  it("keeps finding a sustained blue transition across seeded sensor noise", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seededRandom(seed * 31);
      const colors = [
        ...Array.from({ length: 12 }, () => jitter(GREEN, random, 5)),
        ...Array.from({ length: 16 }, () => jitter(BLUE, random, 5)),
      ];
      const result = findVerifiedGreenDeparture(makeSamples(colors), CALIBRATION, 2);
      expect(result, `seed ${seed}`).toBeDefined();
      expect(result!.onsetIndex, `seed ${seed}`).toBeGreaterThanOrEqual(11);
      expect(result!.onsetIndex, `seed ${seed}`).toBeLessThanOrEqual(12);
    }
  });
});

describe("sampled-zone calibration adaptation", () => {
  it("keeps the discovered calibration when absolute opponent sampling collapses its signed span", () => {
    const discovered: RequiredCalibration & {
      calibrationFrameBeforeTime: number;
      calibrationFrameAfterTime: number;
    } = {
      beforeStartRGB: { r: 55, g: 67, b: 52 },
      afterStartRGB: { r: 64, g: 63, b: 116 },
      colorDelta: 66,
      calibrationFrameBeforeTime: 1,
      calibrationFrameAfterTime: 2,
    };
    const poisonedSamples = makeSamplesAtTimes([
      [0.8, { r: 58, g: 50, b: 113 }],
      [0.9, { r: 58, g: 50, b: 113 }],
      [1.0, { r: 58, g: 50, b: 113 }],
      [2.0, { r: 68, g: 55, b: 125 }],
      [2.1, { r: 68, g: 55, b: 125 }],
      [2.2, { r: 68, g: 55, b: 125 }],
    ]);

    expect(adaptCalibrationToSampledZone(poisonedSamples, discovered)).toEqual(discovered);
  });
});

function makeSamples(colors: RGB[]): StartSignalDebug["samples"] {
  return colors.map((averageRgb, index) => ({
    time: index / 30,
    averageRgb,
    colorDistance: computeColorDistance(averageRgb, GREEN),
    distanceToBefore: computeColorDistance(averageRgb, GREEN),
    distanceToAfter: computeColorDistance(averageRgb, BLUE),
    greenScore: averageRgb.g - Math.max(averageRgb.r, averageRgb.b),
    blueScore: averageRgb.b - Math.max(averageRgb.r, averageRgb.g),
  }));
}

function makeSamplesAtTimes(entries: Array<[number, RGB]>): StartSignalDebug["samples"] {
  return entries.map(([time, averageRgb]) => ({
    time,
    averageRgb,
    colorDistance: 0,
    greenScore: averageRgb.g - Math.max(averageRgb.r, averageRgb.b),
    blueScore: averageRgb.b - Math.max(averageRgb.r, averageRgb.g),
  }));
}

function jitter(color: RGB, random: () => number, amount: number, exposure = 0): RGB {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value + exposure + (random() * 2 - 1) * amount)));
  return { r: channel(color.r), g: channel(color.g), b: channel(color.b) };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
