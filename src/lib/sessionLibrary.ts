import type { SavedAnalysisSession } from "../types";
import { sanitizeAttemptLineageId } from "./attemptIdentity";

export const SESSION_LIBRARY_FORMAT = "climbiq-session-library";
export const SESSION_LIBRARY_VERSION = 1;

export interface SessionLibraryBackup {
  format: typeof SESSION_LIBRARY_FORMAT;
  version: typeof SESSION_LIBRARY_VERSION;
  exportedAt: string;
  sessions: SavedAnalysisSession[];
}

export interface SessionLibraryMergeResult {
  sessions: SavedAnalysisSession[];
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
  updatedSessionIds: string[];
}

/** Updating an existing record cannot erase or reassign its known attempt identity. */
export function preserveKnownAttemptLineage(
  existing: SavedAnalysisSession | undefined,
  incoming: SavedAnalysisSession,
): SavedAnalysisSession {
  const known = existing?.id === incoming.id ? sanitizeAttemptLineageId(existing.attemptLineageId) : undefined;
  const lineage = known ?? sanitizeAttemptLineageId(incoming.attemptLineageId);
  return incoming.attemptLineageId === lineage ? incoming : { ...incoming, attemptLineageId: lineage };
}

export function createSessionLibraryBackup(
  sessions: SavedAnalysisSession[],
  exportedAt = new Date().toISOString(),
): SessionLibraryBackup {
  return {
    format: SESSION_LIBRARY_FORMAT,
    version: SESSION_LIBRARY_VERSION,
    exportedAt,
    sessions,
  };
}

export function isSessionLibraryBackup(value: unknown): value is SessionLibraryBackup {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionLibraryBackup>;
  return candidate.format === SESSION_LIBRARY_FORMAT &&
    candidate.version === SESSION_LIBRARY_VERSION &&
    typeof candidate.exportedAt === "string" &&
    Array.isArray(candidate.sessions);
}

export function mergeSessionLibraries(
  current: SavedAnalysisSession[],
  imported: SavedAnalysisSession[],
): SessionLibraryMergeResult {
  const merged = new Map(current.map((session) => [session.id, session]));
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const updatedSessionIds = new Set<string>();

  for (const incoming of imported) {
    const existing = merged.get(incoming.id);
    if (!existing) {
      merged.set(incoming.id, preserveKnownAttemptLineage(undefined, incoming));
      addedCount += 1;
      continue;
    }

    if (timestampValue(incoming.updatedAt) > timestampValue(existing.updatedAt)) {
      merged.set(incoming.id, preserveKnownAttemptLineage(existing, incoming));
      updatedCount += 1;
      updatedSessionIds.add(incoming.id);
    } else {
      unchangedCount += 1;
    }
  }

  return {
    sessions: [...merged.values()].sort(compareNewestFirst),
    addedCount,
    updatedCount,
    unchangedCount,
    updatedSessionIds: [...updatedSessionIds],
  };
}

function compareNewestFirst(left: SavedAnalysisSession, right: SavedAnalysisSession): number {
  const timestampDifference = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  return timestampDifference || right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name);
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
