import { describe, expect, it } from "vitest";
import type { RGB } from "../types";
import { analyzeGreenBlueFrames, type DownsampledColorFrame } from "./detectAutomaticStartLight";

describe("automatic green-to-blue start light discovery", () => {
  it("finds a stationary sensor and its first sustained color departure", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 }),
    );
    const result = analyzeGreenBlueFrames(frames);

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
    expect(result.confidence).toBe("High");
    expect(result.zone?.x1).toBeLessThan(18 / 24);
    expect(result.zone?.x2).toBeGreaterThanOrEqual(18 / 24);
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

  it("timestamps the first green departure in a gradual fade and verifies blue later", () => {
    const colors: RGB[] = [
      { r: 18, g: 220, b: 24 },
      { r: 18, g: 220, b: 24 },
      { r: 18, g: 220, b: 24 },
      { r: 18, g: 220, b: 24 },
      { r: 18, g: 195, b: 50 },
      { r: 18, g: 120, b: 130 },
      { r: 18, g: 45, b: 225 },
      { r: 18, g: 45, b: 225 },
      { r: 18, g: 45, b: 225 },
      { r: 18, g: 45, b: 225 },
    ];
    const result = analyzeGreenBlueFrames(colors.map((color, index) => frame(index * 0.2, color)));

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
    expect(result.afterTime).toBeGreaterThan(result.transitionTime ?? Infinity);
  });

  it("finds a light that only arms (turns green) partway through the window", () => {
    const frames = Array.from({ length: 14 }, (_, index) => {
      const sensor = index < 4
        ? { r: 70, g: 70, b: 70 }
        : index < 8
          ? { r: 18, g: 220, b: 24 }
          : { r: 18, g: 45, b: 225 };
      return frame(index * 0.2, sensor);
    });
    const result = analyzeGreenBlueFrames(frames);

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(1.6, 6);
    expect(result.calibration?.beforeStartRGB?.g).toBeGreaterThan(result.calibration?.beforeStartRGB?.b ?? 0);
  });

  it("rejects upper-wall color changes because start lights are always near the bottom", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frameAt(index * 0.2, index < 4 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 }, 18, 1, 1),
    );
    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(false);
  });

  it("finds a tiny one-pixel low-saturation lane light", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frameAt(
        index * 0.2,
        index < 4 ? { r: 68, g: 75, b: 69 } : { r: 68, g: 69, b: 76 },
        18,
        8,
        0,
      ),
    );
    const result = analyzeGreenBlueFrames(frames);

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
  });

  it("rejects a full-frame green-to-blue white-balance drift", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      uniformFrame(index * 0.2, index < 4 ? { r: 60, g: 75, b: 60 } : { r: 60, g: 60, b: 78 }),
    );
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
  });

  it("retains a faint local light during a smaller frame-wide color drift", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frameWithBackground(
        index * 0.2,
        index < 4 ? { r: 68, g: 75, b: 69 } : { r: 68, g: 69, b: 76 },
        index < 4 ? { r: 70, g: 72, b: 70 } : { r: 70, g: 70, b: 73 },
      ),
    );
    expect(analyzeGreenBlueFrames(frames).found).toBe(true);
  });

  it("uses the exact audio time to prefer a faint real lane over a later stronger change", () => {
    const frames = Array.from({ length: 14 }, (_, index) => dualTimedFrame(index * 0.2, index));
    const result = analyzeGreenBlueFrames(frames, { expectedStartTime: 0.8 });

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
  });

  it("rejects a blue object that remains briefly and then leaves", () => {
    const frames = Array.from({ length: 16 }, (_, index) => {
      const color = index < 4
        ? { r: 18, g: 220, b: 24 }
        : index < 11
          ? { r: 18, g: 45, b: 225 }
          : { r: 70, g: 70, b: 70 };
      return frame(index * 0.2, color);
    });
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
  });

  it("keeps a real start state even when the lane light reverses at the later finish", () => {
    const frames = Array.from({ length: 24 }, (_, index) => {
      const color = index < 4 || index >= 18
        ? { r: 48, g: 72, b: 50 }
        : { r: 48, g: 50, b: 78 };
      return frame(index * 0.2, color);
    });

    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
  });

  it("does not backdate a later real light to an earlier blue-clothing transient", () => {
    const frames = Array.from({ length: 14 }, (_, index) => {
      const color = index < 4
        ? { r: 48, g: 72, b: 50 }
        : index === 4
          ? { r: 35, g: 38, b: 115 }
          : index < 8
            ? { r: 48, g: 72, b: 50 }
            : { r: 48, g: 50, b: 78 };
      return frame(index * 0.2, color);
    });

    const result = analyzeGreenBlueFrames(frames);
    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(1.6, 6);
  });

  it("keeps a cue-aligned green-to-blue sensor when it is covered later", () => {
    const frames = Array.from({ length: 16 }, (_, index) => {
      const color = index < 4
        ? { r: 48, g: 63, b: 50 }
        : index < 8
          ? { r: 48, g: 50, b: 66 }
          : { r: 10, g: 10, b: 10 };
      return frame(index * 0.2, color);
    });
    const result = analyzeGreenBlueFrames(frames, { expectedStartTime: 0.8 });

    expect(result.found).toBe(true);
    expect(result.transitionTime).toBeCloseTo(0.8, 6);
    expect(result.laneCandidates?.[0].lightVisibility).toBe("blocked");
  });

  it("still rejects a cue-aligned blue transient that returns to green", () => {
    const frames = Array.from({ length: 16 }, (_, index) => {
      const color = index < 4 || index >= 8
        ? { r: 48, g: 63, b: 50 }
        : { r: 48, g: 50, b: 66 };
      return frame(index * 0.2, color);
    });

    expect(analyzeGreenBlueFrames(frames, { expectedStartTime: 0.8 }).found).toBe(false);
  });

  it("rejects a dark occlusion that merely becomes blue-dominant", () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      frame(index * 0.2, index < 4 ? { r: 40, g: 80, b: 50 } : { r: 8, g: 9, b: 12 }),
    );
    expect(analyzeGreenBlueFrames(frames).found).toBe(false);
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
  return frameAt(time, sensor, 18, 10, 3);
}

function uniformFrame(time: number, color: RGB): DownsampledColorFrame {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color.r;
    data[index + 1] = color.g;
    data[index + 2] = color.b;
    data[index + 3] = 255;
  }
  return { time, width, height, data };
}

function frameWithBackground(time: number, sensor: RGB, background: RGB): DownsampledColorFrame {
  const result = frameAt(time, sensor, 18, 8, 0);
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      if (x === 18 && y === 8) {
        continue;
      }
      const index = (y * result.width + x) * 4;
      result.data[index] = background.r;
      result.data[index + 1] = background.g;
      result.data[index + 2] = background.b;
    }
  }
  return result;
}

function dualTimedFrame(time: number, frameIndex: number): DownsampledColorFrame {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      let color: RGB = { r: 70, g: 70, b: 70 };
      if (x === 18 && y === 8) {
        color = frameIndex < 4 ? { r: 68, g: 75, b: 69 } : { r: 68, g: 69, b: 76 };
      } else if (Math.abs(x - 6) <= 1 && Math.abs(y - 8) <= 1) {
        color = frameIndex < 7 ? { r: 18, g: 220, b: 24 } : { r: 18, g: 45, b: 225 };
      }
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = 255;
    }
  }
  return { time, width, height, data };
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
      const onSensor = (Math.abs(x - 6) <= 1 || Math.abs(x - 18) <= 1) && Math.abs(y - 10) <= 1;
      const color = onSensor ? sensor : { r: 70, g: 70, b: 70 };
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = 255;
    }
  }
  return { time, width, height, data };
}
