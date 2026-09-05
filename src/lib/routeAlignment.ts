import type { Confidence, NormalizedPoint, NormalizedZone, WallCalibration, WallPoint } from "../types";
import {
  STANDARD_SPEED_HOLDS,
  projectStandardSpeedRouteToImage,
  projectWallPointToImage,
  type StandardSpeedHoldId,
} from "./standardSpeedRoute";
import { projectImagePointToWall, validateWallCalibration } from "./wallCalibration";
import { SPEED_ROUTE_BOLTS } from "./speedRouteBoltGrid";
import { assignRouteMatches } from "./routeAssignment";

export interface RouteAlignmentOptions {
  /** Research comparison only; bolt positions are not contact/silhouette centers. */
  referenceGeometry?: "legacy-diagram" | "ifsc-2022-bolt-grid";
  /** Analysis-grid width. Height follows the source aspect ratio. */
  maxGridWidth?: number;
  /** Fraction of frames in which a red/pink grid cell must be present. */
  minimumPersistence?: number;
  /** Largest allowed image-space displacement from the calibrated template. */
  maxCorrectionNormalized?: number;
  /** Final one-to-one hold/component association radius. */
  matchRadiusNormalized?: number;
  /** Minimum jointly explained numbered holds. */
  minimumMatchedHolds?: number;
  /** Optional selected athlete start zone used to disambiguate two valid lanes. */
  startBodyZone?: NormalizedZone;
}

export interface RouteAlignmentCandidate {
  id: number;
  image: NormalizedPoint;
  areaNormalized: number;
  areaCells: number;
  boundingWidthNormalized: number;
  boundingHeightNormalized: number;
  persistence: number;
  redness: number;
  pinkness: number;
  /** Perspective-normalized preference for an actual speed-hold silhouette. */
  silhouetteScore: number;
  /** Hardware rejection gate used to establish the route transform. */
  macroSilhouette: boolean;
}

export interface RouteAlignmentMatch {
  holdId: StandardSpeedHoldId;
  candidateId: number;
  expectedImage: NormalizedPoint;
  observedImage: NormalizedPoint;
  residualNormalized: number;
  persistence: number;
  association?: "consensus" | "topology-recovery";
}

export interface AlignedRouteHold {
  holdId: StandardSpeedHoldId;
  originalImage: NormalizedPoint;
  image: NormalizedPoint;
  observedImage?: NormalizedPoint;
  residualNormalized?: number;
}

export interface RouteAlignmentDiagnostics {
  framesUsed: number;
  sourceWidth: number;
  sourceHeight: number;
  gridWidth: number;
  gridHeight: number;
  persistentCells: number;
  segmentedComponents: number;
  retainedCandidates: number;
  hypothesesEvaluated: number;
  matchedHoldIds: StandardSpeedHoldId[];
  medianResidualNormalized?: number;
  rmsResidualNormalized?: number;
  maximumCorrectionNormalized?: number;
  startAnchorDistanceNormalized?: number;
  hold10Recovered?: boolean;
  ambiguous: boolean;
  refusalReason?: string;
  candidates: RouteAlignmentCandidate[];
  matches: RouteAlignmentMatch[];
}

export interface RouteAlignmentResult {
  aligned: boolean;
  confidence: Confidence;
  /** The matched image silhouettes remain the target; this identifies only the fitting prior. */
  referenceGeometry?: "legacy-diagram" | "ifsc-2022-bolt-grid";
  model?: "affine" | "projective";
  /** Normalized-image correction applied after the wall calibration projection. */
  correctionMatrix?: RouteAlignmentMatrix;
  reason: string;
  holds: AlignedRouteHold[];
  hold10Image?: NormalizedPoint;
  /** Hold 10 projected back through the current wall calibration for contact timing. */
  hold10WallTarget?: WallPoint;
  diagnostics: RouteAlignmentDiagnostics;
}

export interface RouteAlignmentPolicyResult {
  result: RouteAlignmentResult;
  /** True only for the stricter recovery pass used with approximate auto calibration. */
  usedExpandedSearch: boolean;
}

export type RouteAlignmentMatrix = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];
type Transform = RouteAlignmentMatrix;

interface ResolvedOptions {
  maxGridWidth: number;
  minimumPersistence: number;
  maxCorrectionNormalized: number;
  matchRadiusNormalized: number;
  minimumMatchedHolds: number;
  startBodyZone?: NormalizedZone;
}

interface GridSegmentation {
  width: number;
  height: number;
  persistentMask: Uint8Array;
  persistence: Float32Array;
  redness: Float32Array;
  pinkness: Float32Array;
  persistentCells: number;
}

interface InternalMatch {
  holdIndex: number;
  candidateIndex: number;
  residual: number;
  recovered?: boolean;
}

interface AlignmentHypothesis {
  transform: Transform;
  model: "affine" | "projective";
  matches: InternalMatch[];
  medianResidual: number;
  rmsResidual: number;
  maximumCorrection: number;
  meanPersistence: number;
  meanSilhouetteScore: number;
  effectiveSupport: number;
  startAnchorDistance?: number;
  score: number;
}

const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Aligns the complete standardized 20-hold route to persistent red/pink video
 * components. All associations are solved as one bounded route hypothesis;
 * no hold marker is independently snapped to its nearest red blob.
 */
export function alignStandardSpeedRouteVisually(
  frames: readonly ImageData[],
  calibration: WallCalibration | undefined,
  options: RouteAlignmentOptions = {},
): RouteAlignmentResult {
  const resolved = resolveOptions(options);
  const validation = validateWallCalibration(calibration);
  if (!calibration || !validation.valid || !validation.matrix) {
    return refusedResult(frames, "A valid wall calibration is required for visual route alignment.");
  }
  const frameError = validateFrames(frames);
  if (frameError) return refusedResult(frames, frameError);

  const projected = options.referenceGeometry === "ifsc-2022-bolt-grid"
    ? SPEED_ROUTE_BOLTS.map(bolt => projectWallPointToImage(bolt.wall, calibration))
    : projectStandardSpeedRouteToImage(calibration).map((entry) => entry.image);
  const segmentation = segmentPersistentRedPink(frames, resolved);
  const components = scoreCandidateSilhouettes(extractComponents(segmentation), calibration);
  const nearbyCandidates = components.filter((candidate) => candidate.macroSilhouette &&
    projected.some((point) => pointDistance(point, candidate.image) <= resolved.maxCorrectionNormalized + 0.07),
  );
  // A wall may contain hundreds of tiny persistent red bolt dots. Keep a
  // generous pool for faint/occluded holds, but rank hold-sized silhouettes
  // first so dense hardware cannot manufacture a 20-point route consensus.
  const candidateLimit = Math.min(72, Math.max(44, resolved.minimumMatchedHolds * 5));
  const candidates = [...nearbyCandidates]
    .sort((left, right) => right.silhouetteScore - left.silhouetteScore ||
      right.areaNormalized - left.areaNormalized || left.id - right.id)
    .slice(0, candidateLimit)
    .sort((left, right) => left.image.y - right.image.y || left.image.x - right.image.x)
    .map((candidate, id) => ({ ...candidate, id }));
  const baseDiagnostics = makeDiagnostics(frames, segmentation, components.length, candidates);
  if (candidates.length < resolved.minimumMatchedHolds) {
    return {
      ...refusedResult(frames, `Only ${candidates.length} persistent red/pink hold candidates were usable; at least ${resolved.minimumMatchedHolds} are required.`),
      diagnostics: {
        ...baseDiagnostics,
        refusalReason: `Only ${candidates.length} usable persistent hold candidates were found.`,
      },
    };
  }

  const initialTransforms = makeInitialTransforms(projected, candidates, resolved.maxCorrectionNormalized);
  const hypotheses = initialTransforms.flatMap((initial) => {
    const hypothesis = refineHypothesis(initial, projected, candidates, resolved);
    return hypothesis ? [hypothesis] : [];
  });
  const unique = deduplicateHypotheses(hypotheses, projected)
    .sort((left, right) => {
      if (resolved.startBodyZone) {
        const anchorDifference = (left.startAnchorDistance ?? Number.POSITIVE_INFINITY) -
          (right.startAnchorDistance ?? Number.POSITIVE_INFINITY);
        if (Math.abs(anchorDifference) > 0.025) return anchorDifference;
      }
      return right.score - left.score || left.medianResidual - right.medianResidual;
    });
  const best = unique[0];
  if (!best || best.matches.length < resolved.minimumMatchedHolds ||
      best.effectiveSupport < resolved.minimumMatchedHolds * 0.7 ||
      best.meanSilhouetteScore < 0.36) {
    const support = best?.matches.length ?? 0;
    const reason = `The red/pink components did not support one consistent 20-hold route alignment (${support}/${resolved.minimumMatchedHolds} required matches).`;
    return {
      ...refusedResult(frames, reason),
      diagnostics: {
        ...baseDiagnostics,
        hypothesesEvaluated: initialTransforms.length,
        matchedHoldIds: best
          ? best.matches.map((match) => STANDARD_SPEED_HOLDS[match.holdIndex].id)
          : [],
        medianResidualNormalized: best?.medianResidual,
        rmsResidualNormalized: best?.rmsResidual,
        maximumCorrectionNormalized: best?.maximumCorrection,
        startAnchorDistanceNormalized: best?.startAnchorDistance,
        matches: best ? toPublicMatches(best, projected, candidates) : [],
        refusalReason: reason,
      },
    };
  }

  let hold10Match = best.matches.find((match) => match.holdIndex === 9);
  let hold10Recovered = false;
  if (!hold10Match && resolved.startBodyZone && best.matches.length >= 10) {
    hold10Match = recoverUnmatchedHold10(best, projected, candidates);
    if (hold10Match) {
      best.matches = [...best.matches, hold10Match]
        .sort((left, right) => left.holdIndex - right.holdIndex);
      const residuals = best.matches.map((match) => match.residual);
      best.medianResidual = median(residuals);
      best.rmsResidual = Math.sqrt(mean(residuals.map((value) => value * value)));
      best.meanPersistence = mean(best.matches.map((match) => candidates[match.candidateIndex].persistence));
      best.meanSilhouetteScore = mean(best.matches.map((match) => candidates[match.candidateIndex].silhouetteScore));
      best.effectiveSupport = best.matches.reduce((sum, match) =>
        sum + 0.12 + candidates[match.candidateIndex].silhouetteScore * 0.88, 0);
      hold10Recovered = true;
    }
  }
  if (!hold10Match) {
    const reason = "The route shape was partly aligned, but Hold 10 did not have a direct macro-hold match; automatic Hold 10 alignment was refused.";
    const partialHolds: AlignedRouteHold[] = best.matches.map((match) => ({
      holdId: STANDARD_SPEED_HOLDS[match.holdIndex].id,
      originalImage: projected[match.holdIndex],
      image: candidates[match.candidateIndex].image,
      observedImage: candidates[match.candidateIndex].image,
      residualNormalized: match.residual,
    }));
    return {
      ...refusedResult(frames, reason),
      // These are direct macro-silhouette matches from the anchored consensus,
      // not fitted guesses. The overlay may show this verified subset while
      // Hold 10 contact remains unavailable.
      holds: partialHolds,
      diagnostics: {
        ...baseDiagnostics,
        hypothesesEvaluated: initialTransforms.length,
        matchedHoldIds: best.matches.map((match) => STANDARD_SPEED_HOLDS[match.holdIndex].id),
        medianResidualNormalized: best.medianResidual,
        rmsResidualNormalized: best.rmsResidual,
        maximumCorrectionNormalized: best.maximumCorrection,
        startAnchorDistanceNormalized: best.startAnchorDistance,
        hold10Recovered: false,
        refusalReason: reason,
        matches: toPublicMatches(best, projected, candidates),
      },
    };
  }

  const alternative = unique.find((candidate, index) => index > 0 &&
    !resolved.startBodyZone &&
    meanTransformSeparation(best.transform, candidate.transform, projected) > 0.028 &&
    candidate.matches.length >= best.matches.length - 1 &&
    candidate.medianResidual <= best.medianResidual + 0.004 &&
    Math.abs(candidate.meanSilhouetteScore - best.meanSilhouetteScore) <= 0.22);
  const ambiguous = Boolean(alternative);
  if (ambiguous) {
    const reason = "Two different route placements explain nearly the same red/pink hold evidence; automatic alignment was refused.";
    return {
      ...refusedResult(frames, reason),
      diagnostics: {
        ...baseDiagnostics,
        hypothesesEvaluated: initialTransforms.length,
        matchedHoldIds: best.matches.map((match) => STANDARD_SPEED_HOLDS[match.holdIndex].id),
        medianResidualNormalized: best.medianResidual,
        rmsResidualNormalized: best.rmsResidual,
        maximumCorrectionNormalized: best.maximumCorrection,
        startAnchorDistanceNormalized: best.startAnchorDistance,
        ambiguous: true,
        refusalReason: reason,
        matches: toPublicMatches(best, projected, candidates),
      },
    };
  }

  const matchByHold = new Map(best.matches.map((match) => [match.holdIndex, match]));
  const holds: AlignedRouteHold[] = STANDARD_SPEED_HOLDS.map((hold, index) => {
    const match = matchByHold.get(index);
    const transformed = applyTransform(best.transform, projected[index]);
    const observed = match ? candidates[match.candidateIndex].image : undefined;
    return {
      holdId: hold.id,
      originalImage: projected[index],
      // Put matched markers on the segmented holds themselves. The joint route
      // transform is retained only for holds hidden in every sampled frame.
      image: observed ?? transformed,
      observedImage: observed,
      residualNormalized: match?.residual,
    };
  });
  // Hold 10 contact needs the detected hold center, not only a fitted route
  // estimate. With seven climb frames it is normally visible at least once;
  // otherwise contact timing is safer to pause or use a manual zone.
  const hold10Image = holds[9].observedImage;
  let hold10WallTarget: WallPoint | undefined;
  if (hold10Image) {
    try {
      hold10WallTarget = projectImagePointToWall(hold10Image, validation.matrix);
    } catch {
      // Image output is still useful if an extreme calibration is numerically
      // unstable, but contact timing remains unavailable.
    }
  }
  const confidence = alignmentConfidence(best, frames.length);
  const reason = `${best.matches.length}/20 numbered holds jointly aligned with ${(best.medianResidual * 100).toFixed(2)}% median image error using a bounded ${best.model} correction.` +
    (hold10Recovered ? " Hold 10 used one unique topology-checked macro-hold recovery." : "");
  return {
    aligned: true,
    confidence,
    model: best.model,
    correctionMatrix: best.transform,
    reason,
    holds,
    hold10Image,
    hold10WallTarget,
    diagnostics: {
      ...baseDiagnostics,
      hypothesesEvaluated: initialTransforms.length,
      matchedHoldIds: best.matches.map((match) => STANDARD_SPEED_HOLDS[match.holdIndex].id),
      medianResidualNormalized: best.medianResidual,
      rmsResidualNormalized: best.rmsResidual,
      maximumCorrectionNormalized: best.maximumCorrection,
      startAnchorDistanceNormalized: best.startAnchorDistance,
      hold10Recovered,
      ambiguous: false,
      matches: toPublicMatches(best, projected, candidates),
    },
  };
}

/**
 * Uses a conservative registration first. Approximate automatic calibration can
 * be far enough from an oblique lane to need a wider search, but that recovery
 * is accepted only with unusually strong, unique evidence and a material
 * residual improvement. This correction affects hold markers/contact only; it
 * is never applied to COM calibration or metre-per-second calculations.
 */
export function alignStandardSpeedRouteWithFallback(
  frames: readonly ImageData[],
  calibration: WallCalibration | undefined,
  options: RouteAlignmentOptions = {},
): RouteAlignmentPolicyResult {
  const preferred = alignWithGeometryCorrection(frames, calibration, options);
  if (options.referenceGeometry || preferred.result.aligned || !calibration || !validZone(options.startBodyZone)) {
    return preferred;
  }

  // The original diagram includes large margins and is not a measured lane
  // grid. Recover a failed fit from the published attachment layout, but demand
  // more support and smaller residuals than either ordinary registration pass.
  // This wider search never changes wall calibration or accepted timestamps.
  const grid = alignStandardSpeedRouteVisually(frames, calibration, {
    ...options,
    referenceGeometry: "ifsc-2022-bolt-grid",
    maxCorrectionNormalized: 0.18,
    minimumMatchedHolds: 16,
  });
  const diagnostic = grid.diagnostics;
  const directlyMatched = new Set(diagnostic.matches.filter(match => match.association !== "topology-recovery").map(match => match.holdId));
  const strongGrid = grid.aligned && !diagnostic.ambiguous && directlyMatched.size >= 16 &&
    [9, 10, 11].every(id => directlyMatched.has(id as StandardSpeedHoldId)) &&
    (diagnostic.medianResidualNormalized ?? Infinity) <= 0.008 &&
    (diagnostic.rmsResidualNormalized ?? Infinity) <= 0.012 &&
    (diagnostic.startAnchorDistanceNormalized ?? Infinity) <= 0.08;
  if (!strongGrid) return preferred;
  return {
    usedExpandedSearch: true,
    result: {
      ...grid,
      referenceGeometry: "ifsc-2022-bolt-grid",
      reason: `${grid.reason} Recovery used the published IFSC attachment grid with at least 16 direct silhouette matches. Hold centers come from the video, not the attachment bolts.`,
    },
  };
}

function alignWithGeometryCorrection(
  frames: readonly ImageData[],
  calibration: WallCalibration | undefined,
  options: RouteAlignmentOptions,
): RouteAlignmentPolicyResult {
  const conservative = alignStandardSpeedRouteVisually(frames, calibration, options);
  const conservativeDiagnostics = conservative.diagnostics;
  const conservativeNearBound =
    (conservativeDiagnostics.maximumCorrectionNormalized ?? 0) >= 0.085 ||
    (conservativeDiagnostics.medianResidualNormalized ?? 0) > 0.015;
  if (conservative.aligned && !conservativeNearBound) {
    return { result: conservative, usedExpandedSearch: false };
  }

  const expanded = alignStandardSpeedRouteVisually(frames, calibration, {
    ...options,
    maxCorrectionNormalized: 0.16,
    minimumMatchedHolds: 12,
  });
  const diagnostics = expanded.diagnostics;
  const strongExpandedResult = expanded.aligned &&
    !diagnostics.ambiguous &&
    diagnostics.matchedHoldIds.length >= 12 &&
    (diagnostics.medianResidualNormalized ?? Number.POSITIVE_INFINITY) <= 0.018 &&
    (diagnostics.maximumCorrectionNormalized ?? Number.POSITIVE_INFINITY) <= 0.16;
  if (!strongExpandedResult) {
    return { result: conservative, usedExpandedSearch: false };
  }
  const materiallyBetterThanConservative = !conservative.aligned || (
    diagnostics.matchedHoldIds.length >= conservativeDiagnostics.matchedHoldIds.length &&
    (diagnostics.medianResidualNormalized ?? Number.POSITIVE_INFINITY) <=
      (conservativeDiagnostics.medianResidualNormalized ?? Number.POSITIVE_INFINITY) * 0.82 &&
    (diagnostics.rmsResidualNormalized ?? Number.POSITIVE_INFINITY) <=
      (conservativeDiagnostics.rmsResidualNormalized ?? Number.POSITIVE_INFINITY) * 0.92
  );
  if (!materiallyBetterThanConservative) {
    return { result: conservative, usedExpandedSearch: false };
  }
  return {
    usedExpandedSearch: true,
    result: {
      ...expanded,
      reason: `${expanded.reason} A stricter oblique-view recovery pass was required.`,
    },
  };
}

function resolveOptions(options: RouteAlignmentOptions): ResolvedOptions {
  return {
    maxGridWidth: integerInRange(options.maxGridWidth, 360, 120, 640),
    minimumPersistence: clamp(finiteOr(options.minimumPersistence, 0.5), 0.34, 1),
    maxCorrectionNormalized: clamp(finiteOr(options.maxCorrectionNormalized, 0.1), 0.025, 0.18),
    matchRadiusNormalized: clamp(finiteOr(options.matchRadiusNormalized, 0.035), 0.012, 0.07),
    minimumMatchedHolds: integerInRange(options.minimumMatchedHolds, 10, 10, 16),
    startBodyZone: validZone(options.startBodyZone) ? options.startBodyZone : undefined,
  };
}

function validateFrames(frames: readonly ImageData[]): string | undefined {
  if (!frames.length) return "At least one video frame is required for visual route alignment.";
  const { width, height } = frames[0];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 64) {
    return "Route-alignment frames have invalid dimensions.";
  }
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height || frame.data.length < width * height * 4) {
      return "All route-alignment frames must have matching dimensions and complete RGBA pixels.";
    }
  }
  return undefined;
}

function segmentPersistentRedPink(
  frames: readonly ImageData[],
  options: ResolvedOptions,
): GridSegmentation {
  const sourceWidth = frames[0].width;
  const sourceHeight = frames[0].height;
  const width = Math.min(sourceWidth, options.maxGridWidth);
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const cells = width * height;
  const totalPixels = new Uint32Array(cells);
  for (let y = 0; y < sourceHeight; y += 1) {
    const gy = Math.min(height - 1, Math.floor(y * height / sourceHeight));
    for (let x = 0; x < sourceWidth; x += 1) {
      const gx = Math.min(width - 1, Math.floor(x * width / sourceWidth));
      totalPixels[gy * width + gx] += 1;
    }
  }

  const frameHits = new Uint16Array(cells);
  const rednessSum = new Float32Array(cells);
  const pinknessSum = new Float32Array(cells);
  for (const frame of frames) {
    const redPixels = new Uint16Array(cells);
    const strength = new Float32Array(cells);
    const pinkStrength = new Float32Array(cells);
    for (let y = 0; y < sourceHeight; y += 1) {
      const gy = Math.min(height - 1, Math.floor(y * height / sourceHeight));
      for (let x = 0; x < sourceWidth; x += 1) {
        const offset = (y * sourceWidth + x) * 4;
        const red = frame.data[offset];
        const green = frame.data[offset + 1];
        const blue = frame.data[offset + 2];
        const score = redPinkScore(red, green, blue);
        if (score <= 0) continue;
        const cell = gy * width + Math.min(width - 1, Math.floor(x * width / sourceWidth));
        redPixels[cell] += 1;
        strength[cell] += score;
        pinkStrength[cell] += Math.max(0, blue - green) / 255;
      }
    }
    for (let cell = 0; cell < cells; cell += 1) {
      const fraction = redPixels[cell] / Math.max(1, totalPixels[cell]);
      if (redPixels[cell] > 0 && fraction >= 0.08) {
        frameHits[cell] += 1;
        rednessSum[cell] += strength[cell] / redPixels[cell];
        pinknessSum[cell] += pinkStrength[cell] / redPixels[cell];
      }
    }
  }

  const persistentMask = new Uint8Array(cells);
  const persistence = new Float32Array(cells);
  const redness = new Float32Array(cells);
  const pinkness = new Float32Array(cells);
  const requiredFrames = Math.max(1, Math.ceil(frames.length * options.minimumPersistence - 1e-9));
  let persistentCells = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    persistence[cell] = frameHits[cell] / frames.length;
    redness[cell] = frameHits[cell] ? rednessSum[cell] / frameHits[cell] : 0;
    pinkness[cell] = frameHits[cell] ? pinknessSum[cell] / frameHits[cell] : 0;
    if (frameHits[cell] >= requiredFrames) {
      persistentMask[cell] = 1;
      persistentCells += 1;
    }
  }
  return { width, height, persistentMask, persistence, redness, pinkness, persistentCells };
}

function redPinkScore(red: number, green: number, blue: number): number {
  const redExcess = red - (green + blue) / 2;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  if (red < 65 || redExcess < 12 || chroma < 16 || red < green * 1.1 || red < blue * 0.88) {
    return 0;
  }
  return redExcess + chroma * 0.35;
}

function extractComponents(segmentation: GridSegmentation): RouteAlignmentCandidate[] {
  const { width, height, persistentMask, persistence, redness, pinkness } = segmentation;
  const visited = new Uint8Array(persistentMask.length);
  const candidates: RouteAlignmentCandidate[] = [];
  const maximumArea = Math.max(12, Math.round(width * height * 0.012));
  for (let seed = 0; seed < persistentMask.length; seed += 1) {
    if (!persistentMask[seed] || visited[seed]) continue;
    const queue = [seed];
    visited[seed] = 1;
    let cursor = 0;
    let cells = 0;
    let weight = 0;
    let weightedX = 0;
    let weightedY = 0;
    let geometricX = 0;
    let geometricY = 0;
    let persistenceSum = 0;
    let rednessSum = 0;
    let pinknessSum = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (cursor < queue.length) {
      const cell = queue[cursor++];
      const x = cell % width;
      const y = Math.floor(cell / width);
      const cellWeight = Math.max(1, redness[cell]) * Math.max(0.25, persistence[cell]);
      cells += 1;
      weight += cellWeight;
      weightedX += (x + 0.5) * cellWeight;
      weightedY += (y + 0.5) * cellWeight;
      geometricX += x + 0.5;
      geometricY += y + 0.5;
      persistenceSum += persistence[cell];
      rednessSum += redness[cell];
      pinknessSum += pinkness[cell];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (persistentMask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
    }
    if (cells < 2 || cells > maximumArea) continue;
    const weightedCenter = {
      x: weightedX / Math.max(1, weight) / width,
      y: weightedY / Math.max(1, weight) / height,
    };
    const geometricCenter = {
      x: geometricX / cells / width,
      y: geometricY / cells / height,
    };
    const boundingCenter = {
      x: (minX + maxX + 1) / 2 / width,
      y: (minY + maxY + 1) / 2 / height,
    };
    candidates.push({
      id: candidates.length,
      // Saturated/dark lobes receive a much larger redness score than pale
      // parts of the same pink star hold. Blend mask centroid and bounding-box
      // center so Hold 10 lands near the physical silhouette center instead
      // of being pulled onto one dark lobe.
      image: {
        x: geometricCenter.x * 0.55 + boundingCenter.x * 0.3 + weightedCenter.x * 0.15,
        y: geometricCenter.y * 0.55 + boundingCenter.y * 0.3 + weightedCenter.y * 0.15,
      },
      areaNormalized: cells / (width * height),
      areaCells: cells,
      boundingWidthNormalized: (maxX - minX + 1) / width,
      boundingHeightNormalized: (maxY - minY + 1) / height,
      persistence: persistenceSum / cells,
      redness: rednessSum / cells,
      pinkness: pinknessSum / cells,
      silhouetteScore: 0,
      macroSilhouette: cells >= 24 &&
        maxX - minX + 1 >= 5 && maxY - minY + 1 >= 5 &&
        (maxX - minX + 1) * (maxY - minY + 1) >= 30,
    });
  }
  return candidates.sort((left, right) => left.image.y - right.image.y || left.image.x - right.image.x)
    .map((candidate, id) => ({ ...candidate, id }));
}

function scoreCandidateSilhouettes(
  candidates: RouteAlignmentCandidate[],
  calibration: WallCalibration,
): RouteAlignmentCandidate[] {
  if (!candidates.length) return [];
  const relativeAreas = candidates.map((candidate) =>
    candidate.areaNormalized / Math.max(1e-5, laneWidthAtImageY(calibration, candidate.image.y) ** 2),
  );
  const logarithms = relativeAreas.map((area) => Math.log(Math.max(1e-8, area)));
  let smallMean = Math.min(...logarithms);
  let largeMean = Math.max(...logarithms);
  for (let iteration = 0; iteration < 8 && largeMean - smallMean > 1e-6; iteration += 1) {
    const midpoint = (smallMean + largeMean) / 2;
    const small = logarithms.filter((value) => value <= midpoint);
    const large = logarithms.filter((value) => value > midpoint);
    if (!small.length || !large.length) break;
    smallMean = mean(small);
    largeMean = mean(large);
  }
  const separation = Math.max(0, largeMean - smallMean);
  const midpoint = (smallMean + largeMean) / 2;
  return candidates.map((candidate, index) => {
    const laneWidth = laneWidthAtImageY(calibration, candidate.image.y);
    const areaScore = separation >= Math.log(1.65)
      ? clamp(0.5 + (logarithms[index] - midpoint) / Math.max(0.5, separation), 0, 1)
      : clamp((candidate.areaCells - 2) / 14, 0, 1);
    const relativeExtent = Math.max(
      candidate.boundingWidthNormalized,
      candidate.boundingHeightNormalized,
    ) / Math.max(0.02, laneWidth);
    const extentScore = clamp((relativeExtent - 0.012) / 0.06, 0, 1);
    const pinkScore = clamp(candidate.pinkness / 0.16, 0, 1);
    return {
      ...candidate,
      silhouetteScore: clamp(
        areaScore * 0.67 + extentScore * 0.18 + pinkScore * 0.1 + candidate.persistence * 0.05,
        0,
        1,
      ),
    };
  });
}

function laneWidthAtImageY(calibration: WallCalibration, y: number): number {
  const bottomLeft = calibration.corners.find((corner) => corner.id === "bottomLeft") ?? calibration.corners[0];
  const bottomRight = calibration.corners.find((corner) => corner.id === "bottomRight") ?? calibration.corners[1];
  const topRight = calibration.corners.find((corner) => corner.id === "topRight") ?? calibration.corners[2];
  const topLeft = calibration.corners.find((corner) => corner.id === "topLeft") ?? calibration.corners[3];
  const edgeX = (top: NormalizedPoint, bottom: NormalizedPoint) => {
    const denominator = bottom.y - top.y;
    if (Math.abs(denominator) < 1e-6) return (top.x + bottom.x) / 2;
    const ratio = clamp((y - top.y) / denominator, 0, 1);
    return top.x + (bottom.x - top.x) * ratio;
  };
  return Math.max(0.02, Math.abs(edgeX(topRight.image, bottomRight.image) - edgeX(topLeft.image, bottomLeft.image)));
}

function makeInitialTransforms(
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
  maxCorrection: number,
): Transform[] {
  const transforms: Transform[] = [IDENTITY];
  const seen = new Set<string>(["1,1,0,0"]);
  const anchorIndices = [0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const xScales = [0.68, 0.82, 1, 1.18, 1.32];
  const yScales = [0.84, 1, 1.16];
  for (const pointIndex of anchorIndices) {
    const point = projected[pointIndex];
    for (const candidate of candidates) {
      if (pointDistance(point, candidate.image) > maxCorrection + 0.1) continue;
      for (const scaleX of xScales) {
        for (const scaleY of yScales) {
          const dx = candidate.image.x - point.x * scaleX;
          const dy = candidate.image.y - point.y * scaleY;
          const key = `${Math.round(scaleX * 50)},${Math.round(scaleY * 50)},${Math.round(dx * 250)},${Math.round(dy * 250)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          transforms.push([scaleX, 0, dx, 0, scaleY, dy, 0, 0, 1]);
        }
      }
    }
  }
  return transforms;
}

function refineHypothesis(
  initial: Transform,
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
  options: ResolvedOptions,
): AlignmentHypothesis | undefined {
  let transform = initial;
  let matches: InternalMatch[] = [];
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const radius = iteration === 0
      ? Math.min(0.075, options.matchRadiusNormalized * 1.85)
      : options.matchRadiusNormalized * (iteration === 1 ? 1.35 : 1.05);
    matches = assignOneToOne(transform, projected, candidates, radius);
    if (matches.length < 4) return undefined;
    const residualMedian = median(matches.map((match) => match.residual));
    const inlierLimit = Math.min(radius, Math.max(options.matchRadiusNormalized * 0.72, residualMedian * 2.8));
    const inliers = matches.filter((match) => match.residual <= inlierLimit + 1e-9);
    if (inliers.length < 4) return undefined;
    const fitted = fitAffine(projected, candidates, inliers, transform);
    if (!fitted || !isBoundedTransform(fitted, projected, options.maxCorrectionNormalized)) return undefined;
    transform = fitted;
  }
  matches = assignRouteMatches(projected.map(point => applyTransform(transform, point)), candidates, options.matchRadiusNormalized);
  if (matches.length < 4) return undefined;

  let model: "affine" | "projective" = "affine";
  if (matches.length >= 9) {
    const projective = fitProjective(projected, candidates, matches);
    if (projective && isBoundedTransform(projective, projected, options.maxCorrectionNormalized)) {
      const projectiveMatches = assignRouteMatches(projected.map(point => applyTransform(projective, point)), candidates, options.matchRadiusNormalized);
      const affineResidual = median(matches.map((match) => match.residual));
      const projectiveResidual = median(projectiveMatches.map((match) => match.residual));
      if (projectiveMatches.length >= matches.length && projectiveResidual <= affineResidual * 0.88) {
        transform = projective;
        matches = projectiveMatches;
        model = "projective";
      }
    }
  }

  const residuals = matches.map((match) => match.residual);
  const medianResidual = median(residuals);
  const rmsResidual = Math.sqrt(mean(residuals.map((value) => value * value)));
  const maximumCorrection = Math.max(...projected.map((point) => pointDistance(point, applyTransform(transform, point))));
  const meanPersistence = mean(matches.map((match) => candidates[match.candidateIndex].persistence));
  const meanSilhouetteScore = mean(matches.map((match) => candidates[match.candidateIndex].silhouetteScore));
  const effectiveSupport = matches.reduce((sum, match) =>
    sum + 0.12 + candidates[match.candidateIndex].silhouetteScore * 0.88, 0);
  const startAnchorDistance = options.startBodyZone
    ? routeStartAnchorDistance(transform, projected, options.startBodyZone)
    : undefined;
  if (startAnchorDistance !== undefined && startAnchorDistance > 0.22) return undefined;
  const score = matches.length * 100 + effectiveSupport * 5 - medianResidual * 8000 -
    rmsResidual * 3000 - maximumCorrection * 35 + meanPersistence * 8 -
    (startAnchorDistance ?? 0) * 1500;
  return {
    transform,
    model,
    matches,
    medianResidual,
    rmsResidual,
    maximumCorrection,
    meanPersistence,
    meanSilhouetteScore,
    effectiveSupport,
    startAnchorDistance,
    score,
  };
}

function assignOneToOne(
  transform: Transform,
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
  radius: number,
): InternalMatch[] {
  const pairs: InternalMatch[] = [];
  for (let holdIndex = 0; holdIndex < projected.length; holdIndex += 1) {
    const aligned = applyTransform(transform, projected[holdIndex]);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const residual = pointDistance(aligned, candidates[candidateIndex].image);
      if (residual <= radius) pairs.push({ holdIndex, candidateIndex, residual });
    }
  }
  pairs.sort((left, right) =>
    left.residual - right.residual ||
    candidates[right.candidateIndex].silhouetteScore - candidates[left.candidateIndex].silhouetteScore ||
    candidates[right.candidateIndex].persistence - candidates[left.candidateIndex].persistence ||
    left.holdIndex - right.holdIndex || left.candidateIndex - right.candidateIndex,
  );
  const usedHolds = new Set<number>();
  const usedCandidates = new Set<number>();
  const matches: InternalMatch[] = [];
  for (const pair of pairs) {
    if (usedHolds.has(pair.holdIndex) || usedCandidates.has(pair.candidateIndex)) continue;
    usedHolds.add(pair.holdIndex);
    usedCandidates.add(pair.candidateIndex);
    matches.push(pair);
  }
  return matches.sort((left, right) => left.holdIndex - right.holdIndex);
}

/**
 * A pale Hold 10 can sit just outside the global residual radius even when the
 * rest of the selected lane has a strong macro-hold consensus. Recover it only
 * from an unused, high-quality silhouette between the already matched holds
 * below and above it, with a clear nearest-candidate margin. This never admits
 * bolt dots and is disabled without an athlete start anchor.
 */
function recoverUnmatchedHold10(
  hypothesis: AlignmentHypothesis,
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
): InternalMatch | undefined {
  const holdIndex = 9;
  const expected = applyTransform(hypothesis.transform, projected[holdIndex]);
  const usedCandidates = new Set(hypothesis.matches.map((match) => match.candidateIndex));
  const below = [...hypothesis.matches]
    .filter((match) => match.holdIndex < holdIndex)
    .sort((left, right) => right.holdIndex - left.holdIndex)[0];
  const above = [...hypothesis.matches]
    .filter((match) => match.holdIndex > holdIndex)
    .sort((left, right) => left.holdIndex - right.holdIndex)[0];
  if (!below || !above) return undefined;
  const belowY = candidates[below.candidateIndex].image.y;
  const aboveY = candidates[above.candidateIndex].image.y;
  const alternatives = candidates.flatMap((candidate, candidateIndex) => {
    if (usedCandidates.has(candidateIndex) || !candidate.macroSilhouette || candidate.silhouetteScore < 0.72) {
      return [];
    }
    if (candidate.image.y > belowY + 0.008 || candidate.image.y < aboveY - 0.008) {
      return [];
    }
    const residual = pointDistance(expected, candidate.image);
    return residual <= 0.052 ? [{ holdIndex, candidateIndex, residual, recovered: true }] : [];
  }).sort((left, right) => left.residual - right.residual || left.candidateIndex - right.candidateIndex);
  if (!alternatives.length) return undefined;
  if (alternatives[1] && alternatives[1].residual - alternatives[0].residual < 0.008) {
    return undefined;
  }
  return alternatives[0];
}

function fitAffine(
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
  matches: InternalMatch[],
  current: Transform,
): Transform | undefined {
  const rows = matches.map((match) => [projected[match.holdIndex].x, projected[match.holdIndex].y, 1]);
  const weights = matches.map((match) => {
    const residual = pointDistance(applyTransform(current, projected[match.holdIndex]), candidates[match.candidateIndex].image);
    const robust = 1 / (1 + (residual / 0.018) ** 2);
    const candidate = candidates[match.candidateIndex];
    return robust * (0.25 + candidate.silhouetteScore * 0.65 + candidate.persistence * 0.1);
  });
  const x = solveWeightedLeastSquares(rows, matches.map((match) => candidates[match.candidateIndex].image.x), weights);
  const y = solveWeightedLeastSquares(rows, matches.map((match) => candidates[match.candidateIndex].image.y), weights);
  return x && y ? [x[0], x[1], x[2], y[0], y[1], y[2], 0, 0, 1] : undefined;
}

function fitProjective(
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
  matches: InternalMatch[],
): Transform | undefined {
  const rows: number[][] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  for (const match of matches) {
    const source = projected[match.holdIndex];
    const target = candidates[match.candidateIndex].image;
    const candidate = candidates[match.candidateIndex];
    const weight = 0.25 + candidate.silhouetteScore * 0.65 + candidate.persistence * 0.1;
    rows.push([source.x, source.y, 1, 0, 0, 0, -target.x * source.x, -target.x * source.y]);
    targets.push(target.x);
    weights.push(weight);
    rows.push([0, 0, 0, source.x, source.y, 1, -target.y * source.x, -target.y * source.y]);
    targets.push(target.y);
    weights.push(weight);
  }
  const fitted = solveWeightedLeastSquares(rows, targets, weights);
  return fitted?.length === 8
    ? [fitted[0], fitted[1], fitted[2], fitted[3], fitted[4], fitted[5], fitted[6], fitted[7], 1]
    : undefined;
}

function solveWeightedLeastSquares(rows: number[][], targets: number[], weights: number[]): number[] | undefined {
  if (!rows.length || rows.length !== targets.length || rows.length !== weights.length) return undefined;
  const size = rows[0].length;
  const normal = Array.from({ length: size }, () => Array(size).fill(0) as number[]);
  const right = Array(size).fill(0) as number[];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const weight = weights[rowIndex];
    for (let left = 0; left < size; left += 1) {
      right[left] += row[left] * targets[rowIndex] * weight;
      for (let column = 0; column < size; column += 1) {
        normal[left][column] += row[left] * row[column] * weight;
      }
    }
  }
  return solveLinearSystem(normal, right);
}

function solveLinearSystem(matrix: number[][], right: number[]): number[] | undefined {
  const size = right.length;
  const augmented = matrix.map((row, index) => [...row, right[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return undefined;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const scale = augmented[column][column];
    for (let entry = column; entry <= size; entry += 1) augmented[column][entry] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  const solution = augmented.map((row) => row[size]);
  return solution.every(Number.isFinite) ? solution : undefined;
}

function isBoundedTransform(transform: Transform, projected: NormalizedPoint[], maxCorrection: number): boolean {
  const aligned = projected.map((point) => applyTransform(transform, point));
  if (aligned.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < -0.05 || point.x > 1.05 || point.y < -0.05 || point.y > 1.05)) return false;
  const maximum = Math.max(...aligned.map((point, index) => pointDistance(point, projected[index])));
  if (maximum > maxCorrection + 1e-9) return false;
  const ratios = aligned.slice(1).map((point, index) =>
    pointDistance(point, aligned[index]) / Math.max(1e-6, pointDistance(projected[index + 1], projected[index])),
  );
  if (ratios.some((ratio) => ratio < 0.62 || ratio > 1.48)) return false;
  // Hold numbers are ordered bottom-to-top; a valid correction cannot reverse
  // that global direction even though adjacent holds zig-zag horizontally.
  return aligned[19].y < aligned[0].y;
}

function routeStartAnchorDistance(
  transform: Transform,
  projected: NormalizedPoint[],
  zone: NormalizedZone,
): number {
  const first = applyTransform(transform, projected[0]);
  const second = applyTransform(transform, projected[1]);
  const routeStartX = (first.x + second.x) / 2;
  const bodyCenterX = (zone.x1 + zone.x2) / 2;
  // The athlete's body-zone y-center is below the starting hand holds and
  // varies with framing/crouch. Its x-center is the reliable lane identity.
  return Math.abs(routeStartX - bodyCenterX);
}

function applyTransform(transform: Transform, point: NormalizedPoint): NormalizedPoint {
  const denominator = transform[6] * point.x + transform[7] * point.y + transform[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return { x: Number.NaN, y: Number.NaN };
  }
  return {
    x: (transform[0] * point.x + transform[1] * point.y + transform[2]) / denominator,
    y: (transform[3] * point.x + transform[4] * point.y + transform[5]) / denominator,
  };
}

function deduplicateHypotheses(
  hypotheses: AlignmentHypothesis[],
  projected: NormalizedPoint[],
): AlignmentHypothesis[] {
  const unique: AlignmentHypothesis[] = [];
  for (const hypothesis of hypotheses.sort((left, right) => right.score - left.score)) {
    if (unique.some((candidate) => meanTransformSeparation(
      hypothesis.transform,
      candidate.transform,
      projected,
    ) < 0.0035)) continue;
    unique.push(hypothesis);
  }
  return unique;
}

function meanTransformSeparation(left: Transform, right: Transform, projected: NormalizedPoint[]): number {
  return mean(projected.map((point) => pointDistance(applyTransform(left, point), applyTransform(right, point))));
}

function alignmentConfidence(hypothesis: AlignmentHypothesis, frameCount: number): Confidence {
  if (frameCount >= 2 && hypothesis.matches.length >= 14 && hypothesis.medianResidual <= 0.009 &&
      hypothesis.meanPersistence >= 0.65 && hypothesis.effectiveSupport >= 12) return "High";
  if (hypothesis.matches.length >= 10 && hypothesis.medianResidual <= 0.017 &&
      hypothesis.effectiveSupport >= 7.5) return "Medium";
  return "Low";
}

function toPublicMatches(
  hypothesis: AlignmentHypothesis,
  projected: NormalizedPoint[],
  candidates: RouteAlignmentCandidate[],
): RouteAlignmentMatch[] {
  return hypothesis.matches.map((match) => ({
    holdId: STANDARD_SPEED_HOLDS[match.holdIndex].id,
    candidateId: candidates[match.candidateIndex].id,
    expectedImage: applyTransform(hypothesis.transform, projected[match.holdIndex]),
    observedImage: candidates[match.candidateIndex].image,
    residualNormalized: match.residual,
    persistence: candidates[match.candidateIndex].persistence,
    association: match.recovered ? "topology-recovery" : "consensus",
  }));
}

function makeDiagnostics(
  frames: readonly ImageData[],
  segmentation: GridSegmentation,
  segmentedComponents: number,
  candidates: RouteAlignmentCandidate[],
): RouteAlignmentDiagnostics {
  return {
    framesUsed: frames.length,
    sourceWidth: frames[0]?.width ?? 0,
    sourceHeight: frames[0]?.height ?? 0,
    gridWidth: segmentation.width,
    gridHeight: segmentation.height,
    persistentCells: segmentation.persistentCells,
    segmentedComponents,
    retainedCandidates: candidates.length,
    hypothesesEvaluated: 0,
    matchedHoldIds: [],
    ambiguous: false,
    candidates,
    matches: [],
  };
}

function refusedResult(frames: readonly ImageData[], reason: string): RouteAlignmentResult {
  return {
    aligned: false,
    confidence: "None",
    reason,
    holds: [],
    diagnostics: {
      framesUsed: frames.length,
      sourceWidth: frames[0]?.width ?? 0,
      sourceHeight: frames[0]?.height ?? 0,
      gridWidth: 0,
      gridHeight: 0,
      persistentCells: 0,
      segmentedComponents: 0,
      retainedCandidates: 0,
      hypothesesEvaluated: 0,
      matchedHoldIds: [],
      ambiguous: false,
      refusalReason: reason,
      candidates: [],
      matches: [],
    },
  };
}

function pointDistance(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function median(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function validZone(zone: NormalizedZone | undefined): zone is NormalizedZone {
  return Boolean(zone && [zone.x1, zone.y1, zone.x2, zone.y2].every(Number.isFinite) &&
    Math.abs(zone.x2 - zone.x1) > 0.01 && Math.abs(zone.y2 - zone.y1) > 0.01);
}

function integerInRange(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.round(clamp(finiteOr(value, fallback), minimum, maximum));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
