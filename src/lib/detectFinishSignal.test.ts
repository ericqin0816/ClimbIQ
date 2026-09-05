import { describe, expect, it } from "vitest";
import type { RGB, StartLightCalibration } from "../types";
import { analyzeFinishColorSamples, resolveFinishRefinement, type FinishColorSample } from "./detectFinishSignal";

const green: RGB = { r: 70, g: 92, b: 58 };
const blue: RGB = { r: 70, g: 62, b: 105 };
const calibration: StartLightCalibration = {
  beforeStartRGB: green,
  afterStartRGB: blue,
  colorDelta: 55,
};

describe("same-lane automatic finish detection", () => {
  it("does not mistake a red-dominant obstruction for a green return lamp", () => {
    const darkCalibration = {
      beforeStartRGB: { r: 28, g: 37, b: 33 },
      afterStartRGB: { r: 12, g: 11, b: 20 },
      colorDelta: 33.181,
    };
    const during = { r: 48, g: 49, b: 58 };
    // Recorded red-dominant pixels from the darkened angled-video failure.
    const obstruction = [{ r: 83, g: 32, b: 5 }, { r: 146, g: 76, b: 63 }];
    const samples = seriesAtFps([...repeat(during, 8), ...obstruction, ...repeat(during, 12)], 5);
    expect(analyzeFinishColorSamples(samples, darkCalibration).detected).toBe(false);
  });

  it("can still detect the real green return after a red obstruction clears", () => {
    const samples = seriesAtFps([
      ...repeat(blue, 8), ...repeat({ r: 150, g: 90, b: 30 }, 3),
      ...repeat(blue, 5), ...repeat(green, 10),
    ], 5);
    expect(analyzeFinishColorSamples(samples, calibration).rawTime).toBeCloseTo(3.2);
  });

  it("requires review when the dense scan cannot confirm a coarse-only reversal", () => {
    const coarse = analyzeFinishColorSamples(series([...repeat(blue, 8), ...repeat(green, 12)]), calibration);
    const missing = analyzeFinishColorSamples(series(repeat(blue, 20)), calibration);
    expect(coarse.confidence).toBe("High");
    const result = resolveFinishRefinement(coarse, missing);
    expect(result.rawTime).toBe(coarse.rawTime);
    expect(result.confidence).toBe("Medium");
    expect(result.reason).toContain("finer scan did not confirm");
    expect(result.candidates.every(candidate => candidate.confidence !== "High")).toBe(true);
    expect(resolveFinishRefinement(coarse, coarse)).toBe(coarse);
  });

  it("timestamps the first persistent blue-to-green reversal", () => {
    const samples = series([
      ...repeat(blue, 10),
      { r: 70, g: 73, b: 91 },
      { r: 70, g: 82, b: 75 },
      ...repeat(green, 12),
    ]);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(1, 6);
    expect(result.confidence).toBe("High");
  });

  it("learns the reversal direction instead of hard-coding a color order", () => {
    const reverseCalibration: StartLightCalibration = {
      beforeStartRGB: blue,
      afterStartRGB: green,
      colorDelta: 55,
    };
    const samples = series([...repeat(green, 8), ...repeat(blue, 10)]);
    const result = analyzeFinishColorSamples(samples, reverseCalibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.8, 6);
  });

  it("also supports a sensor that is green during the climb and turns blue at finish", () => {
    const samples = series([...repeat(green, 8), ...repeat(blue, 10)]);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.8, 6);
  });

  it("rejects a brief opposite-color flicker", () => {
    const samples = series([
      ...repeat(blue, 8),
      green,
      blue,
      ...repeat(blue, 10),
    ]);
    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("timestamps the first green flash and uses the later settled green state as verification", () => {
    const samples = series([
      ...repeat(blue, 8),
      green,
      blue,
      green,
      blue,
      green,
      green,
      green,
      green,
      green,
    ]);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.8, 6);
    expect(result.confidence).toBe("High");
  });

  it("backtracks from a strong reversal to its connected faint precursor", () => {
    const faintGreen = mix(blue, green, 0.06);
    const clearGreen = mix(blue, green, 0.32);
    const samples = seriesAtFps([
      ...repeat(blue, 10),
      faintGreen,
      faintGreen,
      faintGreen,
      clearGreen,
      ...repeat(green, 14),
    ], 30);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(10 / 30, 3);
  });

  it("backtracks across one blue flash to the earliest sustained faint precursor", () => {
    const faintGreen = mix(blue, green, 0.06);
    const intermediateGreen = mix(blue, green, 0.24);
    const clearGreen = mix(blue, green, 0.58);
    const samples = seriesAtFps([
      ...repeat(blue, 12),
      faintGreen,
      faintGreen,
      blue,
      faintGreen,
      intermediateGreen,
      clearGreen,
      ...repeat(green, 12),
    ], 30);

    const result = analyzeFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
    expect(result.reason).toContain("first return-color flash");
  });

  it("bridges one brief dark occlusion inside a faint-to-solid finish sequence", () => {
    const faintGreen = mix(blue, green, 0.07);
    const intermediateGreen = mix(blue, green, 0.3);
    const samples = seriesAtFps([
      ...repeat(blue, 12),
      faintGreen,
      faintGreen,
      { r: 4, g: 4, b: 4 },
      faintGreen,
      intermediateGreen,
      ...repeat(green, 12),
    ], 30);

    const result = analyzeFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
  });

  it("does not attach old faint noise to a later real reversal", () => {
    const faintGreen = mix(blue, green, 0.07);
    const samples = seriesAtFps([
      ...repeat(blue, 10),
      faintGreen,
      ...repeat(blue, 7),
      ...repeat(green, 12),
    ], 30);

    const result = analyzeFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(18 / 30, 3);
  });

  it("does not backtrack through a disconnected faint flicker", () => {
    const faintGreen = mix(blue, green, 0.06);
    const samples = series([
      ...repeat(blue, 7),
      faintGreen,
      blue,
      blue,
      ...repeat(green, 8),
    ]);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(1, 6);
  });

  it("does not attach an isolated old flash to a later real finish", () => {
    const samples = series([
      ...repeat(blue, 6),
      green,
      ...repeat(blue, 5),
      ...repeat(green, 8),
    ]);
    const result = analyzeFinishColorSamples(samples, calibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.2, 6);
  });

  it("rejects flashing that never settles into the returned state", () => {
    const samples = series([
      ...repeat(blue, 8),
      green,
      blue,
      green,
      blue,
      green,
      ...repeat(blue, 8),
    ]);
    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("rejects exposure drift that does not reverse opponent color", () => {
    const samples = series(Array.from({ length: 20 }, (_, index) => ({
      r: 70 + index,
      g: 62 + index,
      b: 105 + index,
    })));
    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("rejects a sustained neutral occlusion instead of calling it the returned light color", () => {
    const samples = series([...repeat(blue, 8), ...repeat({ r: 190, g: 190, b: 190 }, 10)]);
    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("rejects mostly neutral occlusion with only two unconfirmed green noise frames", () => {
    const neutral = { r: 105, g: 105, b: 105 };
    const samples = series([
      ...repeat(blue, 9),
      ...repeat(neutral, 4),
      green,
      green,
      ...repeat(neutral, 6),
    ]);

    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("rejects a sustained dark occlusion", () => {
    const samples = series([...repeat(blue, 8), ...repeat({ r: 5, g: 5, b: 5 }, 10)]);
    expect(analyzeFinishColorSamples(samples, calibration).detected).toBe(false);
  });

  it("keeps official time as a cross-check and still selects the first visual reversal", () => {
    const samples = series([
      ...repeat(blue, 5),
      ...repeat(green, 6),
      ...repeat(blue, 6),
      ...repeat(green, 8),
    ]);
    const result = analyzeFinishColorSamples(samples, calibration, 1.7);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.5, 6);
  });

  it("rejects an isolated early full-color flicker and selects the connected later finish", () => {
    const samples = series([
      ...repeat(blue, 8),
      green,
      ...repeat(blue, 4),
      ...repeat(green, 9),
    ]);

    const result = analyzeFinishColorSamples(samples, calibration, 0.8);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.3, 6);
  });

  it("keeps the first genuine finish when a later duplicate transition is closer to official time", () => {
    const samples = series([
      ...repeat(blue, 7),
      ...repeat(green, 6),
      ...repeat(blue, 5),
      ...repeat(green, 8),
    ]);

    const result = analyzeFinishColorSamples(samples, calibration, 1.8);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.7, 6);
    expect(result.candidates[0].rawTime).toBeCloseTo(0.7, 6);
  });

  it("recognizes the return color from directional pixels while the zone average stays blue", () => {
    const faintGreen = mix(blue, green, 0.08);
    const intermediateGreen = mix(blue, green, 0.35);
    const colors = [
      ...repeat(blue, 12),
      faintGreen,
      faintGreen,
      intermediateGreen,
      ...repeat(green, 12),
    ];
    const samples = colors.map((directionalRgb, index) => ({
      time: index / 30,
      averageRgb: blue,
      directionalRgb,
    }));

    const result = analyzeFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
  });

  it("connects one missed flash at the 5 fps discovery rate", () => {
    const samples = seriesAtFps([
      ...repeat(blue, 6),
      green,
      blue,
      ...repeat(green, 7),
    ], 5);

    const result = analyzeFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.2, 6);
  });

  it("accepts an opponent-color reversal despite a strong exposure and red-channel shift", () => {
    const shiftedCalibration: StartLightCalibration = {
      beforeStartRGB: { r: 61, g: 69, b: 61 },
      afterStartRGB: { r: 72, g: 67, b: 96 },
      colorDelta: 39,
    };
    const samples = series([
      ...repeat({ r: 72, g: 38, b: 73 }, 8),
      { r: 81, g: 47, b: 54 },
      ...repeat({ r: 88, g: 83, b: 72 }, 9),
    ]);
    const result = analyzeFinishColorSamples(samples, shiftedCalibration);
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(0.8, 6);
  });

  it("does not invent a finish across seeded climb-state color and exposure noise", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const random = seededRandom(seed);
      const noisyBlue = Array.from({ length: 32 }, (_, index) => {
        const exposure = Math.round(Math.sin(index / 5) * 7);
        return jitter(blue, random, 5, exposure);
      });
      expect(analyzeFinishColorSamples(seriesAtFps(noisyBlue, 10), calibration).detected, `seed ${seed}`).toBe(false);
    }
  });

  it("keeps detecting a sustained reversal across seeded sensor noise", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const random = seededRandom(seed * 17);
      const colors = [
        ...Array.from({ length: 12 }, () => jitter(blue, random, 4)),
        ...Array.from({ length: 16 }, () => jitter(green, random, 4)),
      ];
      const result = analyzeFinishColorSamples(seriesAtFps(colors, 10), calibration);
      expect(result.detected, `seed ${seed}: ${result.reason}`).toBe(true);
      expect(result.rawTime, `seed ${seed}`).toBeCloseTo(1.2, 1);
    }
  });
});

function series(colors: RGB[]): FinishColorSample[] {
  return seriesAtFps(colors, 10);
}

function seriesAtFps(colors: RGB[], fps: number): FinishColorSample[] {
  return colors.map((averageRgb, index) => ({ time: index / fps, averageRgb }));
}

function repeat(color: RGB, count: number): RGB[] {
  return Array.from({ length: count }, () => ({ ...color }));
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
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
