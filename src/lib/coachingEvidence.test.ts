import { describe, expect, it } from "vitest";
import type { SavedAnalysisSession, TimestampMarker } from "../types";
import { buildCoachingEvidence, coachingRunFacts } from "./coachingEvidence";

function session(): SavedAnalysisSession {
  const markers = [["startSignal", 9.4], ["firstMovement", 9.6], ["hold10", 15.9], ["finishPad", 21.655]] as const;
  return { id: "test", version: 1, name: "PRIVATE FILE", climberName: "PRIVATE NAME", location: "PRIVATE GYM", notes: "PRIVATE NOTES", date: "2026-09-08", attemptType: "Training", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", videoMetadata: null, videoFileName: "PRIVATE.mov", zones: {}, startLightCalibration: {},
    settings: { startSearchStart: 0, startSearchEnd: 12, startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto", reactionTimeOffset: 0, startSignalOffset: 0, movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: .08, firstMovementOffset: 0, officialTotalTime: "12.24" },
    timestamps: markers.map(([id, rawTime]): TimestampMarker => ({ id, label: id, rawTime, climbTime: null, confidence: "High", source: "Manual" })),
  };
}
describe("coaching session adapter", () => {
  it("links reviewed phase differences in the current video's clock and keeps them local", () => {
    const baseline = session(); baseline.id = "baseline";
    const current = session();
    for (const s of [baseline, current]) s.timestamps.find(m => m.id === "hold10")!.acceptanceMode = "frame-review";
    current.timestamps.find(m => m.id === "hold10")!.rawTime = 16.9;
    const review = buildCoachingEvidence(current, "overview", baseline);
    expect(review.sectionReview.items).toMatchObject([
      { id: "bottom-phase", deltaSeconds: 1, startRawTime: 9.4, endRawTime: 16.9 },
      { id: "top-phase", deltaSeconds: -1, startRawTime: 16.9, endRawTime: 21.655 },
    ]);
    expect(JSON.stringify(review.packet)).not.toMatch(/sectionReview|rawTime|PRIVATE/);
    baseline.timestamps.find(m => m.id === "hold10")!.acceptanceMode = undefined;
    expect(buildCoachingEvidence(current, "overview", baseline).sectionReview.items).toHaveLength(0);
  });
  it("does not flag phase changes inside the threshold or from low-confidence endpoints", () => {
    const baseline = session(), current = session();
    for (const s of [baseline, current]) s.timestamps.find(m => m.id === "hold10")!.acceptanceMode = "frame-review";
    current.timestamps.find(m => m.id === "hold10")!.rawTime! += .05;
    expect(buildCoachingEvidence(current, "overview", baseline).sectionReview.items).toHaveLength(0);
    current.timestamps.find(m => m.id === "hold10")!.rawTime! += 1;
    current.timestamps.find(m => m.id === "finishPad")!.confidence = "Low";
    expect(buildCoachingEvidence(current, "overview", baseline).sectionReview.items).toHaveLength(0);
  });
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
});
