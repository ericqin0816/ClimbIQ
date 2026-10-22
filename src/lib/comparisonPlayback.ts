import type { SavedAnalysisSession } from "../types";
import { sanitizeTimestampSequence } from "./timestampIntegrity";

export type ComparisonPhase = "total" | "bottom" | "top";
export type PlaybackRange = { start: number; end: number };

export function comparisonPlaybackRange(session: SavedAnalysisSession, phase: ComparisonPhase): PlaybackRange | null {
  const markers = sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration);
  const start = markers.find(item => item.id === "startSignal" && item.source !== "Not set")?.rawTime;
  const finish = markers.find(item => item.id === "finishPad" && item.source !== "Not set")?.rawTime;
  const hold = markers.find(item => item.id === "hold10" && item.acceptanceMode === "frame-review" && item.source !== "Not set")?.rawTime;
  if (typeof start !== "number" || typeof finish !== "number" || finish <= start) return null;
  if (phase === "total") return { start, end: finish };
  if (typeof hold !== "number" || hold <= start || hold >= finish) return null;
  return phase === "bottom" ? { start, end: hold } : { start: hold, end: finish };
}

/** Equal elapsed time from each section's entry; never stretch clips to hide differences. */
export function comparisonPlaybackTime(range: PlaybackRange, elapsed: number): number {
  return range.start + Math.max(0, Math.min(Number.isFinite(elapsed) ? elapsed : 0, range.end - range.start));
}
