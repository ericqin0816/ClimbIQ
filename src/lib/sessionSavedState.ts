import type { SavedAnalysisSession } from "../types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Compare editable content, excluding save clocks and transient decoder readiness. */
export function savedSessionContentKey(session: SavedAnalysisSession): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, splitCalculations: _derivedSplits, videoMetadata, ...content } = session;
  return JSON.stringify(canonical({ ...content, videoMetadata: videoMetadata ? {
    fileName: videoMetadata.fileName, duration: videoMetadata.duration,
    videoWidth: videoMetadata.videoWidth, videoHeight: videoMetadata.videoHeight,
  } : null }));
}

export function isSessionSnapshotSaved(snapshot: SavedAnalysisSession, saved?: SavedAnalysisSession): boolean {
  return !!saved && saved.id === snapshot.id && savedSessionContentKey(snapshot) === savedSessionContentKey(saved);
}
