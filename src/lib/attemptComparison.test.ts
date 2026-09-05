import { describe, expect, it } from "vitest";
import type { Confidence, SavedAnalysisSession, TimestampMarker } from "../types";
import { compareAttempts, hasComparableTiming, summarizeAttempt } from "./attemptComparison";
import { compactBiomechanicsSession, sanitizeBiomechanicsSession } from "./biomechanicsSession";
import { sanitizeTimestampSequence } from "./timestampIntegrity";

describe("attempt comparison", () => {
  it("compares accepted total, reaction, and Hold 10 phases", () => {
    const baseline = makeSession("baseline", { start: 2, movement: 2.2, hold10: 6.5, finish: 12 });
    const candidate = makeSession("candidate", { start: 3, movement: 3.18, hold10: 7.2, finish: 12.7 });

    const comparison = compareAttempts(baseline, candidate);

    expect(comparison.comparableMetricCount).toBe(4);
    expect(row(comparison, "total")).toMatchObject({ deltaSeconds: -0.3, outcome: "gained" });
    expect(row(comparison, "reaction")).toMatchObject({ deltaSeconds: -0.02, outcome: "similar" });
    expect(row(comparison, "bottom-phase")).toMatchObject({ deltaSeconds: -0.3, outcome: "gained" });
    expect(row(comparison, "top-phase")).toMatchObject({ deltaSeconds: 0, outcome: "similar" });
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

  it.each([0.006, 0.05, 0.1])("withholds tiny timing gain claims for a %ss difference", (delta) => {
    const result = compareAttempts(makeSession("a", { start: 2, finish: 5 }), makeSession("b", { start: 2, finish: 5 - delta }));
    expect(row(result, "total")).toMatchObject({ outcome: "similar", comparisonFloorSeconds: 0.1 });
    expect(result.primaryInsight).toContain("no overall gain or loss");
  });

  it("uses a larger comparison floor for body motion estimates", () => {
    const a = makeSession("a", { start: 2, movement: 2.3 });
    const b = makeSession("b", { start: 2, movement: 2.15 });
    b.timestamps[1].source = "Body motion detection";
    expect(row(compareAttempts(a, b), "reaction")).toMatchObject({ outcome: "similar", comparisonFloorSeconds: 0.2 });
  });

  it.each(["start", "finish", "athlete", "calibration"])("withholds tracking and its quality after changing %s", (change) => {
    const session = withRouteTracking(makeSession("changed", { start: 2, finish: 5 }), 2, 5);
    if (change === "start") session.timestamps[0].rawTime = 2.05;
    if (change === "finish") session.timestamps[5].rawTime = 4.95;
    if (change === "athlete") session.zones.startBody = { id: "startBody", label: "Other athlete", x1: 0.6, y1: 0.4, x2: 0.9, y2: 0.9 };
    if (change === "calibration") session.biomechanics!.calibration!.staticCameraConfirmed = false;
    const summary = summarizeAttempt(session);
    expect(summary.metrics.some((m) => m.evidence === "COM wall estimate")).toBe(false);
    expect(summary.trackingQuality).toBeUndefined();
    expect(summary.trackingCoverage).toBeUndefined();
    expect(summary.trackingNote).toContain("Run COM analysis again");
  });

  it("shares accepted boundaries for section totals even within rounding tolerance", () => {
    const session = withRouteTracking(makeSession("rounding", { start: 2.0005, finish: 4.9995 }), 2, 5);
    const metrics = summarizeAttempt(session).metrics;
    const total = metrics.find((m) => m.id === "total")!.valueSeconds;
    const sections = metrics.filter((m) => m.evidence === "COM wall estimate");
    expect(sections).toHaveLength(3);
    expect(Math.abs(sections.reduce((sum, m) => sum + m.valueSeconds, 0) - total)).toBeLessThanOrEqual(0.002);
  });

  it("leads with the overall slowdown even if reaction is unchanged", () => {
    const a = makeSession("a", { start: 2, movement: 2.2, finish: 5 });
    const b = makeSession("b", { start: 2, movement: 2.2, finish: 6 });
    expect(compareAttempts(a, b).primaryInsight).toBe("b was 1.000s slower overall.");
  });

  it("shows a faster bottom and slower top alongside the overall loss", () => {
    const a = makeSession("a", { start: 2, hold10: 6, finish: 12 });
    const b = makeSession("b", { start: 2, hold10: 5.5, finish: 13 });
    const result = compareAttempts(a, b);
    expect(result.primaryInsight).toContain("1.000s slower overall");
    expect(result.primaryInsight).toContain("lost 1.500s in hold 10 → finish");
    expect(row(result, "bottom-phase")?.outcome).toBe("gained");
  });

  it("does not treat old automatic Hold 10 proposals as reviewed contact", () => {
    const session = makeSession("legacy", { start: 2, hold10: 6, finish: 12 });
    session.timestamps[4].source = "COM halfway estimate";
    expect(summarizeAttempt(session).metrics.map((m) => m.id)).toEqual(["total"]);
  });

  it("gates COM comparisons on timing confidence as well as tracking confidence", () => {
    const a = withRouteTracking(makeSession("a", { start: 2, finish: 5 }), 2, 5);
    const b = structuredClone(a);
    b.timestamps[5].confidence = "Low";
    expect(row(compareAttempts(a, b), "lower-third")?.outcome).toBe("review");
  });

  it("uses pose sample spacing for the COM comparison floor", () => {
    const a = withRouteTracking(makeSession("a", { start: 2, finish: 5 }), 2, 5);
    const result = compareAttempts(a, structuredClone(a));
    expect(row(result, "lower-third")).toMatchObject({ outcome: "similar", comparisonFloorSeconds: 0.4 });
  });

  it("survives compact save, JSON reload, comparison, and a Finish correction", () => {
    const session = withRouteTracking(makeSession("roundtrip", { start: 2, hold10: 3.5, finish: 5 }), 2, 5);
    const saved = JSON.parse(JSON.stringify({ ...session, biomechanics: compactBiomechanicsSession(session.biomechanics!) }));
    saved.biomechanics = sanitizeBiomechanicsSession(saved.biomechanics);
    saved.timestamps = sanitizeTimestampSequence(saved.timestamps);
    const before = compareAttempts(session, saved);
    expect(row(before, "total")?.deltaSeconds).toBe(0);
    expect(row(before, "bottom-phase")?.deltaSeconds).toBe(0);
    expect(summarizeAttempt(saved).metrics.filter((m) => m.evidence === "COM wall estimate")).toHaveLength(3);
    saved.timestamps.find((m: TimestampMarker) => m.id === "finishPad").rawTime = 4.95;
    const after = compareAttempts(session, saved);
    expect(row(after, "total")?.deltaSeconds).toBe(-0.05);
    expect(row(after, "lower-third")?.outcome).toBe("unavailable");
  });

  it.each([2, 120, 3600])("preserves durations after adding %ss of lead-in", (offset) => {
    const session = withRouteTracking(makeSession("original", { start: 2, movement: 2.2, hold10: 3.5, finish: 5 }), 2, 5);
    const shifted = structuredClone(session);
    shifted.timestamps.forEach(m => { if (m.rawTime !== null) m.rawTime += offset; });
    shifted.biomechanics!.result!.startRawTime += offset;
    shifted.biomechanics!.result!.endRawTime += offset;
    shifted.biomechanics!.result!.frames.forEach(f => { f.rawTime += offset; });
    const result = compareAttempts(session, shifted);
    expect(result.rows.filter(r => r.deltaSeconds !== undefined)).toHaveLength(7);
    expect(result.rows.every(r => r.deltaSeconds === 0)).toBe(true);
  });

  it("reverses gain/loss when attempts are swapped without changing thresholds", () => {
    const a = makeSession("a", { start: 2, hold10: 6, finish: 12 });
    const b = makeSession("b", { start: 3, hold10: 6.5, finish: 12 });
    const forward = compareAttempts(a, b);
    const backward = compareAttempts(b, a);
    for (const f of forward.rows.filter(r => r.deltaSeconds !== undefined)) {
      const b = row(backward, f.id)!;
      expect(b.deltaSeconds).toBe(-f.deltaSeconds!);
      expect(b.comparisonFloorSeconds).toBe(f.comparisonFloorSeconds);
      expect(b.outcome).toBe(f.outcome === "gained" ? "lost" : "gained");
    }
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
      imageCom: { x: 0.5, y: 1 - yMeters / 15 },
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
