import type {
  Confidence,
  NormalizedPoint,
  NormalizedZone,
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

export interface AutomaticWallCalibrationDiagnostics {
  topY: number;
  bottomY: number;
  topMarkerSupport: number;
  bottomEdgeContrast: number;
  /** Fraction of the proposed lane interior that still looks like wall surface. */
  wallSurfaceSupport?: number;
  selectedLane: "left" | "right";
}

export interface AutomaticWallCalibrationResult {
  calibration?: WallCalibration;
  confidence: Confidence;
  reason: string;
  diagnostics?: AutomaticWallCalibrationDiagnostics;
}

export interface InferAutomaticWallCalibrationOptions {
  imageData: Pick<ImageData, "data" | "width" | "height">;
  frameRawTime: number;
  identityZone?: NormalizedZone;
  laneLightZone?: NormalizedZone;
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
    source: "manual",
    confidence: "High",
    corners: WALL_CORNER_TEMPLATE.map((corner, index) => ({
      ...corner,
      image: { ...imagePoints[index] },
    })),
  };
}

/**
 * Infers an approximate 3 m lane from a fixed-camera video frame. Timing
 * lights anchor the top, the wall-to-mat luminance step anchors the bottom,
 * and the accepted athlete region chooses one half of the two-lane wall.
 * Manual four-corner calibration remains the higher-accuracy metric option.
 */
export function inferAutomaticWallCalibration({
  imageData,
  frameRawTime,
  identityZone,
  laneLightZone,
}: InferAutomaticWallCalibrationOptions): AutomaticWallCalibrationResult {
  const { width, height, data } = imageData;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 96 ||
      !data || data.length < width * height * 4) {
    return { confidence: "Low", reason: "The captured video frame is unavailable or too small for automatic wall calibration." };
  }
  if (!Number.isFinite(frameRawTime) || frameRawTime < 0) {
    return { confidence: "Low", reason: "The calibration frame time is invalid." };
  }

  const laneHint = identityZone ?? laneLightZone;
  if (!laneHint) {
    return { confidence: "Low", reason: "Automatic wall calibration needs the selected athlete lane from start analysis." };
  }
  const hintX = clampNumber((laneHint.x1 + laneHint.x2) / 2, 0, 1);
  const markers = detectUpperTimingLights(data, width, height);
  const bottomEdge = detectWallMatBoundary(data, width, height);
  if (markers.support < 6) {
    return {
      confidence: "Low",
      reason: "The complete 15 m wall is not visible clearly enough to locate its upper timing-light edge. Mark the four lane corners manually.",
    };
  }
  const hintBottom = laneLightZone
    ? (laneLightZone.y1 + laneLightZone.y2) / 2 + 0.075
    : Math.max(laneHint.y1, laneHint.y2) + 0.055;
  const bottomY = bottomEdge.contrast >= 12
    ? bottomEdge.y
    : clampNumber(hintBottom, 0.72, 0.95);
  const topY = markers.support >= 6
    ? clampNumber(markers.y - 0.018, 0.005, 0.32)
    : clampNumber(bottomY - 0.72, 0.025, 0.2);
  const verticalSpan = bottomY - topY;

  if (verticalSpan < 0.48) {
    return {
      confidence: "Low",
      reason: "The complete 15 m wall is not visible clearly enough to infer a stable calibration.",
      diagnostics: {
        topY: roundMetric(topY),
        bottomY: roundMetric(bottomY),
        topMarkerSupport: markers.support,
        bottomEdgeContrast: roundMetric(bottomEdge.contrast),
        selectedLane: hintX < 0.5 ? "left" : "right",
      },
    };
  }

  // Normalized x/y have different pixel scales in a portrait frame. Include
  // image aspect before applying a conservative perspective expansion.
  const aspect = height / width;
  let fullBottomWidth = clampNumber(verticalSpan * aspect * 0.6, 0.58, 0.96);
  let fullTopWidth = clampNumber(verticalSpan * aspect * 0.36, 0.3, fullBottomWidth * 0.78);
  const markerCenter = markers.support >= 6 ? markers.centerX : 0.5;
  const selectedLane = hintX < markerCenter ? "left" : "right";
  const centerFromLaneHint = selectedLane === "left"
    ? hintX + fullBottomWidth / 4
    : hintX - fullBottomWidth / 4;
  const fullBottomCenter = clampNumber(markerCenter * 0.65 + centerFromLaneHint * 0.35, 0.36, 0.64);
  const fullTopCenter = clampNumber(markerCenter, 0.38, 0.62);
  fullBottomWidth = fitSpanWidth(fullBottomCenter, fullBottomWidth);
  fullTopWidth = fitSpanWidth(fullTopCenter, fullTopWidth);

  const bottomLeft = selectedLane === "left"
    ? fullBottomCenter - fullBottomWidth / 2
    : fullBottomCenter;
  const bottomRight = selectedLane === "left"
    ? fullBottomCenter
    : fullBottomCenter + fullBottomWidth / 2;
  const topLeft = selectedLane === "left"
    ? fullTopCenter - fullTopWidth / 2
    : fullTopCenter;
  const topRight = selectedLane === "left"
    ? fullTopCenter
    : fullTopCenter + fullTopWidth / 2;

  const inferredCorners = {
    bottomLeft: { x: bottomLeft, y: bottomY },
    bottomRight: { x: bottomRight, y: bottomY },
    topRight: { x: topRight, y: topY },
    topLeft: { x: topLeft, y: topY },
  };
  const wallSurfaceSupport = measureWallSurfaceSupport(data, width, height, inferredCorners);
  // Strongly oblique views can make the symmetric width estimate include a
  // window, beam, or the room beside the wall. A mathematically valid
  // homography through invented corners is still physically wrong, so refuse
  // metric COM and ask for four real lane corners instead of claiming Medium.
  if (wallSurfaceSupport < 0.86) {
    return {
      confidence: "Low",
      reason: "The proposed lane includes too much non-wall area for trustworthy perspective or speed metrics. This oblique view needs four manual lane corners.",
      diagnostics: {
        topY: roundMetric(topY),
        bottomY: roundMetric(bottomY),
        topMarkerSupport: markers.support,
        bottomEdgeContrast: roundMetric(bottomEdge.contrast),
        wallSurfaceSupport: roundMetric(wallSurfaceSupport),
        selectedLane,
      },
    };
  }

  const detectedTop = markers.support >= 6;
  const detectedBottom = bottomEdge.contrast >= 12;
  const confidence: Confidence = detectedTop && detectedBottom ? "Medium" : "Low";
  const reason = detectedTop && detectedBottom
    ? `Approximate ${selectedLane}-lane geometry inferred from the upper timing lights and wall-to-mat edge.`
    : `Approximate ${selectedLane}-lane geometry inferred with ${detectedTop ? "a detected wall top" : "an estimated wall top"} and ${detectedBottom ? "a detected wall base" : "an estimated wall base"}.`;

  const calibration = buildWallCalibration([
    { x: bottomLeft, y: bottomY },
    { x: bottomRight, y: bottomY },
    { x: topRight, y: topY },
    { x: topLeft, y: topY },
  ], frameRawTime, true);
  calibration.source = "automatic-approximate";
  calibration.confidence = confidence;
  calibration.reason = reason;
  const validation = validateWallCalibration(calibration);
  if (!validation.valid) {
    return { confidence: "Low", reason: validation.error ?? "Automatic wall geometry was not stable enough to use." };
  }

  return {
    calibration,
    confidence,
    reason,
    diagnostics: {
      topY: roundMetric(topY),
      bottomY: roundMetric(bottomY),
      topMarkerSupport: markers.support,
      bottomEdgeContrast: roundMetric(bottomEdge.contrast),
      wallSurfaceSupport: roundMetric(wallSurfaceSupport),
      selectedLane,
    },
  };
}

function measureWallSurfaceSupport(
  data: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  height: number,
  corners: {
    bottomLeft: NormalizedPoint;
    bottomRight: NormalizedPoint;
    topRight: NormalizedPoint;
    topLeft: NormalizedPoint;
  },
): number {
  let wallLike = 0;
  let sampled = 0;
  const columns = 10;
  const rows = 16;
  for (let row = 0; row < rows; row += 1) {
    const v = (row + 0.5) / rows;
    const left = interpolatePoint(corners.bottomLeft, corners.topLeft, v);
    const right = interpolatePoint(corners.bottomRight, corners.topRight, v);
    for (let column = 0; column < columns; column += 1) {
      const u = (column + 0.5) / columns;
      const point = interpolatePoint(left, right, u);
      const x = Math.max(0, Math.min(width - 1, Math.round(point.x * (width - 1))));
      const y = Math.max(0, Math.min(height - 1, Math.round(point.y * (height - 1))));
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      sampled += 1;
      if (chroma < 45 && luminance > 35 && luminance < 220) {
        wallLike += 1;
      }
    }
  }
  return sampled ? wallLike / sampled : 0;
}

function interpolatePoint(start: NormalizedPoint, end: NormalizedPoint, amount: number): NormalizedPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
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

interface UpperTimingLightDetection {
  y: number;
  centerX: number;
  support: number;
}

function detectUpperTimingLights(
  data: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  height: number,
): UpperTimingLightDetection {
  const binHeight = Math.max(2, Math.round(height * 0.008));
  const xStart = Math.round(width * 0.06);
  const xEnd = Math.round(width * 0.94);
  const xStep = Math.max(1, Math.floor(width / 540));
  const bins: Array<{ y: number; xs: number[] }> = [];
  for (let yStart = Math.round(height * 0.015); yStart < height * 0.36; yStart += binHeight) {
    const xs: number[] = [];
    for (let y = yStart; y < Math.min(height, yStart + binHeight); y += 1) {
      for (let x = xStart; x < xEnd; x += xStep) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const isRed = red - green > 35 && red - blue > 35;
        const isGreen = green - red > 24 && green - blue > 18;
        if (maximum > 95 && maximum - minimum > 42 && (isRed || isGreen)) {
          xs.push(x / width);
        }
      }
    }
    bins.push({ y: (yStart + binHeight / 2) / height, xs });
  }

  const sampledBinArea = ((xEnd - xStart) / xStep) * binHeight;
  const requiredSupport = Math.max(6, Math.round(sampledBinArea * 0.0015));
  for (let index = 0; index < bins.length; index += 1) {
    const cluster = [bins[index - 1], bins[index], bins[index + 1]].filter(Boolean);
    const xs = cluster.flatMap((bin) => bin.xs);
    if (xs.length < requiredSupport || bins[index].xs.length < 2) {
      continue;
    }
    xs.sort((left, right) => left - right);
    // The two-lane estimate needs horizontally separated upper markers.
    // A saturated ceiling-light fringe can contain dozens of colored pixels
    // in one tiny patch, especially after resizing. Pixel count alone then
    // puts the wall top on the ceiling and can even select the opposite lane.
    // Use robust endpoints so a few distant noise pixels cannot supply the
    // missing second marker. 0.15 is half the minimum inferred full top width.
    if (xs[Math.floor(xs.length * 0.9)] - xs[Math.floor(xs.length * 0.1)] < 0.15) {
      continue;
    }
    const groups: number[][] = [];
    for (const x of xs) {
      const previous = groups[groups.length - 1];
      if (!previous || x - previous[previous.length - 1] > 0.025) groups.push([x]);
      else previous.push(x);
    }
    const supported = groups.sort((a, b) => b.length - a.length)
      .filter(group => group.length >= Math.max(6, groups[0].length * 0.1));
    if (supported.length < 2) continue;
    const centers = supported.map(group => group.reduce((sum, x) => sum + x, 0) / group.length).sort((a, b) => a - b);
    if (centers[centers.length - 1] - centers[0] < 0.15) continue;
    // Use the midpoint of supported marker groups, not colored-pixel mass.
    // A clock and indicator can form separate groups in each lane; weighting
    // by pixel count pulls the divider toward the brighter/larger clock.
    return {
      y: bins[index].y,
      centerX: (centers[0] + centers[centers.length - 1]) / 2,
      support: supported.reduce((sum, group) => sum + group.length, 0),
    };
  }
  return { y: 0.1, centerX: 0.5, support: 0 };
}

function detectWallMatBoundary(
  data: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  height: number,
): { y: number; contrast: number } {
  const xStart = Math.round(width * 0.14);
  const xEnd = Math.round(width * 0.86);
  const xStep = Math.max(1, Math.floor((xEnd - xStart) / 72));
  const yStep = Math.max(1, Math.round(height / 260));
  const offsets = [0.012, 0.02, 0.028].map((fraction) => Math.max(2, Math.round(height * fraction)));
  const samples: Array<{ y: number; contrast: number }> = [];

  for (let y = Math.round(height * 0.62); y <= height * 0.96; y += yStep) {
    const above: number[] = [];
    const below: number[] = [];
    for (let x = xStart; x < xEnd; x += xStep) {
      for (const offsetY of offsets) {
        above.push(pixelLuminance(data, width, x, Math.max(0, y - offsetY)));
        below.push(pixelLuminance(data, width, x, Math.min(height - 1, y + offsetY)));
      }
    }
    samples.push({ y: y / height, contrast: median(above) - median(below) });
  }

  const peak = samples.reduce((best, sample) => sample.contrast > best.contrast ? sample : best,
    { y: 0.88, contrast: Number.NEGATIVE_INFINITY });
  if (!Number.isFinite(peak.contrast) || peak.contrast < 5) {
    return { y: 0.88, contrast: Math.max(0, peak.contrast) };
  }
  const peakIndex = samples.indexOf(peak);
  let onsetIndex = peakIndex;
  while (onsetIndex > 0 && peak.y - samples[onsetIndex - 1].y <= 0.065 &&
      samples[onsetIndex - 1].contrast >= peak.contrast * 0.48) {
    onsetIndex -= 1;
  }
  return { y: samples[onsetIndex].y, contrast: peak.contrast };
}

function pixelLuminance(
  data: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  x: number,
  y: number,
): number {
  const offset = (y * width + x) * 4;
  return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function fitSpanWidth(center: number, requestedWidth: number): number {
  return Math.max(0.12, Math.min(requestedWidth, center * 2, (1 - center) * 2));
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
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
