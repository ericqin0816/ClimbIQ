import { describe, expect, it } from "vitest";
import {
  buildWallCalibration,
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
});
