import { describe, expect, it } from "vitest";
import { createPracticeSession } from "./practiceRecordings";
import { isSessionSnapshotSaved, savedBiomechanicsKey, savedSessionEditableKey } from "./sessionSavedState";
import { createDefaultBiomechanicsSession } from "./biomechanicsSession";

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

  it("preserves each dirty-state field when editable and pose keys are compared separately", () => {
    const saved = createPracticeSession("a");
    saved.biomechanics = createDefaultBiomechanicsSession();
    const edits: Array<(session: typeof saved) => void> = [
      session => { session.id += "-new"; },
      session => { session.attemptLineageId = "another-attempt"; },
      session => { session.analysisBuild = { schemaVersion: 1, appVersion: "0.30.0", commitSha: null, workingTreeDirty: null }; },
      session => { session.name += " edited"; },
      session => { session.climberName += " edited"; },
      session => { session.date = "2026-11-01"; },
      session => { session.location += " edited"; },
      session => { session.attemptType = "Competition"; },
      session => { session.notes += " edited"; },
      session => { session.videoFileName = "another.mp4"; },
      session => { session.videoMetadata!.duration += 1; },
      session => { session.videoMetadata!.fileName = "another.mp4"; },
      session => { session.videoMetadata!.videoWidth += 1; },
      session => { session.videoMetadata!.videoHeight += 1; },
      session => { session.zones.startBody = { id: "startBody", label: "Athlete", x1: .1, x2: .3, y1: .5, y2: .9 }; },
      session => { session.startLightCalibration.calibrationFrameBeforeTime = .8; },
      session => { session.settings.startSensitivity = "high"; },
      session => { session.timestamps[0].acceptanceMode = "frame-review"; },
      session => { session.biomechanics!.settings.minVisibility = .6; },
    ];
    for (const edit of edits) {
      const changed = structuredClone(saved); edit(changed);
      const sameParts = savedSessionEditableKey(saved) === savedSessionEditableKey(changed) &&
        savedBiomechanicsKey(saved.biomechanics) === savedBiomechanicsKey(changed.biomechanics);
      expect(sameParts).toBe(false);
      expect(isSessionSnapshotSaved(changed, saved)).toBe(false);
    }
  });

  it("keeps pose evidence independent of text edits and does not cache mutable caller values", () => {
    const saved = createPracticeSession("a");
    saved.biomechanics = createDefaultBiomechanicsSession();
    const before = savedBiomechanicsKey(saved.biomechanics);
    const edited = { ...saved, name: "Renamed", notes: "Longer notes" };
    expect(savedSessionEditableKey(edited)).not.toBe(savedSessionEditableKey(saved));
    expect(savedBiomechanicsKey(edited.biomechanics)).toBe(before);
    const editableBefore = savedSessionEditableKey(saved);
    saved.biomechanics.settings.minVisibility = .6;
    expect(savedBiomechanicsKey(saved.biomechanics)).not.toBe(before);
    expect(savedSessionEditableKey(saved)).toBe(editableBefore);
    saved.notes += " mutable caller";
    expect(savedSessionEditableKey(saved)).not.toBe(editableBefore);
  });
});
