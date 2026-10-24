import { describe, expect, it } from "vitest";
import { guidedIndicatorSearchWindow, normalizeFinishIndicatorZone } from "./guidedFinishIndicator";
import { createPracticeSession } from "./practiceRecordings";
import { createDefaultBiomechanicsSession } from "./biomechanicsSession";
import { createSessionDataset } from "./sessionExport";
import { datasetToSavedSession, sanitizeSavedSession } from "./sessionCodec";

describe("guided indicator ownership and window", () => {
  it("keeps a manually marked sensor separate through save/export/import", () => {
    const session = createPracticeSession("a");
    const sensor = normalizeFinishIndicatorZone({ x1: .74, x2: .76, y1: .28, y2: .30 })!;
    session.zones = { finishIndicator: sensor,
      finishLight: { ...sensor, id: "finishLight", label: "Auto-detected upper finish indicator" },
      finishPad: { ...sensor, id: "finishPad", label: "Finish Pad Review Area", x1: .65, x2: .7 } };
    const before = JSON.stringify(session.timestamps);
    const saved = sanitizeSavedSession(session);
    const dataset = createSessionDataset({ session: saved, biomechanics: createDefaultBiomechanicsSession(),
      exportedAt: new Date(0).toISOString(), exportBuild: { schemaVersion: 1, appVersion: "test", commitSha: null, workingTreeDirty: null },
      startResult: null, movementResult: null, finishResult: null, startEvidenceStatus: "", autoAnalysisStatus: "", finishStatus: "" });
    const imported = datasetToSavedSession(dataset);
    expect(imported.zones.finishIndicator).toEqual(sensor);
    expect(imported.zones.finishPad?.id).toBe("finishPad");
    expect(imported.zones.finishLight?.id).toBe("finishLight");
    expect(JSON.stringify(session.timestamps)).toBe(before);
    expect(imported.timestamps.map(marker => marker.rawTime)).toEqual(session.timestamps.map(marker => marker.rawTime));
  });
  it("uses the current review cursor rather than searching a later race", () => {
    const window = guidedIndicatorSearchWindow(25.9, 90, 18.5)!;
    expect(window.start).toBeCloseTo(24.65);
    expect(window.end).toBeCloseTo(27.15);
    expect(window.minimumClimbSeconds).toBeCloseTo(6.15);
    expect(window.maximumClimbSeconds).toBeCloseTo(8.65);
    expect(guidedIndicatorSearchWindow(3, 20, 4)).toBeUndefined();
    expect(guidedIndicatorSearchWindow(NaN, 20, 4)).toBeUndefined();
  });
  it.each([
    { x1: -.1, y1: .2, x2: .2, y2: .3 },
    { x1: .1, y1: .2, x2: Infinity, y2: .3 },
    { x1: .1, y1: .2, x2: .101, y2: .3 },
    { x1: 0, y1: 0, x2: 1, y2: 1 },
  ])("rejects invalid or unusable marked areas %j", value => {
    expect(normalizeFinishIndicatorZone(value)).toBeUndefined();
  });
});
