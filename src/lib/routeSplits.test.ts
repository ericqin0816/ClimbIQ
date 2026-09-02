import { describe, expect, it } from "vitest";
import type { BiomechanicsFrame, BiomechanicsResult } from "../types";
import {
  analyzeRouteSplits,
  buildMonotonicRouteProgress,
} from "./routeSplits";

describe("COM-derived route splits", () => {
  it("returns equal thirds and an exact halfway crossing for constant pace", () => {
    const result = makeResult(
      Array.from({ length: 101 }, (_, index) => {
        const climbTime = index / 10;
        return sample(10 + climbTime, 1.5 * climbTime);
      }),
      10,
      20,
    );

    const analysis = analyzeRouteSplits(result);

    expect(analysis.oneThird.rawTime).toBeCloseTo(13.333, 3);
    expect(analysis.halfway.rawTime).toBeCloseTo(15, 6);
    expect(analysis.twoThirds.rawTime).toBeCloseTo(16.667, 3);
    expect(analysis.sections.map((section) => section.sectionTimeSeconds)).toEqual([
      expect.closeTo(10 / 3, 6),
      expect.closeTo(10 / 3, 6),
      expect.closeTo(10 / 3, 6),
    ]);
    analysis.sections.forEach((section) => {
      expect(section.averageVerticalPaceMps).toBeCloseTo(1.5, 6);
      expect(section.trackingCoverage).toBeCloseTo(1, 6);
    });
    expect(analysis.evenPacing).toBe(true);
    expect(analysis.slowestSectionId).toBeUndefined();

  });

  it("identifies a meaningfully slower top third", () => {
    const frames = Array.from({ length: 101 }, (_, index) => {
      const time = index / 10;
      const height = time <= 2
        ? time * 2.5
        : time <= 4
          ? 5 + (time - 2) * 2.5
          : 10 + (time - 4) * (5 / 6);
      return sample(time, height);
    });
    const analysis = analyzeRouteSplits(makeResult(frames, 0, 10));

    expect(analysis.sections[0].sectionTimeSeconds).toBeCloseTo(2, 6);
    expect(analysis.sections[1].sectionTimeSeconds).toBeCloseTo(2, 6);
    expect(analysis.sections[2].sectionTimeSeconds).toBeCloseTo(6, 6);
    expect(analysis.sections[2].averageVerticalPaceMps).toBeCloseTo(5 / 6, 6);
    expect(analysis.slowestSectionId).toBe("top");
    expect(analysis.evenPacing).toBe(false);
  });

  it("uses an upward-only envelope so backtracking cannot reverse or duplicate a crossing", () => {
    const frames = [
      sample(0, 0),
      sample(0.2, 4),
      sample(0.4, 3),
      sample(0.6, 5.5),
      sample(0.8, 7.5),
      sample(1, 10),
      sample(1.2, 15),
    ];
    const progress = buildMonotonicRouteProgress(frames);
    const analysis = analyzeRouteSplits(makeResult(frames, 0, 1.2));

    expect(progress.map((point) => point.progressMeters)).toEqual([0, 4, 4, 5.5, 7.5, 10, 15]);
    expect(analysis.oneThird.rawTime).toBeCloseTo(0.533333, 6);
    expect(analysis.halfway.rawTime).toBeCloseTo(0.8, 6);
    expect(analysis.twoThirds.rawTime).toBeCloseTo(1, 6);
    expect(analysis.sections.every((section) => (section.sectionTimeSeconds ?? 0) > 0)).toBe(true);
  });

  it("does not invent boundary times or vertical pace across gaps longer than 0.25 seconds", () => {
    const frames = [
      sample(0, 0),
      sample(0.1, 4),
      sample(0.5, 6),
      sample(0.6, 7.4),
      sample(1, 8),
      sample(1.1, 10.2),
      sample(1.2, 11),
    ];
    const analysis = analyzeRouteSplits(makeResult(frames, 0, 2));

    expect(analysis.gapCount).toBe(2);
    expect(analysis.oneThird.available).toBe(false);
    expect(analysis.oneThird.reason).toContain("untracked gap");
    expect(analysis.halfway.available).toBe(false);
    expect(analysis.halfway.reason).toContain("untracked gap");
    expect(analysis.sections[0].available).toBe(false);
    expect(analysis.sections[1].available).toBe(false);
    expect(analysis.sections[2].available).toBe(true);
    expect(analysis.sections[2].averageVerticalPaceMps).toBeUndefined();
  });

  it("ignores invalid and extrapolated samples when building progress", () => {
    const invalid = { ...sample(0.1, 8), valid: false };
    const extrapolated = { ...sample(0.2, 12), extrapolated: true };
    const frames = [sample(0, 1), invalid, extrapolated, sample(0.3, 2)];

    expect(buildMonotonicRouteProgress(frames)).toEqual([
      { rawTime: 0, progressMeters: 1, chunkId: 0 },
      { rawTime: 0.3, progressMeters: 2, chunkId: 1 },
    ]);
  });

  it("caps wall crossings and sections at the wall-calibration confidence", () => {
    const result = makeResult(
      Array.from({ length: 101 }, (_, index) => sample(index / 10, index * 0.15)),
      0,
      10,
    );
    const analysis = analyzeRouteSplits(result, 15, "Low");
    expect(analysis.confidence).toBe("Low");
    expect(analysis.halfway.confidence).toBe("Low");
    expect(analysis.sections.every((section) => section.confidence === "Low")).toBe(true);
    expect(analysis.slowestSectionId).toBeUndefined();
    expect(analysis.evenPacing).toBe(false);
  });
});

function sample(rawTime: number, heightMeters: number): BiomechanicsFrame {
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    poseSelected: true,
    poseCandidateCount: 1,
    landmarks: [],
    wallCom: { xMeters: 1.5, yMeters: heightMeters },
    smoothedWallCom: { xMeters: 1.5, yMeters: heightMeters },
    massCoverage: 0.95,
    meanVisibility: 0.95,
    valid: true,
  };
}

function makeResult(frames: BiomechanicsFrame[], startRawTime: number, endRawTime: number): BiomechanicsResult {
  return {
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime,
    endRawTime,
    settings: {
      sampleFps: 10,
      minVisibility: 0.35,
      minMassCoverage: 0.8,
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
      meanMassCoverage: 0.95,
      quality: "High",
    },
    warnings: [],
  };
}
