import type {
  NormalizedPoint,
  NormalizedZone,
  WallCalibration,
  WallPoint,
} from "../types";
import { getStandardSpeedHold, projectWallPointToImage } from "./standardSpeedRoute";
import { projectImagePointToWall, validateWallCalibration } from "./wallCalibration";
import type { RouteAlignmentResult } from "./routeAlignment";
import { withinContactProjectionBounds, type ObservedRouteHold } from "./holdContact";

export type Hold10TargetFallbackReason =
  | "not-provided"
  | "invalid-zone"
  | "invalid-calibration"
  | "projection-failed"
  | "outside-wall";

interface Hold10TargetBase {
  holdId: 10;
  wallTarget: WallPoint;
  /** Available whenever the target can be placed in the current video frame. */
  imagePoint?: NormalizedPoint;
  /** User-facing explanation of how this target was selected. */
  reason: string;
  /** Direct visible centers only; never fitted guesses for hidden holds. */
  observedRouteHolds?: readonly ObservedRouteHold[];
  /** A small registered side-edge correction used only for contact review, never COM metrics. */
  allowApproximateEdgeProjection?: boolean;
}

export interface ManualHold10Target extends Hold10TargetBase {
  source: "manual-zone";
  imagePoint: NormalizedPoint;
  /** Reordered, validated copy of the accepted manual zone. */
  manualZone: NormalizedZone;
}

export interface TemplateHold10Target extends Hold10TargetBase {
  source: "standard-template";
  fallbackReason: Hold10TargetFallbackReason;
}

export interface VisuallyAlignedHold10Target extends Hold10TargetBase {
  source: "visual-alignment";
  imagePoint: NormalizedPoint;
}

export type Hold10TargetResolution = ManualHold10Target | VisuallyAlignedHold10Target | TemplateHold10Target;

export interface ResolveHold10TargetOptions {
  /** Runtime validation is intentional because imported sessions may be malformed. */
  manualZone?: unknown;
  calibration?: WallCalibration;
  visualAlignment?: RouteAlignmentResult | null;
}

const TEMPLATE_HOLD_10 = getStandardSpeedHold(10);

/**
 * Resolves one safe Hold 10 target for contact detection and video overlays.
 * A manual zone is authoritative only when both it and the wall projection are
 * valid. Every rejected manual value falls back to the same standardized
 * template target with a machine-readable and user-facing explanation.
 */
export function resolveHold10Target({
  manualZone,
  calibration,
  visualAlignment,
}: ResolveHold10TargetOptions): Hold10TargetResolution {
  if (manualZone === undefined || manualZone === null) {
    return alignedOrTemplateTarget(
      "not-provided",
      "No manual Hold 10 Zone was provided; using Hold 10 from the standardized route template.",
      calibration,
      visualAlignment,
    );
  }

  const sanitized = sanitizeManualHold10Zone(manualZone);
  if (!sanitized) {
    return alignedOrTemplateTarget(
      "invalid-zone",
      "The manual Hold 10 Zone has invalid or out-of-frame coordinates; using Hold 10 from the standardized route template.",
      calibration,
      visualAlignment,
    );
  }

  const validation = validateWallCalibration(calibration);
  if (!calibration || !validation.valid || !validation.matrix) {
    return alignedOrTemplateTarget(
      "invalid-calibration",
      `The manual Hold 10 Zone cannot be projected because the wall calibration is invalid: ${validation.error ?? "unknown calibration error"} Using the standardized route template.`,
      calibration,
      visualAlignment,
    );
  }

  const imagePoint = zoneCenter(sanitized);
  let wallTarget: WallPoint;
  try {
    wallTarget = projectImagePointToWall(imagePoint, validation.matrix);
  } catch {
    return alignedOrTemplateTarget(
      "projection-failed",
      "The manual Hold 10 Zone could not be projected onto the wall; using Hold 10 from the standardized route template.",
      calibration,
      visualAlignment,
    );
  }

  if (!insideCalibratedWall(wallTarget, calibration)) {
    return alignedOrTemplateTarget(
      "outside-wall",
      "The manual Hold 10 Zone projects outside the calibrated wall; using Hold 10 from the standardized route template.",
      calibration,
      visualAlignment,
    );
  }

  return {
    holdId: 10,
    source: "manual-zone",
    manualZone: sanitized,
    imagePoint,
    wallTarget,
    reason: "Using the center of the validated manual Hold 10 Zone.",
  };
}

function alignedOrTemplateTarget(
  fallbackReason: Hold10TargetFallbackReason,
  templateReason: string,
  calibration: WallCalibration | undefined,
  visualAlignment: RouteAlignmentResult | null | undefined,
): Hold10TargetResolution {
  const imagePoint = visualAlignment?.hold10Image;
  const wallTarget = visualAlignment?.hold10WallTarget;
  const edgeProjection = Boolean(visualAlignment?.aligned && calibration?.source === "automatic-approximate" &&
    wallTarget && !insideCalibratedWall(wallTarget, calibration) &&
    withinContactProjectionBounds(wallTarget, calibration, true) &&
    [9, 10, 11].every(id => visualAlignment.holds.some(hold => hold.holdId === id && hold.observedImage && insideNormalizedFrame(hold.observedImage))));
  if (visualAlignment?.aligned && imagePoint && wallTarget &&
      insideNormalizedFrame(imagePoint) && calibration && withinContactProjectionBounds(wallTarget, calibration, edgeProjection)) {
    const observedRouteHolds = observedRouteNeighborhood(visualAlignment, calibration, edgeProjection);
    if (edgeProjection && !observedRouteHolds?.some(hold => hold.id === 10)) return templateTarget(fallbackReason, templateReason, calibration);
    return {
      holdId: 10,
      source: "visual-alignment",
      imagePoint: { ...imagePoint },
      wallTarget: { ...wallTarget },
      observedRouteHolds,
      allowApproximateEdgeProjection: edgeProjection || undefined,
      reason: `Using Hold 10 from the visually registered route. ${edgeProjection ? "The visible hold sits just outside an approximate side edge; contact review allows a bounded 5% lane-width extrapolation without changing COM or speed calibration. " : ""}${visualAlignment.reason}`,
    };
  }
  return templateTarget(fallbackReason, templateReason, calibration);
}

function observedRouteNeighborhood(alignment: RouteAlignmentResult, calibration: WallCalibration, allowApproximateEdgeProjection = false): ObservedRouteHold[] | undefined {
  const validation = validateWallCalibration(calibration);
  if (!validation.valid || !validation.matrix) return undefined;
  const observed = alignment.holds.flatMap(hold => {
    if (!hold.observedImage || !insideNormalizedFrame(hold.observedImage)) return [];
    try {
      const wall = projectImagePointToWall(hold.observedImage, validation.matrix!);
      return withinContactProjectionBounds(wall, calibration, allowApproximateEdgeProjection) ? [{ id: hold.holdId, wall }] : [];
    } catch { return []; }
  });
  return observed.length >= 3 && observed.some(hold => hold.id === 10) ? observed : undefined;
}

function sanitizeManualHold10Zone(value: unknown): NormalizedZone | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<Record<"x1" | "y1" | "x2" | "y2", unknown>> & {
    label?: unknown;
  };
  const coordinates = [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
  if (coordinates.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
    return undefined;
  }
  const [rawX1, rawY1, rawX2, rawY2] = coordinates as number[];
  if (coordinates.some((coordinate) => (coordinate as number) < 0 || (coordinate as number) > 1)) {
    return undefined;
  }

  const x1 = Math.min(rawX1, rawX2);
  const x2 = Math.max(rawX1, rawX2);
  const y1 = Math.min(rawY1, rawY2);
  const y2 = Math.max(rawY1, rawY2);
  const center = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  if (!insideNormalizedFrame(center)) {
    return undefined;
  }

  return {
    id: "hold10",
    label: typeof candidate.label === "string" && candidate.label.trim()
      ? candidate.label.trim()
      : "Hold 10 Zone",
    x1,
    y1,
    x2,
    y2,
  };
}

function templateTarget(
  fallbackReason: Hold10TargetFallbackReason,
  reason: string,
  calibration?: WallCalibration,
): TemplateHold10Target {
  let imagePoint: NormalizedPoint | undefined;
  const validation = validateWallCalibration(calibration);
  if (calibration && validation.valid) {
    try {
      const projected = projectWallPointToImage(TEMPLATE_HOLD_10.wall, calibration);
      if (insideNormalizedFrame(projected)) {
        imagePoint = projected;
      }
    } catch {
      // The wall target remains useful to downstream validation even when an
      // overlay point cannot be produced from a malformed imported session.
    }
  }
  return {
    holdId: 10,
    source: "standard-template",
    fallbackReason,
    wallTarget: { ...TEMPLATE_HOLD_10.wall },
    imagePoint,
    reason,
  };
}

function zoneCenter(zone: NormalizedZone): NormalizedPoint {
  return {
    x: (zone.x1 + zone.x2) / 2,
    y: (zone.y1 + zone.y2) / 2,
  };
}

function insideNormalizedFrame(point: NormalizedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function insideCalibratedWall(point: WallPoint, calibration: WallCalibration): boolean {
  return Number.isFinite(point.xMeters) && Number.isFinite(point.yMeters) &&
    point.xMeters >= 0 && point.xMeters <= calibration.widthMeters &&
    point.yMeters >= 0 && point.yMeters <= calibration.heightMeters;
}
