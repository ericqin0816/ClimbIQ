import { describe, expect, it } from "vitest";
import { buildWallCalibration, projectImagePointToWall, validateWallCalibration } from "./wallCalibration";
import {
  findNearestStandardSpeedHold,
  findNearestStandardSpeedHoldFromImage,
  getStandardSpeedHold,
  getWallToImageHomography,
  projectStandardSpeedHoldToImage,
  projectStandardSpeedRouteToImage,
  projectWallPointWithHomography,
  STANDARD_SPEED_HOLD_IDS,
  STANDARD_SPEED_HOLDS,
  STANDARD_SPEED_ROUTE_TEMPLATE,
} from "./standardSpeedRoute";

describe("standardized 20-hold speed route template", () => {
  it("contains exactly IDs 1 through 20 in strictly ascending wall order", () => {
    expect(STANDARD_SPEED_HOLDS).toHaveLength(20);
    expect(STANDARD_SPEED_HOLDS.map((hold) => hold.id)).toEqual([...STANDARD_SPEED_HOLD_IDS]);
    for (let index = 1; index < STANDARD_SPEED_HOLDS.length; index += 1) {
      expect(STANDARD_SPEED_HOLDS[index].wall.yMeters)
        .toBeGreaterThan(STANDARD_SPEED_HOLDS[index - 1].wall.yMeters);
    }
  });

  it("keeps every digitized hold inside the standardized wall", () => {
    for (const hold of STANDARD_SPEED_HOLDS) {
      expect(hold.normalizedWall.x).toBeGreaterThanOrEqual(0);
      expect(hold.normalizedWall.x).toBeLessThanOrEqual(1);
      expect(hold.normalizedWall.y).toBeGreaterThanOrEqual(0);
      expect(hold.normalizedWall.y).toBeLessThanOrEqual(1);
      expect(hold.wall.xMeters).toBeCloseTo(hold.normalizedWall.x * 3, 10);
      expect(hold.wall.yMeters).toBeCloseTo(hold.normalizedWall.y * 15, 10);
    }
  });

  it("preserves the diagram's Hold 10 reference and labels its provenance approximate", () => {
    const hold10 = getStandardSpeedHold(10);

    expect(hold10.sourcePixelCenter).toEqual({ x: 175.356, y: 235.967 });
    expect(hold10.normalizedWall.x).toBeCloseTo(0.46637, 5);
    expect(hold10.normalizedWall.y).toBeCloseTo(0.55562, 5);
    expect(hold10.wall.xMeters).toBeCloseTo(1.399, 3);
    expect(hold10.wall.yMeters).toBeCloseTo(8.334, 3);
    expect(STANDARD_SPEED_ROUTE_TEMPLATE.status).toBe("approximate-digitized");
    expect(STANDARD_SPEED_ROUTE_TEMPLATE.provenance.limitation).toContain("not surveyed or official");
  });

  it("projects every route hold into a rectangular lane", () => {
    const calibration = buildWallCalibration([
      { x: 0.2, y: 0.9 },
      { x: 0.8, y: 0.9 },
      { x: 0.8, y: 0.1 },
      { x: 0.2, y: 0.1 },
    ], 0, true);
    const projected = projectStandardSpeedRouteToImage(calibration);

    expect(projected).toHaveLength(20);
    for (const { hold, image } of projected) {
      expect(image.x).toBeCloseTo(0.2 + hold.normalizedWall.x * 0.6, 8);
      expect(image.y).toBeCloseTo(0.9 - hold.normalizedWall.y * 0.8, 8);
    }
  });

  it("round-trips Hold 10 through a perspective calibration", () => {
    const calibration = buildWallCalibration([
      { x: 0.08, y: 0.94 },
      { x: 0.91, y: 0.87 },
      { x: 0.76, y: 0.08 },
      { x: 0.22, y: 0.13 },
    ], 2, true);
    const hold10 = getStandardSpeedHold(10);
    const image = projectStandardSpeedHoldToImage(10, calibration);
    const validation = validateWallCalibration(calibration);

    expect(image.x).toBeGreaterThan(0);
    expect(image.x).toBeLessThan(1);
    expect(image.y).toBeGreaterThan(0);
    expect(image.y).toBeLessThan(1);
    expect(projectImagePointToWall(image, validation.matrix!).xMeters).toBeCloseTo(hold10.wall.xMeters, 8);
    expect(projectImagePointToWall(image, validation.matrix!).yMeters).toBeCloseTo(hold10.wall.yMeters, 8);

    const precomputed = getWallToImageHomography(calibration);
    expect(projectWallPointWithHomography(hold10.wall, precomputed)).toEqual(image);
  });

  it("finds the nearest hold in wall and image coordinates with an optional distance gate", () => {
    const hold10 = getStandardSpeedHold(10);
    const nearby = {
      xMeters: hold10.wall.xMeters + 0.03,
      yMeters: hold10.wall.yMeters - 0.04,
    };
    expect(findNearestStandardSpeedHold(nearby)).toMatchObject({
      hold: { id: 10 },
      distanceMeters: expect.closeTo(0.05, 8),
    });
    expect(findNearestStandardSpeedHold(nearby, 0.049)).toBeUndefined();

    const calibration = buildWallCalibration([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ], 0, true);
    const image = projectStandardSpeedHoldToImage(10, calibration);
    expect(findNearestStandardSpeedHoldFromImage(image, calibration, 0.001)?.hold.id).toBe(10);
  });
});
