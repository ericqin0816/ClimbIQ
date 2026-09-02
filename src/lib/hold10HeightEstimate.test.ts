import { describe, expect, it } from "vitest";
import type { BiomechanicsFrame, BiomechanicsResult, PoseLandmarkPoint } from "../types";
import { buildWallCalibration } from "./wallCalibration";
import { estimateHold10HeightPassage } from "./hold10HeightEstimate";

const calibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);

describe("Hold 10 height review estimate", () => {
  it("interpolates a continuous tracked hand crossing", () => {
    const result = makeResult([
      frame(4.9, 7.7),
      frame(5, 8.1),
      frame(5.1, 8.55),
      frame(5.2, 8.7),
    ]);
    const estimate = estimateHold10HeightPassage(result, calibration);
    expect(estimate.detected).toBe(true);
    expect(estimate.confidence).toBe("Low");
    expect(estimate.rawTime).toBeGreaterThan(5);
    expect(estimate.rawTime).toBeLessThan(5.1);
    expect(estimate.reason).toContain("Review the frame");
  });

  it("does not invent a crossing when tracking begins above Hold 10", () => {
    const estimate = estimateHold10HeightPassage(makeResult([
      frame(5, 8.7),
      frame(5.1, 8.9),
      frame(5.2, 9.1),
    ]), calibration);
    expect(estimate.detected).toBe(false);
  });

  it("does not interpolate across a tracking gap", () => {
    const estimate = estimateHold10HeightPassage(makeResult([
      frame(4, 7.8),
      frame(4.5, 8.7),
      frame(4.6, 8.9),
    ]), calibration);
    expect(estimate.detected).toBe(false);
    expect(estimate.reason).toContain("will not guess across a tracking gap");
  });

  it("supports older saved frames where poseSelected was not recorded", () => {
    const frames = [frame(4.9, 7.7), frame(5, 8.1), frame(5.1, 8.55), frame(5.2, 8.7)]
      .map(({ poseSelected: _poseSelected, ...sample }) => sample as BiomechanicsFrame);
    expect(estimateHold10HeightPassage(makeResult(frames), calibration).detected).toBe(true);
  });

  it("requires a valid wall calibration", () => {
    expect(estimateHold10HeightPassage(makeResult([]), undefined).detected).toBe(false);
  });
});

function frame(rawTime: number, handHeight: number): BiomechanicsFrame {
  const y = 1 - handHeight / 15;
  const landmarks = [16, 18, 20, 22].map((index): PoseLandmarkPoint => ({
    index,
    x: 0.5,
    y,
    z: 0,
    visibility: 0.95,
  }));
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    poseSelected: true,
    poseCandidateCount: 1,
    landmarks,
    massCoverage: 0.9,
    meanVisibility: 0.95,
    valid: true,
  };
}

function makeResult(frames: BiomechanicsFrame[]): BiomechanicsResult {
  return {
    version: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime: 0,
    endRawTime: 10,
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
      trackingCoverage: 1,
      validCoverage: 1,
      meanMassCoverage: 0.9,
      quality: "High",
    },
    warnings: [],
  };
}
