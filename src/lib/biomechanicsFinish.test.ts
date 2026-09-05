import { describe, expect, it } from "vitest";
import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  PoseLandmarkPoint,
  WallPoint,
} from "../types";
import {
  deriveBiomechanicsFinishCutoff,
  framesThroughBiomechanicsFinish,
  resolveAutomaticPoseFinishBoundary,
  trimBiomechanicsResultAtFinish,
} from "./biomechanicsFinish";
import { getStandardSpeedHold } from "./standardSpeedRoute";
import { buildWallCalibration } from "./wallCalibration";

const fullFrameCalibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);

describe("biomechanics finish trimming", () => {
  it("never falls back to full-video pose analysis without finish evidence", () => {
    expect(resolveAutomaticPoseFinishBoundary({
      startRawTime: 9.4,
      videoDuration: 40,
    })).toEqual({
      ready: false,
      reason: "No finish boundary was verified, so COM analysis was stopped before scanning the descent.",
    });
  });

  it("does not promote an unaccepted review cursor into a COM end boundary", () => {
    expect(resolveAutomaticPoseFinishBoundary({
      startRawTime: 9.4,
      videoDuration: 40,
      lightFinishRawTime: 21.64,
      lightFinishAccepted: false,
    })).toMatchObject({
      ready: false,
    });
  });

  it("prefers official time over an unaccepted light suggestion, but keeps an accepted light finish", () => {
    expect(resolveAutomaticPoseFinishBoundary({
      startRawTime: 9.4,
      videoDuration: 40,
      lightFinishRawTime: 22,
      officialTotalSeconds: 12.24,
    }).endRawTime).toBeCloseTo(21.64, 8);
    expect(resolveAutomaticPoseFinishBoundary({
      startRawTime: 9.4,
      videoDuration: 40,
      lightFinishRawTime: 21.7,
      lightFinishAccepted: true,
      officialTotalSeconds: 12.24,
    })).toMatchObject({
      endRawTime: 21.7,
      source: "accepted-light",
    });
  });

  it("never clamps an out-of-range official or light finish to the end of the file", () => {
    expect(resolveAutomaticPoseFinishBoundary({
      startRawTime: 9.4,
      videoDuration: 20,
      officialTotalSeconds: 15,
      lightFinishRawTime: 25,
    })).toEqual({
      ready: false,
      reason: "No finish boundary was verified, so COM analysis was stopped before scanning the descent.",
    });
  });

  it("never includes frames after the accepted finish", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 3), sample(2, 5), sample(3, 7), sample(4, 9),
      sample(5, 10), sample(6, 11), sample(7, 12),
    ], 7);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 5.4 });

    expect(cutoff.source).toBe("accepted-finish");
    expect(cutoff.cutoffRawTime).toBe(5.4);
    expect(framesThroughBiomechanicsFinish(result, cutoff).map((frame) => frame.rawTime))
      .toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("trims at the first top plateau before a sustained tracked descent", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 4), sample(2, 7), sample(3, 10),
      sample(4, 12.7), sample(4.1, 12.88), sample(4.2, 12.9),
      sample(4.4, 12.55), sample(4.6, 12.1), sample(4.8, 11.6), sample(5, 11.1),
      sample(5.2, 10.7), sample(5.4, 10.3), sample(5.6, 9.9), sample(5.8, 9.7), sample(6, 9.5),
    ], 6);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 6 });

    expect(cutoff.source).toBe("top-completion");
    expect(cutoff.cutoffRawTime).toBe(4.1);
    expect(cutoff.confidence).toBe("Medium");
    expect(cutoff.evidence.descentDropMeters).toBeGreaterThan(1);
    expect(cutoff.reason).toContain("sustained descent");
    expect(framesThroughBiomechanicsFinish(result, cutoff).at(-1)?.rawTime).toBe(4.1);
  });

  it("does not trim a normal upward backstep followed by a new high point", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 4), sample(2, 7), sample(3, 10.5),
      sample(3.2, 9.5), sample(3.4, 9.2), sample(3.6, 10.2),
      sample(4, 11.4), sample(4.5, 12.7), sample(5, 13),
    ], 5);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 5 });

    expect(cutoff.source).toBe("accepted-finish");
    expect(cutoff.cutoffRawTime).toBe(5);
  });

  it("does not trim a brief top-zone drop that rebounds to the top", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 5), sample(2, 9), sample(3, 12.8),
      sample(3.2, 12.1), sample(3.4, 12.9), sample(3.6, 13.1), sample(4, 13),
    ], 4);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 4 });

    expect(cutoff.source).toBe("accepted-finish");
  });

  it("uses Hold 20 hand proximity to confirm completion when COM is below the strict top zone", () => {
    const hold20 = getStandardSpeedHold(20).wall;
    const result = makeResult([
      sample(0, 1), sample(1, 4), sample(2, 7), sample(3, 10.5),
      sample(4, 11.2), sample(4.1, 11.35, handAt(19, hold20)),
      sample(4.2, 11.3, handAt(19, hold20)), sample(4.4, 10.9),
      sample(4.6, 10.4), sample(4.8, 9.8), sample(5, 9.2),
    ], 5);
    const cutoff = deriveBiomechanicsFinishCutoff(result, {
      acceptedFinishRawTime: 5,
      calibration: fullFrameCalibration,
    });

    expect(cutoff.source).toBe("top-completion");
    expect(cutoff.cutoffRawTime).toBe(4.1);
    expect(cutoff.confidence).toBe("High");
    expect(cutoff.evidence.hold20HandDistanceMeters).toBeCloseTo(0, 8);
    expect(cutoff.reason).toContain("Hold 20");
  });

  it("refuses a top-hand sighting when there was no credible upward climb", () => {
    const hold20 = getStandardSpeedHold(20).wall;
    const result = makeResult([
      sample(0, 12.8, handAt(19, hold20)), sample(0.2, 12.7), sample(0.4, 12.3),
      sample(0.6, 11.8), sample(0.8, 11.1), sample(1, 10.4),
    ], 1);
    const cutoff = deriveBiomechanicsFinishCutoff(result, {
      acceptedFinishRawTime: 1,
      calibration: fullFrameCalibration,
    });

    expect(cutoff.source).toBe("accepted-finish");
    expect(cutoff.evidence.upwardGainMeters).toBe(0);
  });

  it("refuses to join apparent descent across a long tracking gap", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 5), sample(2, 9), sample(3, 12.9),
      sample(3.1, 12.8), sample(4.2, 11), sample(4.3, 10.5), sample(4.4, 10),
    ], 4.4);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 4.4 });

    expect(cutoff.source).toBe("accepted-finish");
    expect(cutoff.evidence.maximumTrackingGapSeconds).toBeGreaterThan(1);
  });

  it("cannot use descent evidence that occurs after the accepted finish", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 5), sample(2, 9), sample(3, 12.9),
      sample(3.2, 12.85), sample(3.4, 12.7), sample(3.6, 12),
      sample(3.8, 11), sample(4, 10),
    ], 4);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: 3.3 });

    expect(cutoff.source).toBe("accepted-finish");
    expect(cutoff.cutoffRawTime).toBe(3.3);
    expect(framesThroughBiomechanicsFinish(result, cutoff).every((frame) => frame.rawTime <= 3.3)).toBe(true);
  });

  it("safely handles unsorted, invalid, and before-range accepted times", () => {
    const result = makeResult([
      sample(3, 9), sample(Number.NaN, 13), sample(1, 5), sample(2, 7), sample(4, 10),
    ], 4);
    const cutoff = deriveBiomechanicsFinishCutoff(result, { acceptedFinishRawTime: -0.5 });

    expect(cutoff.cutoffRawTime).toBe(-0.5);
    expect(framesThroughBiomechanicsFinish(result, cutoff)).toEqual([]);
  });

  it("recomputes metrics from climb-only frames after removing a long descent", () => {
    const upward = Array.from({ length: 21 }, (_, index) =>
      sample(index * 0.2, 1 + index * 0.59),
    );
    const result = makeResult([
      ...upward,
      sample(4.1, 12.9), sample(4.2, 12.88), sample(4.4, 12.4),
      sample(4.6, 11.8), sample(4.8, 11.1), sample(5, 10.4), sample(5.2, 9.8),
    ], 5.2);

    const trimmed = trimBiomechanicsResultAtFinish(result, fullFrameCalibration, {
      acceptedFinishRawTime: 5.2,
    });

    expect(trimmed.cutoff.source).toBe("top-completion");
    expect(trimmed.removedFrames).toBeGreaterThan(4);
    expect(trimmed.result.endRawTime).toBeLessThanOrEqual(4.1);
    expect(trimmed.result.frames.every((frame) => frame.rawTime <= trimmed.result.endRawTime)).toBe(true);
    expect(trimmed.result.metrics.verticalGainMeters).toBeGreaterThan(10);
    expect(trimmed.result.warnings.some((warning) => warning.includes("Post-finish descent excluded"))).toBe(true);
  });

  it("returns the original result without recalculation when no trim is needed", () => {
    const result = makeResult([
      sample(0, 1), sample(1, 4), sample(2, 7), sample(3, 10), sample(4, 12.9),
    ], 4);

    const trimmed = trimBiomechanicsResultAtFinish(result, fullFrameCalibration, {
      acceptedFinishRawTime: 4,
    });

    expect(trimmed.cutoff.source).toBe("accepted-finish");
    expect(trimmed.removedFrames).toBe(0);
    expect(trimmed.result).toBe(result);
  });
});

function sample(rawTime: number, yMeters: number, landmark?: PoseLandmarkPoint): BiomechanicsFrame {
  const wall = { xMeters: 1.5, yMeters };
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    poseSelected: true,
    poseCandidateCount: 1,
    landmarks: landmark ? [landmark] : [],
    wallCom: wall,
    smoothedWallCom: wall,
    massCoverage: 0.9,
    meanVisibility: 0.9,
    valid: true,
  };
}

function handAt(index: number, wall: WallPoint): PoseLandmarkPoint {
  return {
    index,
    x: wall.xMeters / 3,
    y: 1 - wall.yMeters / 15,
    z: 0,
    visibility: 0.95,
  };
}

function makeResult(frames: BiomechanicsFrame[], endRawTime: number): BiomechanicsResult {
  return {
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime: 0,
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
      meanMassCoverage: 0.9,
      quality: "High",
    },
    warnings: [],
  };
}
