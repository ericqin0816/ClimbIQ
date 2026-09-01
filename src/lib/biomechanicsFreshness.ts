import type { BiomechanicsResult, NormalizedZone } from "../types";

export const BIOMECHANICS_TIME_MATCH_TOLERANCE_SECONDS = 0.001;

export interface BiomechanicsResultBasis {
  startRawTime: number | null | undefined;
  endRawTime: number | null | undefined;
  identityZone?: NormalizedZone;
  toleranceSeconds?: number;
}

/**
 * A pose result can only drive timing, splits, and overlays while its accepted
 * range and selected athlete still match the inputs used to create it.
 */
export function isBiomechanicsResultFresh(
  result: BiomechanicsResult | undefined,
  basis: BiomechanicsResultBasis,
): result is BiomechanicsResult {
  if (!result || !Number.isFinite(basis.startRawTime) || !Number.isFinite(basis.endRawTime)) {
    return false;
  }
  const tolerance = Number.isFinite(basis.toleranceSeconds)
    ? Math.max(0, basis.toleranceSeconds!)
    : BIOMECHANICS_TIME_MATCH_TOLERANCE_SECONDS;
  return Math.abs(result.startRawTime - basis.startRawTime!) <= tolerance &&
    Math.abs(result.endRawTime - basis.endRawTime!) <= tolerance &&
    normalizedZonesEqual(result.identityZone, basis.identityZone);
}

export function selectFreshBiomechanicsResult(
  result: BiomechanicsResult | undefined,
  basis: BiomechanicsResultBasis,
): BiomechanicsResult | undefined {
  return isBiomechanicsResultFresh(result, basis) ? result : undefined;
}

/**
 * Selects an analysis that starts with the same athlete and covers at least the
 * requested finish. This allows an older full-video result to be safely
 * shortened after the user corrects an over-late finish, but never invents
 * frames for a later finish or reuses another athlete/start.
 */
export function selectBiomechanicsResultCoveringRange(
  result: BiomechanicsResult | undefined,
  basis: BiomechanicsResultBasis,
): BiomechanicsResult | undefined {
  if (!result || !Number.isFinite(basis.startRawTime) || !Number.isFinite(basis.endRawTime)) {
    return undefined;
  }
  const tolerance = Number.isFinite(basis.toleranceSeconds)
    ? Math.max(0, basis.toleranceSeconds!)
    : BIOMECHANICS_TIME_MATCH_TOLERANCE_SECONDS;
  return Math.abs(result.startRawTime - basis.startRawTime!) <= tolerance &&
    result.endRawTime + tolerance >= basis.endRawTime! &&
    normalizedZonesEqual(result.identityZone, basis.identityZone)
    ? result
    : undefined;
}

function normalizedZonesEqual(left?: NormalizedZone, right?: NormalizedZone): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.id === right.id &&
    Math.abs(left.x1 - right.x1) < 1e-6 &&
    Math.abs(left.y1 - right.y1) < 1e-6 &&
    Math.abs(left.x2 - right.x2) < 1e-6 &&
    Math.abs(left.y2 - right.y2) < 1e-6;
}
