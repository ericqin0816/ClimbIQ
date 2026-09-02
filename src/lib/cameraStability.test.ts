import { describe, expect, it } from "vitest";
import { assessCameraStability, type CameraStabilityFrame } from "./cameraStability";

type MutableFrame = Omit<CameraStabilityFrame, "data"> & { data: Uint8ClampedArray };

describe("fixed-camera stability audit", () => {
  it("keeps an unchanged detailed wall stable", () => {
    const frame = patternedFrame();
    const result = assessCameraStability(frame, clone(frame));
    expect(result.assessable).toBe(true);
    expect(result.stable).toBe(true);
    expect(result.shiftXNormalized).toBe(0);
    expect(result.shiftYNormalized).toBe(0);
  });

  it("detects a global camera pan", () => {
    const first = patternedFrame();
    const last = translate(first, 4, -3);
    const result = assessCameraStability(first, last);
    expect(result.assessable).toBe(true);
    expect(result.stable).toBe(false);
    expect(Math.hypot(result.shiftXNormalized, result.shiftYNormalized)).toBeGreaterThan(0.03);
  });

  it("ignores a local moving athlete-sized foreground block", () => {
    const first = patternedFrame();
    const last = clone(first);
    fill(last, 32, 50, 17, 23, 230);
    const result = assessCameraStability(first, last);
    expect(result.assessable).toBe(true);
    expect(result.stable).toBe(true);
  });

  it("is insensitive to a frame-wide exposure offset", () => {
    const first = patternedFrame();
    const last = clone(first);
    for (let index = 0; index < last.data.length; index += 4) {
      last.data[index] = Math.min(255, last.data[index] + 25);
      last.data[index + 1] = Math.min(255, last.data[index + 1] + 25);
      last.data[index + 2] = Math.min(255, last.data[index + 2] + 25);
    }
    expect(assessCameraStability(first, last).stable).toBe(true);
  });

  it("reports a blank scene as unassessable", () => {
    const frame = solidFrame(96, 144, 80);
    const result = assessCameraStability(frame, clone(frame));
    expect(result.assessable).toBe(false);
    expect(result.confidence).toBe("None");
  });
});

function patternedFrame(width = 96, height = 144): MutableFrame {
  const frame = solidFrame(width, height, 72);
  for (let y = 8; y < height - 8; y += 13) fill(frame, 5, y, width - 10, 3, 170);
  for (let x = 9; x < width - 9; x += 17) fill(frame, x, 4, 3, height - 8, 125);
  for (let y = 15; y < height - 10; y += 24) {
    for (let x = 15; x < width - 10; x += 28) fill(frame, x, y, 7, 6, 215);
  }
  return frame;
}

function solidFrame(width: number, height: number, value: number): MutableFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function clone(frame: CameraStabilityFrame): MutableFrame {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
}

function translate(frame: CameraStabilityFrame, dx: number, dy: number): MutableFrame {
  const moved = solidFrame(frame.width, frame.height, 72);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const targetX = x + dx;
      const targetY = y + dy;
      if (targetX < 0 || targetX >= frame.width || targetY < 0 || targetY >= frame.height) continue;
      const source = (y * frame.width + x) * 4;
      const target = (targetY * frame.width + targetX) * 4;
      moved.data[target] = frame.data[source];
      moved.data[target + 1] = frame.data[source + 1];
      moved.data[target + 2] = frame.data[source + 2];
    }
  }
  return moved;
}

function fill(frame: MutableFrame, x: number, y: number, width: number, height: number, value: number): void {
  for (let py = Math.max(0, y); py < Math.min(frame.height, y + height); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(frame.width, x + width); px += 1) {
      const offset = (py * frame.width + px) * 4;
      frame.data[offset] = value;
      frame.data[offset + 1] = value;
      frame.data[offset + 2] = value;
      frame.data[offset + 3] = 255;
    }
  }
}
