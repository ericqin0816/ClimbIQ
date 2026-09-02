import type { Confidence } from "../types";

export interface CameraStabilityFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | ArrayLike<number>;
}

export interface CameraStabilityResult {
  assessable: boolean;
  stable: boolean;
  confidence: Confidence;
  shiftXNormalized: number;
  shiftYNormalized: number;
  scaleRatio: number;
  improvement: number;
  reason: string;
}

const GRID_WIDTH = 72;
const GRID_HEIGHT = 96;
const MAX_SHIFT = 7;

/**
 * Estimates global camera translation from robust edge alignment. Brightness
 * drift mostly disappears in the edge map, while trimmed scoring prevents one
 * moving athlete from dominating the fixed wall/background evidence.
 */
export function assessCameraStability(
  first: CameraStabilityFrame,
  last: CameraStabilityFrame,
): CameraStabilityResult {
  if (!validFrame(first) || !validFrame(last)) {
    return unavailable("Camera stability could not be checked because a comparison frame was invalid.");
  }
  const firstEdges = edgeGrid(first);
  const lastEdges = edgeGrid(last);
  const strongEdges = firstEdges.reduce((count, value, index) =>
    count + (Math.max(value, lastEdges[index]) >= 10 ? 1 : 0), 0);
  if (strongEdges < GRID_WIDTH * GRID_HEIGHT * 0.025) {
    return unavailable("Camera stability could not be measured because the scene had too little fixed edge detail.");
  }

  const zeroError = alignmentError(firstEdges, lastEdges, 0, 0);
  let best = { dx: 0, dy: 0, scale: 1, error: zeroError };
  for (const scale of [0.94, 0.97, 1, 1.03, 1.06]) {
    for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy += 1) {
      for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx += 1) {
        if (dx === 0 && dy === 0 && scale === 1) continue;
        const error = alignmentError(firstEdges, lastEdges, dx, dy, scale);
        const complexity = Math.hypot(dx, dy) + Math.abs(scale - 1) * 80;
        const bestComplexity = Math.hypot(best.dx, best.dy) + Math.abs(best.scale - 1) * 80;
        if (error < best.error - 1e-6 || (Math.abs(error - best.error) <= 1e-6 && complexity < bestComplexity)) {
          best = { dx, dy, scale, error };
        }
      }
    }
  }

  const improvement = zeroError > 1e-6 ? Math.max(0, (zeroError - best.error) / zeroError) : 0;
  const shiftXNormalized = best.dx / GRID_WIDTH;
  const shiftYNormalized = best.dy / GRID_HEIGHT;
  const shiftMagnitude = Math.hypot(shiftXNormalized, shiftYNormalized);
  const translated = Math.hypot(best.dx, best.dy) >= 1.8 && shiftMagnitude >= 0.018;
  const zoomed = Math.abs(best.scale - 1) >= 0.025;
  const moved = (translated || zoomed) && improvement >= 0.16;
  const confidence: Confidence = improvement >= 0.28 ? "High" : "Medium";
  return {
    assessable: true,
    stable: !moved,
    confidence,
    shiftXNormalized: roundMetric(shiftXNormalized),
    shiftYNormalized: roundMetric(shiftYNormalized),
    scaleRatio: roundMetric(best.scale),
    improvement: roundMetric(improvement),
    reason: moved
      ? zoomed
        ? `Fixed wall edges changed scale by about ${(Math.abs(best.scale - 1) * 100).toFixed(1)}% between start and finish.`
        : `Fixed wall edges shifted about ${(shiftMagnitude * 100).toFixed(1)}% of the frame between start and finish.`
      : "No meaningful global camera translation was found between start and finish.",
  };
}

function edgeGrid(frame: CameraStabilityFrame): Float32Array {
  const gray = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
  for (let gy = 0; gy < GRID_HEIGHT; gy += 1) {
    const sourceY = Math.min(frame.height - 1, Math.round(gy * (frame.height - 1) / (GRID_HEIGHT - 1)));
    for (let gx = 0; gx < GRID_WIDTH; gx += 1) {
      const sourceX = Math.min(frame.width - 1, Math.round(gx * (frame.width - 1) / (GRID_WIDTH - 1)));
      const offset = (sourceY * frame.width + sourceX) * 4;
      gray[gy * GRID_WIDTH + gx] =
        Number(frame.data[offset]) * 0.299 + Number(frame.data[offset + 1]) * 0.587 + Number(frame.data[offset + 2]) * 0.114;
    }
  }
  const edges = new Float32Array(gray.length);
  for (let y = 1; y < GRID_HEIGHT - 1; y += 1) {
    for (let x = 1; x < GRID_WIDTH - 1; x += 1) {
      const horizontal = gray[y * GRID_WIDTH + x + 1] - gray[y * GRID_WIDTH + x - 1];
      const vertical = gray[(y + 1) * GRID_WIDTH + x] - gray[(y - 1) * GRID_WIDTH + x];
      edges[y * GRID_WIDTH + x] = Math.min(255, Math.hypot(horizontal, vertical));
    }
  }
  return edges;
}

function alignmentError(
  first: Float32Array,
  last: Float32Array,
  dx: number,
  dy: number,
  scale = 1,
): number {
  const differences: number[] = [];
  const margin = MAX_SHIFT + 2;
  for (let y = margin; y < GRID_HEIGHT - margin; y += 1) {
    for (let x = margin; x < GRID_WIDTH - margin; x += 1) {
      const shiftedX = Math.round((x - GRID_WIDTH / 2) * scale + GRID_WIDTH / 2 + dx);
      const shiftedY = Math.round((y - GRID_HEIGHT / 2) * scale + GRID_HEIGHT / 2 + dy);
      if (shiftedX < 1 || shiftedX >= GRID_WIDTH - 1 || shiftedY < 1 || shiftedY >= GRID_HEIGHT - 1) continue;
      const firstValue = first[y * GRID_WIDTH + x];
      const lastValue = last[shiftedY * GRID_WIDTH + shiftedX];
      if (Math.max(firstValue, lastValue) < 6) continue;
      differences.push(Math.abs(firstValue - lastValue));
    }
  }
  if (!differences.length) return Number.POSITIVE_INFINITY;
  differences.sort((left, right) => left - right);
  const start = Math.floor(differences.length * 0.1);
  const end = Math.max(start + 1, Math.ceil(differences.length * 0.82));
  const retained = differences.slice(start, end);
  return retained.reduce((sum, value) => sum + value, 0) / retained.length;
}

function validFrame(frame: CameraStabilityFrame): boolean {
  return Number.isInteger(frame.width) && Number.isInteger(frame.height) && frame.width >= 32 && frame.height >= 48 &&
    Boolean(frame.data) && frame.data.length >= frame.width * frame.height * 4;
}

function unavailable(reason: string): CameraStabilityResult {
  return {
    assessable: false,
    stable: false,
    confidence: "None",
    shiftXNormalized: 0,
    shiftYNormalized: 0,
    scaleRatio: 1,
    improvement: 0,
    reason,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
}
