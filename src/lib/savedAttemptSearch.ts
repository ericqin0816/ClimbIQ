import type { SavedAnalysisSession } from "../types";
import { sanitizeTimestampSequence } from "./timestampIntegrity";
import { timingConfidence } from "./timingEvidence";

export type SavedAttemptFilter = "all" | "timed" | "review";
export type SavedAttemptSort = "updated" | "recorded";
export interface SavedAttemptRow {
  session: SavedAnalysisSession;
  totalSeconds: number | null;
  needsReview: boolean;
  searchText: string;
}

export function buildSavedAttemptRows(sessions: SavedAnalysisSession[]): SavedAttemptRow[] {
  return sessions.map(session => {
    const markers = sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration);
    const start = markers.find(marker => marker.id === "startSignal");
    const finish = markers.find(marker => marker.id === "finishPad");
    const totalSeconds = typeof start?.rawTime === "number" && typeof finish?.rawTime === "number" && finish.rawTime > start.rawTime
      ? finish.rawTime - start.rawTime : null;
    const confidence = start && finish ? timingConfidence(start, finish) : "None";
    return {
      session,
      totalSeconds,
      needsReview: totalSeconds === null || confidence === "Low" || confidence === "None",
      searchText: normalizeSearch([session.name, session.climberName, session.location, session.date, session.attemptType, session.videoFileName, session.notes].filter(Boolean).join(" ")),
    };
  });
}

export function searchSavedAttempts(rows: SavedAttemptRow[], query: string, filter: SavedAttemptFilter, sort: SavedAttemptSort): SavedAttemptRow[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => row.searchText.includes(term)) &&
    (filter === "all" || (filter === "review" ? row.needsReview : !row.needsReview)))
    .sort((a, b) => {
      const primary = sort === "recorded" ? compareDates(b.session.date, a.session.date) : compareDates(b.session.updatedAt, a.session.updatedAt);
      return primary || compareDates(b.session.updatedAt, a.session.updatedAt) || a.session.name.localeCompare(b.session.name) || a.session.id.localeCompare(b.session.id);
    });
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

function compareDates(left: string | undefined, right: string | undefined): number {
  const stamp = (value: string | undefined) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return stamp(left) - stamp(right);
}
