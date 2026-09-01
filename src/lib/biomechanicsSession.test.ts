import { describe, expect, it } from "vitest";
import type { BiomechanicsFrame, BiomechanicsResult, PoseLandmarkPoint } from "../types";
import { getHold10ContactMarker } from "./holdContact";
import { compactBiomechanicsSession, sanitizeBiomechanicsSession } from "./biomechanicsSession";
import { buildWallCalibration } from "./wallCalibration";

describe("compact biomechanics session", () => {
  it("preserves wrist evidence and the same Hold 10 contact time across save/load", () => {
    const calibration = buildWallCalibration([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ], 0, true);
    const target = { xMeters: 1.4, yMeters: 8.3 };
    const wrist = {
      x: target.xMeters / 3,
      y: 1 - target.yMeters / 15,
    };
    const result = makeResult([1, 1.1, 1.2].map((rawTime) => makeFrame(rawTime, wrist)));
    const before = getHold10ContactMarker(result, calibration, target);

    const compact = compactBiomechanicsSession({
      version: 1,
      calibration,
      settings: result.settings,
      result,
    });
    expect(compact.result?.frames.flatMap((frame) => frame.landmarks).map((point) => point.index))
      .toEqual([
        15, 16, 17, 18, 19, 20, 21, 22,
        15, 16, 17, 18, 19, 20, 21, 22,
        15, 16, 17, 18, 19, 20, 21, 22,
      ]);

    const restored = sanitizeBiomechanicsSession(JSON.parse(JSON.stringify(compact)));
    const after = getHold10ContactMarker(restored.result!, restored.calibration, target);

    expect(before?.rawTime).toBe(1);
    expect(after?.rawTime).toBe(before?.rawTime);
    expect(after?.source).toBe("Hold contact detection");
  });
});

function makeFrame(rawTime: number, wrist: { x: number; y: number }): BiomechanicsFrame {
  const landmarks: PoseLandmarkPoint[] = [
    { index: 11, x: 0.5, y: 0.5, z: 0, visibility: 1 },
    { index: 15, x: wrist.x, y: wrist.y, z: 0, visibility: 1 },
    { index: 16, x: wrist.x + 0.2, y: wrist.y, z: 0, visibility: 1 },
    ...Array.from({ length: 6 }, (_, offset): PoseLandmarkPoint => {
      const index = 17 + offset;
      const leftHand = index % 2 === 1;
      return {
        index,
        x: wrist.x + (leftHand ? 0 : 0.2),
        y: wrist.y,
        z: 0,
        visibility: 1,
      };
    }),
  ];
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    poseSelected: true,
    poseCandidateCount: 1,
    landmarks,
    imageCom: { x: 0.5, y: 0.5 },
    wallCom: { xMeters: 1.5, yMeters: 7.5 },
    massCoverage: 0.95,
    meanVisibility: 0.95,
    valid: true,
  };
}

function makeResult(frames: BiomechanicsFrame[]): BiomechanicsResult {
  return {
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime: 0,
    endRawTime: 2,
    settings: {
      sampleFps: 10,
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
      meanMassCoverage: 0.95,
      quality: "High",
    },
    warnings: [],
  };
}
