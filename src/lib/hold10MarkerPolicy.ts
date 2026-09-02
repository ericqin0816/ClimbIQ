import type { TimestampMarker } from "../types";

const LEGACY_AUTOMATIC_SOURCES = new Set<TimestampMarker["source"]>([
  "COM halfway estimate",
  "Hold contact detection",
  "Future / experimental",
]);

/** Identifies old detector-written Hold 10 markers that were never reviewed. */
export function isLegacyAutomaticHold10Marker(marker: TimestampMarker): boolean {
  return marker.id === "hold10" && LEGACY_AUTOMATIC_SOURCES.has(marker.source);
}
