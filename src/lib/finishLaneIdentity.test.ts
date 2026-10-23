import { describe, expect, it } from "vitest";
import { assessFinishLaneIdentity, clearAutomaticLaneBiomechanics, clearAutomaticLaneDependentMarkers } from "./finishLaneIdentity";
import { startLaneId, type AnalysisLaneCandidate } from "./startLaneEvidence";
import { createPracticeSession } from "./practiceRecordings";
import { createDefaultBiomechanicsSession } from "./biomechanicsSession";
import { summarizeAttemptTiming } from "./attemptComparison";
import type { BiomechanicsSession, TimestampMarker } from "../types";

const lane = (center: number): AnalysisLaneCandidate => ({
  zone: { id: "startLight", label: "Observed patch", x1: center - .01, x2: center + .01, y1: .74, y2: .76 },
  calibration: { beforeStartRGB: { r: 10, g: 100, b: 20 }, afterStartRGB: { r: 10, g: 20, b: 100 }, colorDelta: 113 },
  label: "Observed patch", startRawTime: 9.4, score: 10,
});
const assess = (lanes: AnalysisLaneCandidate[]) => assessFinishLaneIdentity({ acceptedStart: 9.4, laneCandidates: lanes });

describe("Finish athlete-lane identity", () => {
  it("preserves compatible left and right patch groups without certifying an athlete", () => {
    for (const centers of [[.2278, .3333, .3472], [.7389, .8389]]) {
      const lanes = centers.map(lane), result = assess(lanes);
      expect(result.requiresAthleteSelection).toBe(false);
      // The .3472 reflection remains within the existing .035 patch dedup.
      expect(result.candidates).toEqual(lanes.slice(0, 2));
    }
  });

  it("blocks the observed original and dark incompatible lane hypotheses", () => {
    for (const centers of [[.2278, .3333, .7556], [.3472, .7583]]) {
      const result = assess(centers.map(lane));
      expect(result.requiresAthleteSelection).toBe(true);
      expect(result.reason).toContain("Start is accepted");
      expect(result.reason).toContain("Start Body Zone");
      expect(result.reason).toContain("Finish manually");
    }
  });

  it("checks the full pool before the three-region scan budget", () => {
    const lanes = [.2, .27, .34, .75].map(lane), result = assess(lanes);
    expect(assess(lanes.slice(0, 3)).requiresAthleteSelection).toBe(false);
    expect(result.candidates).toEqual(lanes.slice(0, 3));
    expect(result.pool).toHaveLength(4);
    expect(result.requiresAthleteSelection).toBe(true);
    expect(result.conflicts.some(pair => pair.includes(startLaneId(lanes[3].zone)))).toBe(true);
  });

  it("is symmetric and does not merge incompatible endpoints through a bridging patch", () => {
    const [a, bridge, b] = [.6, .75, .9].map(lane);
    expect(assess([a, bridge]).requiresAthleteSelection).toBe(false);
    expect(assess([bridge, b]).requiresAthleteSelection).toBe(false);
    expect(assess([a, bridge, b]).requiresAthleteSelection).toBe(true);
    expect(assess([b, bridge, a]).requiresAthleteSelection).toBe(true);
    // At these positions only one automatic region contains the other center.
    expect(assess([lane(.55), lane(.8)]).requiresAthleteSelection).toBe(true);
    expect(assess([lane(.8), lane(.55)]).requiresAthleteSelection).toBe(true);
  });

  it("uses an explicit body selection only when it excludes the competing hypothesis", () => {
    const lanes = [.23, .76].map(lane);
    const options = { acceptedStart: 9.4, laneCandidates: lanes, lightZone: lanes[1].zone, lightCalibration: lanes[1].calibration };
    const selected = assessFinishLaneIdentity({ ...options,
      trustedBodyZone: { id: "startBody", label: "User climber", x1: .1, x2: .4, y1: .4, y2: .9 } });
    expect(selected.requiresAthleteSelection).toBe(false);
    expect(selected.candidates.map(value => value.zone)).toEqual([lanes[0].zone]);
    expect(assessFinishLaneIdentity({ ...options,
      trustedBodyZone: { id: "startBody", label: "Both climbers", x1: 0, x2: 1, y1: .4, y2: .9 } }).requiresAthleteSelection).toBe(true);
  });

  it("cannot use clock ties, official times, high scores or ordering to select an athlete", () => {
    const lanes = [.23, .76].map(lane), before = JSON.stringify(lanes);
    for (const ordered of [lanes, [...lanes].reverse()]) for (const official of [12.1, 25.9]) {
      // Official time is deliberately outside the assessment's supported inputs.
      const options = { acceptedStart: official, laneCandidates: ordered.map((value, i) => ({ ...value, score: i ? 1e9 : 1, confidence: "High" as const })), expectedFinishTime: official };
      expect(assessFinishLaneIdentity(options).requiresAthleteSelection).toBe(true);
    }
    expect(JSON.stringify(lanes)).toBe(before);
  });

  it("preserves nearby physical-patch deduplication and handles an empty pool", () => {
    const a = lane(.23), duplicate = lane(.235);
    expect(assess([a, duplicate]).pool).toEqual([a]);
    expect(assess([])).toMatchObject({ requiresAthleteSelection: false, candidates: [], conflicts: [] });
  });

  it("removes seeded old automatic timing and COM when shared identity blocking fires", () => {
    const session = createPracticeSession("a");
    const sources: TimestampMarker["source"][] = ["Fused start detection", "Body motion detection", "Body motion detection", "Manual", "Hold contact detection", "Finish light detection"];
    const times = [1, 1.25, 1.4, 2, 3.9, 6.6];
    session.timestamps = session.timestamps.map((marker, i) => ({ ...marker, rawTime: times[i], climbTime: times[i] - 1,
      source: sources[i], acceptanceMode: i === 3 ? "frame-review" : "automatic" }));
    const previous = structuredClone(session.timestamps), pose = oldAutomaticPose();
    expect(summarizeAttemptTiming(session).metrics.some(metric => metric.id === "total")).toBe(true);
    const identity = assess([lane(.23), lane(.76)]);
    expect(identity.requiresAthleteSelection).toBe(true);
    const timestamps = clearAutomaticLaneDependentMarkers(session.timestamps);
    const biomechanics = clearAutomaticLaneBiomechanics(pose);
    expect(timestamps[0]).toEqual(previous[0]);
    expect(timestamps[3]).toEqual(previous[3]); // Deliberate reviewed First Hold.
    for (const i of [1, 2, 4, 5]) expect(timestamps[i]).toMatchObject({ rawTime: null, source: "Not set", confidence: "None" });
    expect(summarizeAttemptTiming({ ...session, timestamps }).metrics).toEqual([]);
    expect(biomechanics.result).toBeUndefined();
    expect(biomechanics.calibration).toBeUndefined();
    expect(session.timestamps).toEqual(previous);
    expect(pose.result?.frames).toHaveLength(2);
    // Repeated standalone requests must still see the unresolved full ledger.
    expect(assess(identity.pool).requiresAthleteSelection).toBe(true);
  });

  it("preserves deliberate reviewed Finish/manual input and manual wall points without retaining computed pose", () => {
    const session = createPracticeSession("a");
    const finish = session.timestamps.find(marker => marker.id === "finishPad")!;
    finish.source = "Finish light detection"; finish.acceptanceMode = "frame-review";
    const cleared = clearAutomaticLaneDependentMarkers(session.timestamps);
    expect(cleared.find(marker => marker.id === "finishPad")).toEqual(finish);
    expect(cleared.find(marker => marker.id === "hold10")).toEqual(session.timestamps.find(marker => marker.id === "hold10"));
    const pose = oldAutomaticPose(); pose.calibration!.source = "manual";
    const next = clearAutomaticLaneBiomechanics(pose);
    expect(next.calibration).toEqual(pose.calibration);
    expect(next.result).toBeUndefined();
  });

  it("does not preserve a known legacy automatic Hold10 through a review-mode flag", () => {
    const session = createPracticeSession("a"), hold = session.timestamps.find(marker => marker.id === "hold10")!;
    hold.source = "COM halfway estimate"; hold.acceptanceMode = "frame-review";
    expect(clearAutomaticLaneDependentMarkers(session.timestamps).find(marker => marker.id === "hold10")?.rawTime).toBeNull();
  });
});

/** Authored state fixture for invalidation policy; no detector/model truth. */
function oldAutomaticPose(): BiomechanicsSession {
  const base = createDefaultBiomechanicsSession();
  return { ...base, calibration: { version: 1, source: "automatic-approximate", frameRawTime: 1, widthMeters: 3, heightMeters: 15,
    staticCameraConfirmed: true, corners: [
      { id: "bottomLeft", label: "Bottom left", image: { x: 0, y: 1 }, wall: { xMeters: 0, yMeters: 0 } },
      { id: "bottomRight", label: "Bottom right", image: { x: 1, y: 1 }, wall: { xMeters: 3, yMeters: 0 } },
      { id: "topRight", label: "Top right", image: { x: 1, y: 0 }, wall: { xMeters: 3, yMeters: 15 } },
      { id: "topLeft", label: "Top left", image: { x: 0, y: 0 }, wall: { xMeters: 0, yMeters: 15 } },
    ] }, result: { version: 1, createdAt: "2026-10-23T00:00:00Z", method: "MediaPipe Pose Landmarker", model: "Pose Landmarker Full",
      modelVersion: "float16/1", coordinateSystem: "calibrated-wall-plane", startRawTime: 1, endRawTime: 6.6, settings: base.settings,
      frames: [1, 6.6].map(rawTime => ({ rawTime, climbTime: rawTime - 1, poseDetected: true, poseSelected: true, landmarks: [],
        imageCom: { x: .25, y: .8 }, smoothedWallCom: { xMeters: 1, yMeters: rawTime }, massCoverage: 1, meanVisibility: 1, valid: true })),
      metrics: { requestedFrames: 2, detectedFrames: 2, validFrames: 2, trackingCoverage: 1, validCoverage: 1, meanMassCoverage: 1, quality: "High" },
      warnings: ["Authored state fixture, not model inference"] } };
}
