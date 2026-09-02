import { describe, expect, it } from "vitest";
import type { Confidence, SavedAnalysisSession, TimestampMarker } from "../types";
import { compareAttempts, hasComparableTiming, summarizeAttempt } from "./attemptComparison";

describe("attempt comparison", () => {
  it("compares accepted total, reaction, and Hold 10 phases", () => {
    const baseline = makeSession("baseline", { start: 2, movement: 2.2, hold10: 6.5, finish: 12 });
    const candidate = makeSession("candidate", { start: 3, movement: 3.18, hold10: 7.2, finish: 12.7 });

    const comparison = compareAttempts(baseline, candidate);

    expect(comparison.comparableMetricCount).toBe(4);
    expect(row(comparison, "total")).toMatchObject({ deltaSeconds: -0.3, outcome: "gained" });
    expect(row(comparison, "reaction")).toMatchObject({ deltaSeconds: -0.02, outcome: "gained" });
    expect(row(comparison, "bottom-phase")).toMatchObject({ deltaSeconds: -0.3, outcome: "gained" });
    expect(row(comparison, "top-phase")).toMatchObject({ deltaSeconds: 0, outcome: "matched" });
    expect(comparison.primaryInsight).toContain("gained 0.300s in start → hold 10");
  });

  it("withholds a delta when either saved value is low confidence", () => {
    const baseline = makeSession("baseline", { start: 1, finish: 11 });
    const candidate = makeSession("candidate", { start: 1, finish: 10.8 }, "Low");

    const total = row(compareAttempts(baseline, candidate), "total");
    expect(total).toMatchObject({ outcome: "review" });
    expect(total?.deltaSeconds).toBeUndefined();
  });

  it("does not calculate phases from invalid timestamp chronology", () => {
    const summary = summarizeAttempt(makeSession("invalid", {
      start: 5,
      movement: 4.9,
      hold10: 13,
      finish: 12,
    }));

    expect(summary.metrics.map((item) => item.id)).toEqual(["total"]);
  });

  it("recognizes sessions with any accepted comparable timing", () => {
    expect(hasComparableTiming(makeSession("timed", { start: 1, movement: 1.2 }))).toBe(true);
    expect(hasComparableTiming(makeSession("empty", {}))).toBe(false);
  });

  it("describes an overall-only comparison without calling it a detailed split", () => {
    const baseline = makeSession("baseline", { start: 1, finish: 11 });
    const candidate = makeSession("candidate", { start: 2, finish: 11.8 });

    expect(compareAttempts(baseline, candidate).primaryInsight).toBe("candidate was 0.200s faster overall.");
  });

  it("derives trustworthy wall-third splits from matching saved COM ranges", () => {
    const session = withRouteTracking(makeSession("tracked", { start: 2, finish: 5 }), 2, 5);

    expect(summarizeAttempt(session).metrics.filter((item) => item.evidence === "COM wall estimate"))
      .toMatchObject([
        { id: "lower-third", valueSeconds: 1, confidence: "High" },
        { id: "middle-third", valueSeconds: 1, confidence: "High" },
        { id: "top-third", valueSeconds: 1, confidence: "High" },
      ]);
  });

  it("does not compare stale COM results from an older accepted timing range", () => {
    const session = withRouteTracking(makeSession("stale", { start: 3, finish: 6 }), 2, 5);

    expect(summarizeAttempt(session).metrics.some((item) => item.evidence === "COM wall estimate")).toBe(false);
  });
});

function row(comparison: ReturnType<typeof compareAttempts>, id: string) {
  return comparison.rows.find((item) => item.id === id);
}

function makeSession(
  name: string,
  times: { start?: number; movement?: number; hold10?: number; finish?: number },
  confidence: Confidence = "High",
): SavedAnalysisSession {
  const timestamps: TimestampMarker[] = [
    marker("startSignal", "Start Signal", times.start, confidence),
    marker("firstMovement", "First Movement", times.movement, confidence),
    marker("committedLaunch", "Committed Launch", undefined, "None"),
    marker("firstHold", "First Hold", undefined, "None"),
    marker("hold10", "Hold 10", times.hold10, confidence),
    marker("finishPad", "Finish Pad", times.finish, confidence),
  ];
  return {
    id: name,
    version: 1,
    name,
    climberName: "Test climber",
    date: "2026-09-02",
    location: "Test gym",
    attemptType: "Training",
    notes: "",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    videoMetadata: null,
    zones: {},
    startLightCalibration: {},
    settings: {
      startSearchStart: 0,
      startSearchEnd: 12,
      startSensitivity: "medium",
      startLightVisibility: "clear",
      startDetectionProfile: "auto",
      reactionTimeOffset: 0,
      startSignalOffset: 0,
      movementSensitivity: "medium",
      firstMovementDefinition: "earliest",
      committedLaunchMinDelay: 0.08,
      firstMovementOffset: 0,
      officialTotalTime: "",
    },
    timestamps,
  };
}

function marker(
  id: TimestampMarker["id"],
  label: string,
  rawTime: number | undefined,
  confidence: Confidence,
): TimestampMarker {
  return {
    id,
    label,
    rawTime: rawTime ?? null,
    climbTime: null,
    source: rawTime === undefined ? "Not set" : "Manual",
    confidence,
  };
}

function withRouteTracking(session: SavedAnalysisSession, startRawTime: number, endRawTime: number): SavedAnalysisSession {
  const frames = Array.from({ length: 16 }, (_, index) => {
    const rawTime = startRawTime + index * 0.2;
    const yMeters = index;
    return {
      rawTime,
      climbTime: rawTime - startRawTime,
      poseDetected: true,
      poseSelected: true,
      poseCandidateCount: 1,
      landmarks: [],
      wallCom: { xMeters: 1.5, yMeters },
      smoothedWallCom: { xMeters: 1.5, yMeters },
      massCoverage: 1,
      meanVisibility: 1,
      valid: true,
    };
  });
  return {
    ...session,
    biomechanics: {
      version: 1,
      settings: {
        sampleFps: 5,
        minVisibility: 0.25,
        minMassCoverage: 0.75,
        smoothingWindowSeconds: 0.2,
        anthropometricModel: "athletevision-published-male-reference",
      },
      calibration: {
        version: 1,
        frameRawTime: startRawTime,
        widthMeters: 3,
        heightMeters: 15,
        staticCameraConfirmed: true,
        source: "manual",
        confidence: "High",
        corners: [
          { id: "bottomLeft", label: "Bottom left", image: { x: 0, y: 1 }, wall: { xMeters: 0, yMeters: 0 } },
          { id: "bottomRight", label: "Bottom right", image: { x: 1, y: 1 }, wall: { xMeters: 3, yMeters: 0 } },
          { id: "topRight", label: "Top right", image: { x: 1, y: 0 }, wall: { xMeters: 3, yMeters: 15 } },
          { id: "topLeft", label: "Top left", image: { x: 0, y: 0 }, wall: { xMeters: 0, yMeters: 15 } },
        ],
      },
      result: {
        version: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        method: "MediaPipe Pose Landmarker",
        model: "Pose Landmarker Full",
        modelVersion: "float16/1",
        coordinateSystem: "calibrated-wall-plane",
        startRawTime,
        endRawTime,
        settings: {
          sampleFps: 5,
          minVisibility: 0.25,
          minMassCoverage: 0.75,
          smoothingWindowSeconds: 0.2,
          anthropometricModel: "athletevision-published-male-reference",
        },
        frames,
        metrics: {
          requestedFrames: frames.length,
          detectedFrames: frames.length,
          selectedFrames: frames.length,
          validFrames: frames.length,
          detectionCoverage: 1,
          trackingCoverage: 1,
          validCoverage: 1,
          meanMassCoverage: 1,
          quality: "High",
        },
        warnings: [],
      },
    },
  };
}
