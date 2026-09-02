import { describe, expect, it } from "vitest";
import type { RGB, StartLightCalibration } from "../types";
import {
  analyzeTopFinishColorSamples,
  analyzeTopFinishFrames,
  analyzeTopContactFrames,
  requireUpperFinishCorroboration,
  type TopFinishColorSample,
  type TopFinishFrame,
} from "./detectTopFinishSignal";

const darkRed: RGB = { r: 88, g: 24, b: 23 };
const brightGreen: RGB = { r: 34, g: 142, b: 48 };

describe("perspective-aware upper finish indicator", () => {
  it("finds a persistent tiny top light even when the upper lane shifts inward", () => {
    const frames = makeFrames([
      ...repeat(darkRed, 8),
      ...repeat(brightGreen, 12),
    ], { x: 12, y: 2 });

    const result = analyzeTopFinishFrames(frames, 0.82);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.6, 3);
    expect(result.zone?.id).toBe("finishLight");
  });

  it("rejects a short upper-wall occlusion and keeps the later settled light", () => {
    const skin = { r: 150, g: 92, b: 66 };
    const frames = makeFrames([
      ...repeat(darkRed, 7),
      skin,
      skin,
      ...repeat(darkRed, 5),
      ...repeat(brightGreen, 10),
    ], { x: 12, y: 2 });

    const result = analyzeTopFinishFrames(frames, 0.8);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.8, 3);
  });

  it("removes frame-wide exposure changes from localized light scoring", () => {
    const frames = makeFrames(repeat(darkRed, 18), { x: 12, y: 2 }, (index) => index < 8 ? 0 : 35);
    expect(analyzeTopFinishFrames(frames, 0.8).found).toBe(false);
  });

  it("rejects a persistent finish-like color when a foreground person covers the frame", () => {
    const frames = makeFrames([
      ...repeat(darkRed, 8),
      ...repeat(brightGreen, 10),
    ], { x: 12, y: 2 });
    for (let frameIndex = 8; frameIndex < frames.length; frameIndex += 1) {
      for (let index = 0; index < frames[frameIndex].data.length; index += 4) {
        frames[frameIndex].data[index] = 158;
        frames[frameIndex].data[index + 1] = 92;
        frames[frameIndex].data[index + 2] = 70;
      }
    }

    expect(analyzeTopFinishFrames(frames, 0.8).found).toBe(false);
  });

  it("refines the first faint connected transition at 30 fps", () => {
    const calibration: StartLightCalibration = {
      beforeStartRGB: darkRed,
      afterStartRGB: brightGreen,
      colorDelta: 150,
    };
    const faint = mix(darkRed, brightGreen, 0.12);
    const samples: TopFinishColorSample[] = [
      ...repeat(darkRed, 12),
      faint,
      faint,
      mix(darkRed, brightGreen, 0.55),
      ...repeat(brightGreen, 16),
    ].map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeTopFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
    expect(result.confidence).toBe("High");
  });

  it("timestamps a physical top reach only when a descent follows", () => {
    const result = analyzeTopContactFrames(makeContactFrames([8, 7, 5, 3, 2, 2, 4, 6]), 0.8);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(1, 3);
    expect(result.confidence).toBe("Medium");
    expect(result.candidates[0].kind).toBe("Physical top contact");
  });

  it("does not call an upper-wall appearance a finish without downward reversal", () => {
    const result = analyzeTopContactFrames(makeContactFrames([8, 7, 5, 3, 2, 2, 2, 2]), 0.8);
    expect(result.found).toBe(false);
  });

  it("rejects a finish-like trajectory after the camera cuts away from the start view", () => {
    const laterCamera = makeContactFrames([8, 7, 5, 3, 2, 2, 4, 6]);
    // The trajectory is plausible when evaluated inside only the cropped later
    // shot, which is exactly why the post-start camera reference is required.
    expect(analyzeTopContactFrames(laterCamera, 0.8).found).toBe(true);

    const anchoredAcrossCut = [makeDifferentCameraFrame(), ...laterCamera.slice(1)];
    const result = analyzeTopContactFrames(anchoredAcrossCut, 0.8);
    expect(result.found).toBe(false);
    expect(result.reason).toContain("continuous, occlusion-free");
  });

  it("downgrades an isolated high-confidence upper light to frame review", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: false });
    expect(result.confidence).toBe("Medium");
    expect(result.reason).toContain("not independently corroborated");
    expect(result.candidates?.[0].confidence).toBe("Medium");
  });

  it("keeps a high upper light when physical top contact agrees", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: true, rawTime: 13.7 });
    expect(result.confidence).toBe("High");
  });

  it("keeps a high upper light when an official total agrees", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: false }, 14.31);
    expect(result.confidence).toBe("High");
  });

  it("does not let a much earlier physical event corroborate a late timer reset", () => {
    const result = requireUpperFinishCorroboration(finishResult(20), { found: true, rawTime: 14.2 });
    expect(result.confidence).toBe("Medium");
  });
});

function finishResult(rawTime: number) {
  return {
    detected: true,
    rawTime,
    confidence: "High" as const,
    reason: "Upper light changed.",
    threshold: 1,
    candidates: [{
      rawTime,
      confidence: "High" as const,
      reason: "Upper light changed.",
      score: 10,
      kind: "Upper light",
    }],
    debug: {
      zoneExists: true,
      framesSampled: 20,
      maxColorDistance: 50,
      threshold: 1,
      detectedCrossings: [{ time: rawTime, colorDistance: 50 }],
      samples: [],
    },
  };
}

function makeFrames(
  indicatorColors: RGB[],
  indicator: { x: number; y: number },
  exposureShift: (index: number) => number = () => 0,
): TopFinishFrame[] {
  const width = 20;
  const height = 20;
  return indicatorColors.map((indicatorColor, frameIndex) => {
    const shift = exposureShift(frameIndex);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 54 + shift;
      data[index + 1] = 55 + shift;
      data[index + 2] = 57 + shift;
      data[index + 3] = 255;
    }
    for (let y = indicator.y; y <= indicator.y + 1; y += 1) {
      for (let x = indicator.x; x <= indicator.x + 1; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = indicatorColor.r + shift;
        data[offset + 1] = indicatorColor.g + shift;
        data[offset + 2] = indicatorColor.b + shift;
      }
    }
    return { time: frameIndex / 5, width, height, data };
  });
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

function makeContactFrames(topRows: number[]): TopFinishFrame[] {
  const width = 30;
  const height = 30;
  const background = { r: 62, g: 64, b: 66 };
  const makeFrame = (time: number, topRow?: number): TopFinishFrame => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = background.r;
      data[index + 1] = background.g;
      data[index + 2] = background.b;
      data[index + 3] = 255;
    }
    if (topRow !== undefined) {
      for (let y = topRow; y < Math.min(height, topRow + 4); y += 1) {
        for (let x = 20; x < 24; x += 1) {
          const offset = (y * width + x) * 4;
          data[offset] = 25;
          data[offset + 1] = 118;
          data[offset + 2] = 178;
        }
      }
    }
    return { time, width, height, data };
  };
  return [makeFrame(0), ...topRows.map((row, index) => makeFrame((index + 1) / 5, row))];
}

function makeDifferentCameraFrame(): TopFinishFrame {
  const width = 30;
  const height = 30;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = (x + y) % 2 === 0 ? 18 : 190;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { time: 0, width, height, data };
}
