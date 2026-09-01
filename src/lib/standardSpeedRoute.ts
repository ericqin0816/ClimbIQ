import type { NormalizedPoint, WallCalibration, WallPoint } from "../types";
import {
  projectImagePointToWall,
  type HomographyMatrix,
  validateWallCalibration,
} from "./wallCalibration";

export const STANDARD_SPEED_ROUTE_WALL_WIDTH_METERS = 3;
export const STANDARD_SPEED_ROUTE_WALL_HEIGHT_METERS = 15;

export const STANDARD_SPEED_HOLD_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

export type StandardSpeedHoldId = typeof STANDARD_SPEED_HOLD_IDS[number];

export interface StandardSpeedHold {
  id: StandardSpeedHoldId;
  /** Left-to-right position in the 3 m lane, from 0 to 1. */
  normalizedWall: Readonly<NormalizedPoint>;
  /** Physical wall-plane position, measured from the bottom-left lane corner. */
  wall: Readonly<WallPoint>;
  /** Centroid of the red hold silhouette in the 376 x 531 source diagram. */
  sourcePixelCenter: Readonly<NormalizedPoint>;
}

export interface StandardSpeedRouteTemplate {
  version: 1;
  templateId: "user-speed-route-20-hold-v1";
  routeFamily: "standardized 20-hold speed route";
  status: "approximate-digitized";
  wall: {
    widthMeters: 3;
    heightMeters: 15;
  };
  provenance: {
    source: "user-provided route diagram";
    sourceImageWidthPixels: 376;
    sourceImageHeightPixels: 531;
    method: string;
    limitation: string;
  };
  holds: readonly StandardSpeedHold[];
}

export interface NearestStandardSpeedHoldMatch {
  hold: StandardSpeedHold;
  /** Straight-line distance in the calibrated wall plane. */
  distanceMeters: number;
}

interface DigitizedHoldCenter {
  id: StandardSpeedHoldId;
  /** Source-image pixels, with y increasing downward. */
  x: number;
  y: number;
}

const SOURCE_IMAGE_WIDTH_PIXELS = 376;
const SOURCE_IMAGE_HEIGHT_PIXELS = 531;

/**
 * Red-component centroids digitized from the route diagram supplied for this
 * project. The diagram canvas is treated as the full 3 m x 15 m lane. The
 * values are intentionally tagged approximate rather than claimed as official
 * route-setting measurements.
 */
const DIGITIZED_HOLD_CENTERS: readonly DigitizedHoldCenter[] = [
  { id: 1, x: 222.239, y: 467.533 },
  { id: 2, x: 227.011, y: 458.337 },
  { id: 3, x: 199.196, y: 429.141 },
  { id: 4, x: 171.398, y: 396.925 },
  { id: 5, x: 190.043, y: 368.587 },
  { id: 6, x: 204.215, y: 348.581 },
  { id: 7, x: 189.374, y: 320.593 },
  { id: 8, x: 208.309, y: 286.915 },
  { id: 9, x: 218.308, y: 258.725 },
  { id: 10, x: 175.356, y: 235.967 },
  { id: 11, x: 184.792, y: 211.406 },
  { id: 12, x: 166.359, y: 202.587 },
  { id: 13, x: 189.979, y: 168.552 },
  { id: 14, x: 170.708, y: 146.010 },
  { id: 15, x: 185.227, y: 127.082 },
  { id: 16, x: 180.204, y: 116.452 },
  { id: 17, x: 152.021, y: 92.809 },
  { id: 18, x: 199.196, y: 64.239 },
  { id: 19, x: 217.622, y: 41.078 },
  { id: 20, x: 189.495, y: 26.484 },
];

export const STANDARD_SPEED_HOLDS: readonly StandardSpeedHold[] = Object.freeze(
  DIGITIZED_HOLD_CENTERS.map(({ id, x, y }) => {
    const normalizedWall = Object.freeze({
      x: x / SOURCE_IMAGE_WIDTH_PIXELS,
      y: 1 - y / SOURCE_IMAGE_HEIGHT_PIXELS,
    });
    return Object.freeze({
      id,
      normalizedWall,
      wall: Object.freeze({
        xMeters: normalizedWall.x * STANDARD_SPEED_ROUTE_WALL_WIDTH_METERS,
        yMeters: normalizedWall.y * STANDARD_SPEED_ROUTE_WALL_HEIGHT_METERS,
      }),
      sourcePixelCenter: Object.freeze({ x, y }),
    });
  }),
);

export const STANDARD_SPEED_ROUTE_TEMPLATE: StandardSpeedRouteTemplate = Object.freeze({
  version: 1,
  templateId: "user-speed-route-20-hold-v1",
  routeFamily: "standardized 20-hold speed route",
  status: "approximate-digitized",
  wall: Object.freeze({
    widthMeters: STANDARD_SPEED_ROUTE_WALL_WIDTH_METERS,
    heightMeters: STANDARD_SPEED_ROUTE_WALL_HEIGHT_METERS,
  }),
  provenance: Object.freeze({
    source: "user-provided route diagram",
    sourceImageWidthPixels: SOURCE_IMAGE_WIDTH_PIXELS,
    sourceImageHeightPixels: SOURCE_IMAGE_HEIGHT_PIXELS,
    method: "Centroids of the 20 red hold silhouettes, ordered bottom-to-top, with the full diagram canvas mapped to the 3 m by 15 m lane.",
    limitation: "Coordinates are approximate reference points digitized from a raster diagram, not surveyed or official route-setting coordinates.",
  }),
  holds: STANDARD_SPEED_HOLDS,
});

export function getStandardSpeedHold(id: StandardSpeedHoldId): StandardSpeedHold {
  const hold = STANDARD_SPEED_HOLDS[id - 1];
  if (!hold || hold.id !== id) {
    throw new Error(`Standard speed hold ${id} is unavailable.`);
  }
  return hold;
}

/** Returns the inverse of the calibration's image-to-wall homography. */
export function getWallToImageHomography(calibration: WallCalibration): HomographyMatrix {
  const validation = validateWallCalibration(calibration);
  if (!validation.valid || !validation.matrix) {
    throw new Error(validation.error ?? "Wall calibration is invalid.");
  }
  return invertHomography(validation.matrix);
}

/** Projects a physical wall point into normalized full-video coordinates. */
export function projectWallPointToImage(
  point: WallPoint,
  calibration: WallCalibration,
): NormalizedPoint {
  return projectWallPointWithHomography(point, getWallToImageHomography(calibration));
}

/**
 * Projects a physical wall point with a precomputed wall-to-image matrix.
 * Use this overload when projecting all 20 holds in one pass.
 */
export function projectWallPointWithHomography(
  point: WallPoint,
  wallToImageMatrix: HomographyMatrix,
): NormalizedPoint {
  assertFiniteWallPoint(point);
  const denominator = wallToImageMatrix[6] * point.xMeters +
    wallToImageMatrix[7] * point.yMeters + wallToImageMatrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-10) {
    throw new Error("Wall point lies outside the stable calibration projection.");
  }
  const x = (wallToImageMatrix[0] * point.xMeters +
    wallToImageMatrix[1] * point.yMeters + wallToImageMatrix[2]) / denominator;
  const y = (wallToImageMatrix[3] * point.xMeters +
    wallToImageMatrix[4] * point.yMeters + wallToImageMatrix[5]) / denominator;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Wall-to-image projection produced an invalid coordinate.");
  }
  return { x, y };
}

export function projectStandardSpeedHoldToImage(
  id: StandardSpeedHoldId,
  calibration: WallCalibration,
): NormalizedPoint {
  return projectWallPointToImage(getStandardSpeedHold(id).wall, calibration);
}

export function projectStandardSpeedRouteToImage(
  calibration: WallCalibration,
): Array<{ hold: StandardSpeedHold; image: NormalizedPoint }> {
  const matrix = getWallToImageHomography(calibration);
  return STANDARD_SPEED_HOLDS.map((hold) => ({
    hold,
    image: projectWallPointWithHomography(hold.wall, matrix),
  }));
}

export function findNearestStandardSpeedHold(
  point: WallPoint,
  maximumDistanceMeters = Number.POSITIVE_INFINITY,
): NearestStandardSpeedHoldMatch | undefined {
  assertFiniteWallPoint(point);
  assertMaximumDistance(maximumDistanceMeters);
  let nearest: NearestStandardSpeedHoldMatch | undefined;
  for (const hold of STANDARD_SPEED_HOLDS) {
    const distanceMeters = Math.hypot(
      hold.wall.xMeters - point.xMeters,
      hold.wall.yMeters - point.yMeters,
    );
    if ((!nearest || distanceMeters < nearest.distanceMeters) && distanceMeters <= maximumDistanceMeters) {
      nearest = { hold, distanceMeters };
    }
  }
  return nearest;
}

export function findNearestStandardSpeedHoldFromImage(
  point: NormalizedPoint,
  calibration: WallCalibration,
  maximumDistanceMeters = Number.POSITIVE_INFINITY,
): NearestStandardSpeedHoldMatch | undefined {
  const validation = validateWallCalibration(calibration);
  if (!validation.valid || !validation.matrix) {
    throw new Error(validation.error ?? "Wall calibration is invalid.");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Image point must contain finite coordinates.");
  }
  return findNearestStandardSpeedHold(
    projectImagePointToWall(point, validation.matrix),
    maximumDistanceMeters,
  );
}

function invertHomography(matrix: HomographyMatrix): HomographyMatrix {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const cofactor00 = e * i - f * h;
  const cofactor01 = f * g - d * i;
  const cofactor02 = d * h - e * g;
  const cofactor10 = c * h - b * i;
  const cofactor11 = a * i - c * g;
  const cofactor12 = b * g - a * h;
  const cofactor20 = b * f - c * e;
  const cofactor21 = c * d - a * f;
  const cofactor22 = a * e - b * d;
  const determinant = a * cofactor00 + b * cofactor01 + c * cofactor02;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error("Wall calibration homography cannot be inverted.");
  }
  const scale = 1 / determinant;
  return [
    cofactor00 * scale, cofactor10 * scale, cofactor20 * scale,
    cofactor01 * scale, cofactor11 * scale, cofactor21 * scale,
    cofactor02 * scale, cofactor12 * scale, cofactor22 * scale,
  ];
}

function assertFiniteWallPoint(point: WallPoint): void {
  if (!Number.isFinite(point.xMeters) || !Number.isFinite(point.yMeters)) {
    throw new Error("Wall point must contain finite metre coordinates.");
  }
}

function assertMaximumDistance(distanceMeters: number): void {
  if (Number.isNaN(distanceMeters) || distanceMeters < 0) {
    throw new Error("Maximum hold distance must be a non-negative number.");
  }
}
