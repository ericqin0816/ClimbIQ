import { describe, expect, it } from "vitest";
import {
  buildWallCalibration,
  inferAutomaticWallCalibration,
  projectImagePointToWall,
  validateWallCalibration,
} from "./wallCalibration";

describe("wall calibration", () => {
  it("maps a full-frame rectangle onto the 3 m by 15 m wall", () => {
    const calibration = buildWallCalibration([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ], 1.25, true);
    const validation = validateWallCalibration(calibration);

    expect(validation.valid).toBe(true);
    expect(validation.matrix).toBeDefined();
    expect(projectImagePointToWall({ x: 0.5, y: 0.5 }, validation.matrix!)).toEqual({
      xMeters: 1.5,
      yMeters: 7.5,
    });
  });

  it("solves a perspective-shaped lane and reprojects every corner", () => {
    const calibration = buildWallCalibration([
      { x: 0.08, y: 0.94 },
      { x: 0.91, y: 0.87 },
      { x: 0.76, y: 0.08 },
      { x: 0.22, y: 0.13 },
    ], 2, true);
    const validation = validateWallCalibration(calibration);

    expect(validation.valid).toBe(true);
    calibration.corners.forEach((corner) => {
      const projected = projectImagePointToWall(corner.image, validation.matrix!);
      expect(projected.xMeters).toBeCloseTo(corner.wall.xMeters, 8);
      expect(projected.yMeters).toBeCloseTo(corner.wall.yMeters, 8);
    });
  });

  it("rejects duplicated, crossed, or unconfirmed corners", () => {
    const duplicate = buildWallCalibration([
      { x: 0.1, y: 0.9 },
      { x: 0.1, y: 0.9 },
      { x: 0.8, y: 0.1 },
      { x: 0.2, y: 0.1 },
    ], 0, true);
    expect(validateWallCalibration(duplicate).valid).toBe(false);

    const crossed = buildWallCalibration([
      { x: 0.1, y: 0.9 },
      { x: 0.8, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.2, y: 0.1 },
    ], 0, true);
    expect(validateWallCalibration(crossed).valid).toBe(false);

    const unconfirmed = buildWallCalibration([
      { x: 0.1, y: 0.9 },
      { x: 0.9, y: 0.9 },
      { x: 0.8, y: 0.1 },
      { x: 0.2, y: 0.1 },
    ], 0, false);
    expect(validateWallCalibration(unconfirmed).valid).toBe(false);
  });

  it("infers the selected lane from timing lights and the wall-to-mat edge", () => {
    const imageData = syntheticSpeedWallFrame(240, 426, 0.16, 0.84);
    const result = inferAutomaticWallCalibration({
      imageData,
      frameRawTime: 9.4,
      identityZone: {
        id: "startBody",
        label: "Automatic lane start-body region",
        x1: 0.12,
        y1: 0.58,
        x2: 0.43,
        y2: 0.8,
      },
    });

    expect(result.calibration).toBeDefined();
    expect(result.confidence).toBe("Medium");
    expect(result.calibration?.source).toBe("automatic-approximate");
    expect(result.diagnostics?.selectedLane).toBe("left");
    expect(result.diagnostics?.topY).toBeGreaterThan(0.1);
    expect(result.diagnostics?.topY).toBeLessThan(0.18);
    expect(result.diagnostics?.bottomY).toBeGreaterThan(0.79);
    expect(result.diagnostics?.bottomY).toBeLessThan(0.85);
    expect(validateWallCalibration(result.calibration).valid).toBe(true);
  });

  it("refuses automatic metric calibration when the full wall is not visible", () => {
    const imageData = syntheticSpeedWallFrame(240, 426, 0.5, 0.84);
    const result = inferAutomaticWallCalibration({
      imageData,
      frameRawTime: 1,
      identityZone: {
        id: "startBody",
        label: "Start Body Zone",
        x1: 0.58,
        y1: 0.65,
        x2: 0.88,
        y2: 0.82,
      },
    });

    expect(result.calibration).toBeUndefined();
    expect(result.reason).toContain("complete 15 m wall");
  });

  it("ignores an isolated saturated ceiling fringe across image resolutions", () => {
    for (const width of [240, 360, 720, 1080]) {
      const imageData = syntheticSpeedWallFrame(width, Math.round(width * 16 / 9), 0.16, 0.84);
      const identityZone = { id: "startBody" as const, label: "Athlete", x1: 0.58, x2: 0.84, y1: 0.62, y2: 0.82 };
      const baseline = inferAutomaticWallCalibration({ imageData, frameRawTime: 7, identityZone });
      paintNormalizedRectangle(imageData, 0.754, 0.04, 0.768, 0.06, [230, 75, 40]);
      const result = inferAutomaticWallCalibration({ imageData, frameRawTime: 7, identityZone });
      expect(result.calibration).toBeDefined();
      expect(result.diagnostics?.topY).toBe(baseline.diagnostics?.topY);
      expect(result.diagnostics?.selectedLane).toBe("right");
      expect(result.calibration?.corners).toEqual(baseline.calibration?.corners);
    }
  });

  it("does not weight the lane divider toward a larger clock", () => {
    const imageData = syntheticSpeedWallFrame(720, 1280, 0.16, 0.84);
    paintNormalizedRectangle(imageData, 0.1, 0.16, 0.9, 0.2, [112, 110, 106]);
    paintNormalizedRectangle(imageData, 0.345, 0.172, 0.355, 0.19, [240, 25, 25]);
    paintNormalizedRectangle(imageData, 0.625, 0.172, 0.675, 0.19, [240, 25, 25]);
    const result = inferAutomaticWallCalibration({ imageData, frameRawTime: 7,
      identityZone: { id: "startBody", label: "Athlete", x1: 0.53, x2: 0.6, y1: 0.62, y2: 0.82 } });
    expect(result.calibration).toBeDefined();
    expect(result.diagnostics?.selectedLane).toBe("right");
    const divider = result.calibration?.corners.find(corner => corner.id === "topLeft")?.image.x;
    expect(divider).toBeCloseTo(0.5, 2);
  });

  it("does not infer two lanes from only one visible upper marker", () => {
    const imageData = syntheticSpeedWallFrame(240, 426, 0.16, 0.84);
    paintNormalizedRectangle(imageData, 0.1, 0.16, 0.9, 0.2, [112, 110, 106]);
    paintNormalizedRectangle(imageData, 0.62, 0.17, 0.66, 0.19, [240, 25, 25]);
    const result = inferAutomaticWallCalibration({ imageData, frameRawTime: 7,
      identityZone: { id: "startBody", label: "Athlete", x1: 0.58, x2: 0.84, y1: 0.62, y2: 0.82 } });
    expect(result.calibration).toBeUndefined();
    expect(result.reason).toContain("upper timing-light edge");
  });

  it("requires manual corners when an oblique inferred lane includes off-wall room", () => {
    const imageData = syntheticSpeedWallFrame(240, 426, 0.16, 0.84);
    paintNormalizedRectangle(imageData, 0.66, 0.16, 1, 0.84, [232, 240, 246]);

    const result = inferAutomaticWallCalibration({
      imageData,
      frameRawTime: 10,
      identityZone: {
        id: "startBody",
        label: "Oblique right lane",
        x1: 0.67,
        y1: 0.62,
        x2: 0.88,
        y2: 0.86,
      },
    });

    expect(result.calibration).toBeUndefined();
    expect(result.confidence).toBe("Low");
    expect(result.reason).toContain("oblique view needs four manual lane corners");
    expect(result.diagnostics?.wallSurfaceSupport).toBeLessThan(0.86);
  });
});

function syntheticSpeedWallFrame(width: number, height: number, topY: number, bottomY: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const normalizedY = y / height;
      const color = normalizedY < topY
        ? [180, 180, 180]
        : normalizedY < bottomY
          ? [112, 110, 106]
          : [20, 20, 22];
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  for (const centerX of [0.32, 0.44, 0.58, 0.7]) {
    for (let y = Math.round((topY + 0.012) * height); y < Math.round((topY + 0.03) * height); y += 1) {
      for (let x = Math.round((centerX - 0.008) * width); x <= Math.round((centerX + 0.008) * width); x += 1) {
        const offset = (y * width + x) * 4;
        const green = centerX === 0.32 || centerX === 0.58;
        data[offset] = green ? 25 : 240;
        data[offset + 1] = green ? 220 : 25;
        data[offset + 2] = 25;
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function paintNormalizedRectangle(
  image: ImageData,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: [number, number, number],
): void {
  const left = Math.max(0, Math.floor(x1 * image.width));
  const top = Math.max(0, Math.floor(y1 * image.height));
  const right = Math.min(image.width, Math.ceil(x2 * image.width));
  const bottom = Math.min(image.height, Math.ceil(y2 * image.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
    }
  }
}
