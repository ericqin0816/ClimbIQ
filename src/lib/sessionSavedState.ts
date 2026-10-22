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

/** Small editable fields can change while the immutable pose state is reused. */
export function savedSessionEditableKey(session: SavedAnalysisSession): string {
  const { biomechanics: _poseEvidence, ...editable } = session;
  return savedSessionContentKey(editable);
}

/** Pure and uncached: callers may memoize only an immutable React state value. */
export function savedBiomechanicsKey(biomechanics: SavedAnalysisSession["biomechanics"]): string {
  return JSON.stringify(canonical(biomechanics ?? null));
}

export function isSessionSnapshotSaved(snapshot: SavedAnalysisSession, saved?: SavedAnalysisSession): boolean {
  return !!saved && saved.id === snapshot.id && savedSessionContentKey(snapshot) === savedSessionContentKey(saved);
}
