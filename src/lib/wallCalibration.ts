import type {
  NormalizedPoint,
  WallCalibration,
  WallCalibrationCorner,
  WallCornerId,
  WallPoint,
} from "../types";

export type HomographyMatrix = [number, number, number, number, number, number, number, number, number];

export interface CalibrationValidation {
  valid: boolean;
  error?: string;
  matrix?: HomographyMatrix;
}

export const SPEED_WALL_WIDTH_METERS = 3;
export const SPEED_WALL_HEIGHT_METERS = 15;

export const WALL_CORNER_TEMPLATE: Array<{
  id: WallCornerId;
  label: string;
  wall: WallPoint;
}> = [
  { id: "bottomLeft", label: "Bottom left", wall: { xMeters: 0, yMeters: 0 } },
  { id: "bottomRight", label: "Bottom right", wall: { xMeters: SPEED_WALL_WIDTH_METERS, yMeters: 0 } },
  { id: "topRight", label: "Top right", wall: { xMeters: SPEED_WALL_WIDTH_METERS, yMeters: SPEED_WALL_HEIGHT_METERS } },
  { id: "topLeft", label: "Top left", wall: { xMeters: 0, yMeters: SPEED_WALL_HEIGHT_METERS } },
];

export function buildWallCalibration(
  imagePoints: NormalizedPoint[],
  frameRawTime: number,
  staticCameraConfirmed: boolean,
): WallCalibration {
  if (imagePoints.length !== WALL_CORNER_TEMPLATE.length) {
    throw new Error("Wall calibration requires exactly four corner points.");
  }

  return {
    version: 1,
    frameRawTime,
    widthMeters: SPEED_WALL_WIDTH_METERS,
    heightMeters: SPEED_WALL_HEIGHT_METERS,
    staticCameraConfirmed,
    corners: WALL_CORNER_TEMPLATE.map((corner, index) => ({
      ...corner,
      image: { ...imagePoints[index] },
    })),
  };
}

export function validateWallCalibration(calibration?: WallCalibration): CalibrationValidation {
  if (!calibration || typeof calibration !== "object") {
    return { valid: false, error: "Capture a full-wall frame and mark all four wall corners." };
  }
  if (calibration.version !== 1) {
    return { valid: false, error: "Unsupported wall calibration version." };
  }
  if (!calibration.staticCameraConfirmed) {
    return { valid: false, error: "Confirm that the camera is fixed with no pan, tilt, or zoom." };
  }
  if (!Number.isFinite(calibration.frameRawTime) || calibration.frameRawTime < 0) {
    return { valid: false, error: "Calibration frame time is invalid." };
  }
  if (
    calibration.widthMeters !== SPEED_WALL_WIDTH_METERS ||
    calibration.heightMeters !== SPEED_WALL_HEIGHT_METERS
  ) {
    return { valid: false, error: "This version supports the standardized 3 m by 15 m speed wall." };
  }
  if (!Array.isArray((calibration as { corners?: unknown }).corners)) {
    return { valid: false, error: "Wall calibration corners are missing or malformed." };
  }

  const ordered = orderCorners(calibration.corners);
  if (!ordered) {
    return { valid: false, error: "Calibration corners are missing or duplicated." };
  }

  const wallTargetsMatch = ordered.every((corner, index) => {
    const expected = WALL_CORNER_TEMPLATE[index];
    return corner.id === expected.id &&
      Math.abs(corner.wall.xMeters - expected.wall.xMeters) < 1e-9 &&
      Math.abs(corner.wall.yMeters - expected.wall.yMeters) < 1e-9;
  });
  if (!wallTargetsMatch) {
    return { valid: false, error: "Wall corner targets do not match the standardized speed-wall layout." };
  }

  const points = ordered.map((corner) => corner.image);
  if (points.some((point) => !isFiniteNormalizedPoint(point))) {
    return { valid: false, error: "Every calibration point must be inside the video frame." };
  }

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (distance(points[left], points[right]) < 0.025) {
        return { valid: false, error: "Two wall corners are too close together. Recheck the click order." };
      }
    }
  }

  const [bottomLeft, bottomRight, topRight, topLeft] = points;
  const bottomY = (bottomLeft.y + bottomRight.y) / 2;
  const topY = (topLeft.y + topRight.y) / 2;
  if (bottomY <= topY + 0.04) {
    return { valid: false, error: "Bottom corners must be visibly below the top corners." };
  }
  if (bottomLeft.x >= bottomRight.x - 0.02 || topLeft.x >= topRight.x - 0.02) {
    return { valid: false, error: "Left and right wall corners appear reversed." };
  }
  if (
    distance(bottomLeft, bottomRight) < 0.05 ||
    distance(topLeft, topRight) < 0.05 ||
    distance(bottomLeft, topLeft) < 0.12 ||
    distance(bottomRight, topRight) < 0.12
  ) {
    return { valid: false, error: "The marked wall is too narrow or short for a stable calibration." };
  }
  if (!isConvex(points) || quadrilateralArea(points) < 0.025) {
    return { valid: false, error: "Corner order creates a crossed or nearly flat wall shape." };
  }

  try {
    const matrix = solveHomography(ordered);
    const maxCornerError = ordered.reduce((maxError, corner) => {
      const projected = projectImagePointToWall(corner.image, matrix);
      return Math.max(maxError, Math.hypot(
        projected.xMeters - corner.wall.xMeters,
        projected.yMeters - corner.wall.yMeters,
      ));
    }, 0);
    if (!Number.isFinite(maxCornerError) || maxCornerError > 0.001) {
      return { valid: false, error: "Wall calibration could not be solved accurately." };
    }
    return { valid: true, matrix };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Wall calibration could not be solved.",
    };
  }
}

export function solveHomography(corners: WallCalibrationCorner[]): HomographyMatrix {
  const ordered = orderCorners(corners);
  if (!ordered) {
    throw new Error("Wall calibration requires four uniquely identified corners.");
  }

  const equations: number[][] = [];
  for (const corner of ordered) {
    const { x, y } = corner.image;
    const { xMeters: targetX, yMeters: targetY } = corner.wall;
    equations.push([x, y, 1, 0, 0, 0, -targetX * x, -targetX * y, targetX]);
    equations.push([0, 0, 0, x, y, 1, -targetY * x, -targetY * y, targetY]);
  }

  const solution = solveLinearSystem(equations);
  return [
    solution[0], solution[1], solution[2],
    solution[3], solution[4], solution[5],
    solution[6], solution[7], 1,
  ];
}

export function projectImagePointToWall(point: NormalizedPoint, matrix: HomographyMatrix): WallPoint {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-10) {
    throw new Error("Point lies outside the stable wall calibration region.");
  }

  const xMeters = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const yMeters = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  if (!Number.isFinite(xMeters) || !Number.isFinite(yMeters)) {
    throw new Error("Wall projection produced an invalid coordinate.");
  }
  return { xMeters, yMeters };
}

function orderCorners(corners: WallCalibrationCorner[]): WallCalibrationCorner[] | null {
  if (!Array.isArray(corners) || corners.length !== WALL_CORNER_TEMPLATE.length ||
    corners.some((corner) => !corner || typeof corner !== "object" ||
      typeof corner.id !== "string" || !corner.image || typeof corner.image !== "object" ||
      !corner.wall || typeof corner.wall !== "object")) {
    return null;
  }
  const byId = new Map(corners.map((corner) => [corner.id, corner]));
  if (byId.size !== WALL_CORNER_TEMPLATE.length) {
    return null;
  }
  const ordered = WALL_CORNER_TEMPLATE.map((template) => byId.get(template.id));
  return ordered.every(Boolean) ? ordered as WallCalibrationCorner[] : null;
}

function solveLinearSystem(augmented: number[][]): number[] {
  const size = augmented.length;
  if (size === 0 || augmented.some((row) => row.length !== size + 1)) {
    throw new Error("Wall calibration equations are malformed.");
  }

  const matrix = augmented.map((row) => [...row]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivotRow][column])) {
        pivotRow = row;
      }
    }
    if (Math.abs(matrix[pivotRow][column]) < 1e-10) {
      throw new Error("Wall corners are degenerate. Mark a larger, non-crossed quadrilateral.");
    }
    [matrix[column], matrix[pivotRow]] = [matrix[pivotRow], matrix[column]];

    const pivot = matrix[column][column];
    for (let entry = column; entry <= size; entry += 1) {
      matrix[column][entry] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = matrix[row][column];
      for (let entry = column; entry <= size; entry += 1) {
        matrix[row][entry] -= factor * matrix[column][entry];
      }
    }
  }
  return matrix.map((row) => row[size]);
}

function isFiniteNormalizedPoint(point: NormalizedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function distance(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function cross(origin: NormalizedPoint, first: NormalizedPoint, second: NormalizedPoint): number {
  return (first.x - origin.x) * (second.y - origin.y) -
    (first.y - origin.y) * (second.x - origin.x);
}

function isConvex(points: NormalizedPoint[]): boolean {
  const turns = points.map((point, index) => cross(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  const negative = turns.every((value) => value < -1e-7);
  return negative;
}

function quadrilateralArea(points: NormalizedPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return Math.abs(area) / 2;
}
