import { describe, expect, it } from "vitest";
import { createPracticeSession } from "./practiceRecordings";
import { isSessionSnapshotSaved } from "./sessionSavedState";

describe("saved content state", () => {
  it("ignores save clocks and the decoder's temporary readiness", () => {
    const saved = createPracticeSession("a");
    const reopened = structuredClone(saved);
    reopened.updatedAt = "2026-10-23T00:00:00Z";
    reopened.videoMetadata!.metadataLoaded = false;
    expect(isSessionSnapshotSaved(reopened, saved)).toBe(true);
  });
  it("requires saving marker corrections, settings, notes, and identity changes", () => {
    const saved = createPracticeSession("a");
    for (const edit of [
      (session: typeof saved) => { session.timestamps[0].rawTime = 1.1; },
      (session: typeof saved) => { session.settings.startSensitivity = "high"; },
      (session: typeof saved) => { session.notes += " Correction needed"; },
      (session: typeof saved) => { session.id += "-copy"; },
    ]) {
      const edited = structuredClone(saved); edit(edited);
      expect(isSessionSnapshotSaved(edited, saved)).toBe(false);
      expect(isSessionSnapshotSaved(edited, structuredClone(edited))).toBe(true);
    }
  });
  it("treats JSON key order consistently and missing records as unsaved", () => {
    const saved = createPracticeSession("b");
    expect(isSessionSnapshotSaved(saved, Object.fromEntries(Object.entries(saved).reverse()) as typeof saved)).toBe(true);
    expect(isSessionSnapshotSaved(saved)).toBe(false);
  });
});
