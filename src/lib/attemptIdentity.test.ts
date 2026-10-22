import { describe, expect, it } from "vitest";
import type { SavedAnalysisSession } from "../types";
import { assessAttemptIdentity, attemptIdentityConfirmationKey, resolveAttemptLineageId, sanitizeAttemptLineageId } from "./attemptIdentity";

function attempt(id: string, start = 1, finish = 11): SavedAnalysisSession {
  return { id, version: 1, name: id, climberName: "", date: "", location: "", notes: "", attemptType: "Training",
    createdAt: "2026-09-22", updatedAt: "2026-09-22", zones: {}, startLightCalibration: {},
    videoMetadata: { fileName: "meet.mp4", duration: 120, videoWidth: 1920, videoHeight: 1080, metadataLoaded: true },
    settings: { startSearchStart: 0, startSearchEnd: 12, startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto", reactionTimeOffset: 0, startSignalOffset: 0, movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: .1, firstMovementOffset: 0, officialTotalTime: "" },
    timestamps: [{ id: "startSignal", label: "Start", rawTime: start, climbTime: 0, source: "Manual", confidence: "High" },
      { id: "finishPad", label: "Finish", rawTime: finish, climbTime: finish - start, source: "Manual", confidence: "High" }],
  };
}

describe("attempt comparison identity", () => {
  it.each([undefined, null, 2, {}, "", "  ", "bad\nlineage", "x".repeat(257)])("drops invalid opaque lineage %j", value => {
    expect(sanitizeAttemptLineageId(value)).toBeUndefined();
  });
  it("preserves accepted opaque IDs without trimming or truncating", () => {
    expect(sanitizeAttemptLineageId(" original-α ")).toBe(" original-α ");
    expect(resolveAttemptLineageId({ id: "original" })).toBe("original");
    expect(resolveAttemptLineageId({ id: "copy", attemptLineageId: "original" })).toBe("original");
  });
  it("recognizes known copies after a finish correction or a file rename", () => {
    const original = attempt("original"), copy = attempt("copy", 1, 10.6);
    copy.attemptLineageId = original.id;
    copy.videoMetadata!.fileName = "renamed.mp4";
    expect(assessAttemptIdentity(original, copy)).toMatchObject({ relationship: "same-attempt", requiresDistinctAttemptConfirmation: false });
  });
  it("blocks the same saved ID even if imported timestamps and lineage disagree", () => {
    const original = attempt("same-id"), changed = attempt("same-id", 20, 29);
    original.attemptLineageId = "first-origin"; changed.attemptLineageId = "other-origin";
    expect(assessAttemptIdentity(original, changed).relationship).toBe("same-attempt");
  });
  it("handles missing metadata and unrecognized lineage without claiming file identity", () => {
    const first = attempt("a"), second = attempt("b");
    first.videoMetadata = null; second.videoMetadata = null;
    first.attemptLineageId = "bad\nlineage"; second.attemptLineageId = undefined;
    expect(assessAttemptIdentity(first, second)).toMatchObject({ relationship: "distinct-or-unknown", requiresDistinctAttemptConfirmation: false });
    expect(resolveAttemptLineageId(first)).toBe("a");
  });
  it("does not turn marker edits into a new identity, even if an annotation is moved", () => {
    const original = attempt("original"), copy = attempt("copy", 31, 41);
    copy.attemptLineageId = original.id;
    expect(assessAttemptIdentity(original, copy).relationship).toBe("same-attempt");
  });
  it("requires confirmation for overlapping metadata matches, not a hard file-identity claim", () => {
    const original = attempt("a"), uncertain = attempt("b", 1, 10.6);
    expect(assessAttemptIdentity(original, uncertain)).toMatchObject({ relationship: "possible-overlap", requiresDistinctAttemptConfirmation: true });
    expect(assessAttemptIdentity(original, uncertain).explanation).toContain("Metadata cannot identify the files");
  });
  it("allows genuinely disjoint attempts within a long recording", () => {
    expect(assessAttemptIdentity(attempt("a"), attempt("b", 31, 40.6))).toMatchObject({ relationship: "distinct-or-unknown", requiresDistinctAttemptConfirmation: false });
    expect(assessAttemptIdentity(attempt("a"), attempt("b", 11, 21)).relationship).toBe("distinct-or-unknown");
  });
  it("does not block separate files with colliding metadata and exact timing", () => {
    expect(assessAttemptIdentity(attempt("a"), attempt("b")).relationship).toBe("possible-overlap");
  });
  it("does not infer file identity from a filename alone or empty dimensions", () => {
    const first = attempt("a"), second = attempt("b");
    second.videoMetadata!.duration = 121;
    expect(assessAttemptIdentity(first, second).relationship).toBe("distinct-or-unknown");
    second.videoMetadata!.duration = 120; first.videoMetadata!.videoWidth = 0; second.videoMetadata!.videoWidth = 0;
    expect(assessAttemptIdentity(first, second).relationship).toBe("distinct-or-unknown");
  });
  it("ties overlap confirmation to current versions, identities, and ranges", () => {
    const first = attempt("a"), second = attempt("b");
    const key = attemptIdentityConfirmationKey(first, second);
    second.updatedAt = "2026-09-23";
    expect(attemptIdentityConfirmationKey(first, second)).not.toBe(key);
    second.updatedAt = "2026-09-22"; second.timestamps[1].rawTime = 10.5;
    expect(attemptIdentityConfirmationKey(first, second)).not.toBe(key);
  });
});
