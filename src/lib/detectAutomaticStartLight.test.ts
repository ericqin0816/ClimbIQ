import { describe, expect, it } from "vitest";
import type { RGB } from "../types";
import { analyzeGreenBlueFrames, type DownsampledColorFrame } from "./detectAutomaticStartLight";

describe("automatic green-to-blue start light discovery", () => {
  it("finds a stationary sensor and its first sustained blue frame", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 }),
    );
    const result = analyzeGreenBlueFrames(frames);

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
    expect(result.confidence).toBe("High");
    expect(result.zone?.x1).toBeLessThan(18 / 24);
    expect(result.zone?.x2).toBeGreaterThan(18 / 24);
    expect(result.calibration?.beforeStartRGB?.g).toBeGreaterThan(result.calibration?.beforeStartRGB?.b ?? 0);
    expect(result.calibration?.afterStartRGB?.b).toBeGreaterThan(result.calibration?.afterStartRGB?.g ?? 0);
  });

  it("rejects a light that stays green", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, { r: 18, g: 220, b: 24 }),
    );
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
  });

  it("rejects green-to-red changes", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 225, g: 35, b: 20 }),
    );
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
  });

  it("rejects a brief blue object passing over a green region", () => {
    const frames = Array.from({ length: 12 }, (_, index) => {
      const sensor = index < 4
        ? { r: 18, g: 220, b: 24 }
        : index < 6
          ? { r: 18, g: 45, b: 225 }
          : { r: 90, g: 90, b: 90 };
      return frame(index * 0.2, sensor);
    });
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
  });

  it("finds a faint low-contrast green-to-blue glow", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, index < 4 ? { r: 48, g: 63, b: 50 } : { r: 48, g: 50, b: 66 }),
    );
    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
  });

  it("rejects a green-to-blue change high in the frame, above the start box", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frameAt(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 }, 18, 1, 1),
    );
    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(false);
    expect(result.reason).toContain("upper frame");
  });

  it("prefers the light below the climber's start zone over one further up", () => {
    const frames = Array.from({ length: 12 }, (_, index) => {
      const sensor = index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 };
      return twoSensorFrame(index * 0.2, sensor, { x: 6, y: 6 }, { x: 18, y: 13 });
    });
    const result = analyzeGreenBlueFrames(frames, {
      startBodyZone: { id: "startBody", label: "Start Body Zone", x1: 0.6, y1: 0.45, x2: 0.9, y2: 0.95 },
    });
    expect(result.found).toBe(true);
    expect(((result.zone!.x1 + result.zone!.x2) / 2)).toBeGreaterThan(0.5);
    expect(((result.zone!.y1 + result.zone!.y2) / 2)).toBeGreaterThan(0.5);
  });

  it("keeps spatially separated left and right lane lights as independent evidence", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      multiLaneFrame(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 }),
    );
    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(true);
    expect(result.laneCandidates?.length).toBeGreaterThanOrEqual(2);
    expect(result.laneCandidates?.[0].transitionTime).toBeCloseTo(result.laneCandidates?.[1].transitionTime ?? 0, 6);
  });
});

function frame(time: number, sensor: RGB): DownsampledColorFrame {
  return frameAt(time, sensor, 18, 5, 3);
}

function frameAt(time: number, sensor: RGB, sensorX: number, sensorY: number, sensorRadius: number): DownsampledColorFrame {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const color = Math.abs(x - sensorX) <= sensorRadius && Math.abs(y - sensorY) <= sensorRadius
        ? sensor
        : { r: 70, g: 70, b: 70 };
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = 255;
    }
  }
  return { time, width, height, data };
}

function twoSensorFrame(
  time: number,
  sensor: RGB,
  first: { x: number; y: number },
  second: { x: number; y: number },
): DownsampledColorFrame {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const onSensor = (Math.abs(x - first.x) <= 1 && Math.abs(y - first.y) <= 1) ||
        (Math.abs(x - second.x) <= 1 && Math.abs(y - second.y) <= 1);
      const color = onSensor ? sensor : { r: 70, g: 70, b: 70 };
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = 255;
    }
  }
  return { time, width, height, data };
}

function multiLaneFrame(time: number, sensor: RGB): DownsampledColorFrame {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const onSensor = (Math.abs(x - 6) <= 1 || Math.abs(x - 18) <= 1) && Math.abs(y - 6) <= 1;
      const color = onSensor ? sensor : { r: 70, g: 70, b: 70 };
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = 255;
    }
  }
  return { time, width, height, data };
}
