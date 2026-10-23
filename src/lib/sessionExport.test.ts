import { describe, expect, it } from "vitest";
import { createPracticeSession } from "./practiceRecordings";
import { createDefaultBiomechanicsSession } from "./biomechanicsSession";
import { datasetToSavedSession } from "./sessionCodec";
import { createSessionDataset, buildSplitMap, type SessionExportInput } from "./sessionExport";
import { createSessionReport } from "./sessionReport";

function input(): SessionExportInput {
  const session = createPracticeSession("a");
  session.settings.officialTotalTime = "5.600";
  session.date = "2026-10-22";
  session.splitCalculations = buildSplitMap([{ label: "Calculated Total Time", value: 5.6 },
    { label: "Start to Hold 10", value: 2.8 }, { label: "Hold 10 to Finish", value: 2.8 }]);
  return { session, exportBuild: { schemaVersion: 1, appVersion: "0.30.0", commitSha: "b".repeat(40), workingTreeDirty: false },
    exportedAt: "2026-10-23T01:00:00.000Z", biomechanics: createDefaultBiomechanicsSession(),
    startResult: null, movementResult: null, finishResult: null, startEvidenceStatus: "", autoAnalysisStatus: "", finishStatus: "" };
}

describe("portable dataset and report boundary", () => {
  it("preserves the existing dataset envelope, timing audits, and round-trip markers", () => {
    const source = input();
    const before = JSON.stringify(source);
    const dataset = createSessionDataset(source);
    expect(Object.keys(dataset)).toEqual(["appVersion", "exportBuild", "analysisBuild", "exportTimestamp", "session", "video", "zones", "calibration", "settings", "acceptedTimestamps", "candidates", "splitCalculations", "sourceFrameTimingAudit", "hold10PhaseAnalysis", "hold10SecondPassEvidence", "detectionWarnings", "automationAudit", "startLaneEvidenceAudit", "finishEvidenceAudit", "biomechanics", "athleteNotes"]);
    expect(dataset).toMatchObject({ appVersion: "0.30.0", exportBuild: source.exportBuild, analysisBuild: null,
      exportTimestamp: source.exportedAt, video: { officialTotalTime: 5.6 },
      hold10PhaseAnalysis: { available: true, startToHold10Seconds: 2.8, hold10ToFinishSeconds: 2.8, bottomPhaseShare: .5, topPhaseShare: .5 },
      automationAudit: { startEvidence: null, automaticAnalysis: null, finishAnalysis: null } });
    expect(dataset.acceptedTimestamps.find(marker => marker.markerId === "startSignal")).toMatchObject({ acceptedRawTime: 1,
      accepted: true, acceptanceMode: "manual-entry", userAccepted: true, isGroundTruthLabel: false });
    const restored = datasetToSavedSession(JSON.parse(JSON.stringify(dataset)));
    expect(restored.timestamps).toMatchObject(source.session.timestamps);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps analysis provenance independent of export build in JSON and Markdown", () => {
    const source = input();
    source.session.analysisBuild = { schemaVersion: 1, appVersion: "0.29.0", commitSha: "a".repeat(40), workingTreeDirty: true };
    const dataset = createSessionDataset(source);
    const report = createSessionReport(dataset, { fallbackDate: "unused" });
    const embedded = JSON.parse(report.split("```json\n")[1].split("\n```")[0]);
    expect(embedded).toMatchObject({ appVersion: dataset.appVersion, exportTimestamp: dataset.exportTimestamp,
      exportBuild: source.exportBuild, analysisBuild: source.session.analysisBuild, timestamps: dataset.acceptedTimestamps,
      session: dataset.session, video: dataset.video, splits: dataset.splitCalculations });
    expect(report).toContain("- Calculated total: 5.600s");
    expect(report).toContain("| Start Signal | 1.000s | 0.000s | Manual | High |");
    // Markdown keeps the established `timestamps` alias in its machine section.
    expect(datasetToSavedSession({ ...embedded, acceptedTimestamps: embedded.timestamps }).analysisBuild).toEqual(source.session.analysisBuild);
  });

  it("uses captured report inputs, local date fallback, and escaped frontmatter", () => {
    const source = input();
    source.session.name = "Session \"one\"\nnext";
    source.session.climberName = "Alex\nQin";
    source.session.date = "";
    source.session.timestamps.find(marker => marker.id === "startSignal")!.note = "";
    const dataset = createSessionDataset(source);
    const report = createSessionReport(dataset, { fallbackDate: "2026-10-22", startReason: "Captured detector reason" });
    expect(report).toContain('session_name: "Session \\"one\\"\\nnext"');
    expect(report).toContain('climber: "Alex\\nQin"');
    expect(report).toContain('date: "2026-10-22"');
    expect(report).toContain("- Start Signal: Captured detector reason");
    expect(report).not.toContain("# ClimbIQ Attempt - 2026-10-23");
  });

  it("retains diagnostic warnings and candidate selection fields without relabeling them", () => {
    const source = input();
    source.session.zones.startLight = { id: "startLight", label: "Test", x1: 0, x2: .5, y1: 0, y2: .5 };
    source.startResult = { detected: true, rawTime: 1, confidence: "High", reason: "Light transition", threshold: 10,
      debug: { zoneExists: true, framesSampled: 2, maxColorDistance: 20, threshold: 10, detectedCrossings: [], samples: [], failureReason: "Check light visibility" },
      candidates: [{ rawTime: 1, confidence: "High", reason: "Chosen transition", score: 1, kind: "light" },
        { rawTime: 2, confidence: "Low", reason: "Other transition", score: .1, kind: "light" }] };
    source.startResult.debug.audioTimingWindow = { startRawTime: .99, endRawTime: 1.01,
      hopSeconds: .01, isEventAccuracyBound: false };
    const dataset = createSessionDataset(source);
    expect(dataset.startLaneEvidenceAudit).toMatchObject({ scope: "current-analysis-only", isGroundTruthLabel: false,
      audioTimingWindow: source.startResult.debug.audioTimingWindow });
    expect(dataset.candidates.startSignal).toMatchObject([{ accepted: true, rejected: false, candidateRawTime: 1 },
      { accepted: false, rejected: true, candidateRawTime: 2 }]);
    expect(dataset.detectionWarnings).toEqual(["Check light visibility", "Start Light Zone may be large for light detection."]);
  });

  it("keeps an incomplete Finish scan separate from accepted markers and exact event accuracy", () => {
    const source = input();
    const partial = { requestedTime: 13.27, observedThroughTime: 13.233333, lastFrameRawTime: 13.2,
      lastFrameDurationSeconds: .033333, containerDuration: 13.328254,
      reason: "Container tail has no verified video frame", isEventAccuracyBound: false as const };
    source.finishResult = { detected: true, rawTime: 8.2, confidence: "Low", reason: "Review incomplete scan", threshold: 1,
      debug: { zoneExists: true, framesSampled: 40, maxColorDistance: 20, threshold: 1, detectedCrossings: [], samples: [],
        detectionMethod: "top reach", finishEvidenceKind: "physical-top-reach", partialSourceObservation: partial } };
    const dataset = createSessionDataset(source);
    expect(dataset.finishEvidenceAudit).toMatchObject({ scope: "current-analysis-only", isGroundTruthLabel: false, isEventAccuracyBound: false,
      confidence: "Low", proposedRawTime: 8.2, evidenceKind: "physical-top-reach", partialSourceObservation: partial });
    // Exporting diagnostic Finish evidence does not replace a reviewed marker.
    expect(dataset.acceptedTimestamps.find(marker => marker.markerId === "finishPad")?.acceptedRawTime).toBe(6.6);
    const report = createSessionReport(dataset, { fallbackDate: "unused" });
    const embedded = JSON.parse(report.split("```json\n")[1].split("\n```\n")[0]);
    expect(embedded.finishEvidenceAudit.partialSourceObservation).toEqual(partial);
    // On reload, saved marker notes preserve the source limitation even though
    // transient detector state is intentionally absent.
    source.session.timestamps.find(marker => marker.id === "finishPad")!.note = `Frame reviewed. ${partial.reason}`;
    const restored = datasetToSavedSession(createSessionDataset(source));
    source.session = restored;
    source.finishResult = null;
    const afterReload = createSessionDataset(source);
    expect(afterReload.finishEvidenceAudit).toMatchObject({ available: false, detected: null, sourceFrameSamplingFailed: null, confidence: null });
    expect(createSessionReport(afterReload, { fallbackDate: "unused" })).toContain(`- Finish: Frame reviewed. ${partial.reason}`);
  });
});
