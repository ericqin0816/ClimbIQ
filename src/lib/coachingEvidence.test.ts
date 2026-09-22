import { describe, expect, it } from "vitest";
import type { SavedAnalysisSession, TimestampMarker } from "../types";
import { buildCoachingEvidence, coachingBaselineOptions, coachingEvidenceFingerprint, coachingRunFacts } from "./coachingEvidence";

function session(): SavedAnalysisSession {
  const markers = [["startSignal", 9.4], ["firstMovement", 9.6], ["hold10", 15.9], ["finishPad", 21.655]] as const;
  return { id: "test", version: 1, name: "PRIVATE FILE", climberName: "PRIVATE NAME", location: "PRIVATE GYM", notes: "PRIVATE NOTES", date: "2026-09-08", attemptType: "Training", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", videoMetadata: null, videoFileName: "PRIVATE.mov", zones: {}, startLightCalibration: {},
    settings: { startSearchStart: 0, startSearchEnd: 12, startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto", reactionTimeOffset: 0, startSignalOffset: 0, movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: .08, firstMovementOffset: 0, officialTotalTime: "12.24" },
    timestamps: markers.map(([id, rawTime]): TimestampMarker => ({ id, label: id, rawTime, climbTime: null, confidence: "High", source: "Manual" })),
  };
}
describe("coaching session adapter", () => {
  it("uses accepted timing, not the user-entered official total", () => {
    expect(coachingRunFacts(session()).totalSeconds).toBeCloseTo(12.255);
  });
  it("requires frame-review provenance, not just a manually entered Hold 10", () => {
    const s = session(); expect(coachingRunFacts(s).reviewedHold10).toBe(false);
    s.timestamps.find(m => m.id === "hold10")!.acceptanceMode = "frame-review";
    expect(coachingRunFacts(s)).toMatchObject({ reviewedHold10: true, bottomSeconds: 6.5, topSeconds: 5.755 });
  });
  it("does not send private strings, raw times or metadata to the server", () => {
    const result = buildCoachingEvidence(session(), "overview");
    expect(JSON.stringify(result.packet)).not.toMatch(/PRIVATE|rawTime|fileName|location|notes/);
    expect(result.links.total).toEqual([{ label: "View Start", rawTime: 9.4 }, { label: "View Finish", rawTime: 21.655 }]);
  });
  it("withholds low-confidence timing and impossible chronology", () => {
    const s = session(); s.timestamps.find(m => m.id === "finishPad")!.confidence = "Low";
    expect(coachingRunFacts(s).timingState).toBe("review");
    s.timestamps.find(m => m.id === "finishPad")!.rawTime = 8;
    expect(coachingRunFacts(s).totalSeconds).toBeNull();
  });
  it("prevents self-comparison and rejects incomplete baseline timing", () => {
    const current = session();
    const missing = { ...session(), id: "missing", timestamps: [] };
    const other = { ...session(), id: "other", name: "Other attempt" };
    expect(coachingBaselineOptions(current, [current, missing, other])).toMatchObject([
      { id: current.id, eligible: false, reason: "Current attempt" },
      { id: "missing", eligible: false, reason: "Start or Finish needs review" },
      { id: "other", eligible: true, totalSeconds: 12.255 },
    ]);
    expect(() => buildCoachingEvidence(current, "overview", current)).toThrow("different saved attempt");
    expect(() => buildCoachingEvidence(current, "overview", missing)).toThrow("different saved attempt");
  });
  it("requests distinct-attempt confirmation for ambiguous metadata collisions", () => {
    const current = session();
    current.videoMetadata = { fileName: "run.mov", duration: 25, videoWidth: 640, videoHeight: 480, metadataLoaded: true };
    const copy = { ...current, id: "copy", name: "Copy" };
    const independent = { ...copy, id: "independent", videoMetadata: { ...current.videoMetadata, fileName: "next.mov" } };
    expect(coachingBaselineOptions(current, [copy, independent])).toMatchObject([
      { eligible: true, requiresDistinctAttemptConfirmation: true }, { eligible: true, requiresDistinctAttemptConfirmation: false },
    ]);
    expect(() => buildCoachingEvidence(current, "overview", copy)).toThrow("two distinct climbing attempts");
    expect(buildCoachingEvidence(current, "overview", copy, { distinctAttemptsConfirmed: true }).packet.baseline).not.toBeNull();
    copy.attemptLineageId = current.id;
    expect(() => buildCoachingEvidence(current, "overview", copy, { distinctAttemptsConfirmed: true })).toThrow("different saved attempt");
  });
  it("invalidates changed source identity and raw timing even when numeric intervals match", () => {
    const current = session();
    const before = coachingEvidenceFingerprint(current);
    expect(coachingEvidenceFingerprint({ ...current, updatedAt: "2099-01-01" })).toBe(before);
    expect(coachingEvidenceFingerprint({ ...current, id: "different" })).not.toBe(before);
    const shifted = { ...current, timestamps: current.timestamps.map(marker => ({ ...marker, rawTime: marker.rawTime! + 2 })) };
    expect(coachingRunFacts(shifted)).toEqual(coachingRunFacts(current));
    expect(coachingEvidenceFingerprint(shifted)).not.toBe(before);
  });
  it("includes baseline revisions in local identity but never in the hosted packet", () => {
    const current = session(), baseline = { ...session(), id: "baseline" };
    const before = buildCoachingEvidence(current, "overview", baseline);
    baseline.timestamps = baseline.timestamps.map(marker => marker.id === "finishPad" ? { ...marker, rawTime: 22 } : marker);
    expect(coachingEvidenceFingerprint(current, baseline)).not.toBe(before.sourceFingerprint);
    expect(JSON.stringify(before.packet)).not.toMatch(/PRIVATE|sourceFingerprint|attemptLineageId|rawTime|fileName|location|notes/);
  });
  it("does not alter accepted markers while producing review links", () => {
    const current = session();
    const before = JSON.stringify(current);
    buildCoachingEvidence(current, "halves");
    expect(JSON.stringify(current)).toBe(before);
  });
  it("keeps a coarse Hold 10 interval out of the total comparison rule", () => {
    const current = session();
    current.timestamps.forEach(marker => { marker.observationIntervalSeconds = 1 / 60; });
    const hold = current.timestamps.find(marker => marker.id === "hold10")!;
    hold.acceptanceMode = "frame-review"; hold.observationIntervalSeconds = .35;
    const facts = coachingRunFacts(current);
    expect(facts.comparisonFloorsSeconds.total).toBe(.1);
    expect(facts.comparisonFloorsSeconds.bottom).toBeCloseTo(.733333);
    expect(facts.comparisonFloorsSeconds.top).toBeCloseTo(.733333);
    const baseline = { ...session(), id: "baseline", timestamps: current.timestamps.map(marker => marker.id === "finishPad" ? { ...marker, rawTime: marker.rawTime! + .3 } : { ...marker }) };
    const evidence = buildCoachingEvidence(current, "overview", baseline);
    expect(evidence.packet.version).toBe(2);
    expect(evidence.catalog.comparisonRows[0]).toMatchObject({ outcome: "shorter", thresholdSeconds: .1, deltaSeconds: -.3 });
  });
  it.each(["startSignal", "finishPad"] as const)("raises only comparisons that use a coarse %s boundary", boundary => {
    const current = session();
    current.timestamps.forEach(marker => { marker.observationIntervalSeconds = 1 / 60; });
    current.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
    current.timestamps.find(marker => marker.id === boundary)!.observationIntervalSeconds = .35;
    const floors = coachingRunFacts(current).comparisonFloorsSeconds;
    expect(floors.total).toBeCloseTo(.733333);
    expect(floors[boundary === "startSignal" ? "bottom" : "top"]).toBeCloseTo(.733333);
    expect(floors[boundary === "startSignal" ? "top" : "bottom"]).toBe(.1);
  });
});
