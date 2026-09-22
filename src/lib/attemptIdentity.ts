import type { SavedAnalysisSession } from "../types";
import { sanitizeTimestampSequence } from "./timestampIntegrity";

export interface AttemptIdentityAssessment {
  relationship: "same-attempt" | "possible-overlap" | "distinct-or-unknown";
  requiresDistinctAttemptConfirmation: boolean;
  explanation: string;
}

/** Never trim or truncate opaque IDs into the identity of another attempt. */
export function sanitizeAttemptLineageId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

export function resolveAttemptLineageId(session: Pick<SavedAnalysisSession, "id" | "attemptLineageId">): string {
  return sanitizeAttemptLineageId(session.attemptLineageId) ?? session.id;
}

function acceptedRange(session: SavedAnalysisSession): [number, number] | undefined {
  const markers = sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration);
  const start = markers.find(marker => marker.id === "startSignal" && marker.source !== "Not set")?.rawTime;
  const finish = markers.find(marker => marker.id === "finishPad" && marker.source !== "Not set")?.rawTime;
  return typeof start === "number" && typeof finish === "number" && Number.isFinite(start) && Number.isFinite(finish) && finish > start
    ? [start, finish] : undefined;
}

/** Metadata suggests a possible collision; it never establishes file identity. */
export function assessAttemptIdentity(left: SavedAnalysisSession, right: SavedAnalysisSession): AttemptIdentityAssessment {
  if (left.id === right.id || resolveAttemptLineageId(left) === resolveAttemptLineageId(right)) {
    return { relationship: "same-attempt", requiresDistinctAttemptConfirmation: false,
      explanation: "These are analyses of the same attempt. Timing edits are annotation differences, not a performance gain or loss." };
  }
  const a = left.videoMetadata, b = right.videoMetadata;
  const matchingDetails = a && b && typeof a.fileName === "string" && a.fileName.length > 0 && a.fileName === b.fileName &&
    Number.isFinite(a.duration) && a.duration > 0 && a.duration === b.duration &&
    Number.isFinite(a.videoWidth) && a.videoWidth > 0 && a.videoWidth === b.videoWidth &&
    Number.isFinite(a.videoHeight) && a.videoHeight > 0 && a.videoHeight === b.videoHeight;
  const leftRange = matchingDetails ? acceptedRange(left) : undefined;
  const rightRange = matchingDetails ? acceptedRange(right) : undefined;
  if (leftRange && rightRange && Math.max(leftRange[0], rightRange[0]) < Math.min(leftRange[1], rightRange[1])) {
    return { relationship: "possible-overlap", requiresDistinctAttemptConfirmation: true,
      explanation: "The recording details and time ranges overlap. Metadata cannot identify the files. Confirm these are different climbing attempts, not two analyses of one attempt." };
  }
  return { relationship: "distinct-or-unknown", requiresDistinctAttemptConfirmation: false,
    explanation: "Only compare two distinct attempts by the same climber on the same route with comparable recording conditions." };
}

/** A confirmation belongs to these exact saved versions and selected time ranges. */
export function attemptIdentityConfirmationKey(left: SavedAnalysisSession, right: SavedAnalysisSession): string {
  return JSON.stringify([left, right].map(session => ({
    id: session.id, lineage: resolveAttemptLineageId(session), updatedAt: session.updatedAt,
    video: session.videoMetadata, range: acceptedRange(session),
  })));
}
