import type { TimestampMarker } from "../types";
import { clearMarkerTimestamp } from "./timestampIntegrity";

const LEGACY_AUTOMATIC_SOURCES = new Set<TimestampMarker["source"]>([
  "COM halfway estimate",
  "Hold contact detection",
  "Future / experimental",
]);

/**
 * Keeps Hold 10 review-first. A fresh detector result is a proposal only and
 * never creates an accepted marker. Old auto-written markers are retained only
 * while the same contact is still detected, or cleared when their evidence is
 * stale. A user-reviewed Manual marker is never touched here.
 */
export function reconcileHold10Marker(
  timestamps: TimestampMarker[],
  detectedContactRawTime?: number,
): TimestampMarker[] {
  const existing = timestamps.find((marker) => marker.id === "hold10");
  if (!existing || !LEGACY_AUTOMATIC_SOURCES.has(existing.source)) {
    return timestamps;
  }
  if (
    existing.source === "Hold contact detection" &&
    existing.rawTime !== null &&
    Number.isFinite(detectedContactRawTime) &&
    Math.abs(existing.rawTime - detectedContactRawTime!) <= 0.001
  ) {
    return timestamps;
  }
  return clearMarkerTimestamp(timestamps, "hold10");
}
