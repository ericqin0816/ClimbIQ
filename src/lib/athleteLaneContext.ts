import type { NormalizedZone, TimestampMarker } from "../types";
import { clearMarkerTimestamp } from "./timestampIntegrity";

/** Names do not define a selected image region. */
export function athleteRegionGeometry(zone?: NormalizedZone) {
  return zone ? { id: zone.id, x1: zone.x1, y1: zone.y1, x2: zone.x2, y2: zone.y2 } : null;
}

interface LaneRunContext {
  source: string;
  acceptedStart: number;
  trustedBodyZone?: NormalizedZone;
}

/** A saved zone or recording metadata cannot recreate a source-bound run. */
export function laneRunContextKey(context: LaneRunContext): string | null {
  if (!context.source || !Number.isFinite(context.acceptedStart) || context.acceptedStart < 0) return null;
  return JSON.stringify([context.source, context.acceptedStart, athleteRegionGeometry(context.trustedBodyZone)]);
}

export function hasFreshLaneRunContext(recordedKey: string | null, context: LaneRunContext, candidateCount: number): boolean {
  return candidateCount > 0 && recordedKey !== null && recordedKey === laneRunContextKey(context);
}

/** Frame review may keep the offered clock; it cannot retarget a discovery run
 * to another event. Compare the actual reviewed value before display rounding.
 */
export function canContinueSuggestedLaneRun(recordedKey: string | null, originalSuggestedStart: number,
  reviewedRawTime: number | undefined, context: Omit<LaneRunContext, "acceptedStart">): boolean {
  return (reviewedRawTime === undefined || reviewedRawTime === originalSuggestedStart)
    && recordedKey !== null && recordedKey === laneRunContextKey({ ...context, acceptedStart: originalSuggestedStart });
}

/** Choosing another athlete changes the meaning of every contact/movement
 * annotation, even when its numeric time happens to match. Shared Start stays.
 */
export function clearAthleteDependentMarkers(timestamps: TimestampMarker[]): TimestampMarker[] {
  return timestamps.reduce((next, marker) => marker.id === "startSignal" ? next : clearMarkerTimestamp(next, marker.id), timestamps);
}
