import { describe, expect, it } from "vitest";
import type { BiomechanicsResult, NormalizedZone } from "../types";
import {
  isBiomechanicsResultFresh,
  selectBiomechanicsResultCoveringRange,
  selectFreshBiomechanicsResult,
} from "./biomechanicsFreshness";

const identityZone: NormalizedZone = {
  id: "startBody",
  label: "Automatic lane",
  x1: 0.1,
  y1: 0.7,
  x2: 0.4,
  y2: 0.95,
};

describe("biomechanics result freshness", () => {
  it("selects a result only while start, finish, and athlete identity match", () => {
    const result = makeResult();
    const basis = { startRawTime: 9.4, endRawTime: 21.82, identityZone: { ...identityZone } };

    expect(isBiomechanicsResultFresh(result, basis)).toBe(true);
    expect(selectFreshBiomechanicsResult(result, basis)).toBe(result);
  });

  it("rejects results after either accepted timing boundary changes", () => {
    const result = makeResult();

    expect(selectFreshBiomechanicsResult(result, {
      startRawTime: 9.42,
      endRawTime: 21.82,
      identityZone,
    })).toBeUndefined();
    expect(selectFreshBiomechanicsResult(result, {
      startRawTime: 9.4,
      endRawTime: 21.9,
      identityZone,
    })).toBeUndefined();
    expect(selectFreshBiomechanicsResult(result, {
      startRawTime: null,
      endRawTime: 21.82,
      identityZone,
    })).toBeUndefined();
  });

  it("rejects a result when the selected athlete zone changes", () => {
    const result = makeResult();
    expect(selectFreshBiomechanicsResult(result, {
      startRawTime: 9.4,
      endRawTime: 21.82,
      identityZone: { ...identityZone, x1: identityZone.x1 + 0.01 },
    })).toBeUndefined();
  });

  it("allows sub-millisecond timestamp rounding but not a larger mismatch", () => {
    const result = makeResult();
    expect(isBiomechanicsResultFresh(result, {
      startRawTime: 9.4009,
      endRawTime: 21.8191,
      identityZone,
    })).toBe(true);
    expect(isBiomechanicsResultFresh(result, {
      startRawTime: 9.4011,
      endRawTime: 21.82,
      identityZone,
    })).toBe(false);
  });

  it("reuses only a compatible longer analysis when the finish is corrected earlier", () => {
    const result = makeResult();
    expect(selectBiomechanicsResultCoveringRange(result, {
      startRawTime: 9.4,
      endRawTime: 20.5,
      identityZone,
    })).toBe(result);
    expect(selectBiomechanicsResultCoveringRange(result, {
      startRawTime: 9.4,
      endRawTime: 22,
      identityZone,
    })).toBeUndefined();
    expect(selectBiomechanicsResultCoveringRange(result, {
      startRawTime: 9.3,
      endRawTime: 20.5,
      identityZone,
    })).toBeUndefined();
  });
});

function makeResult(): BiomechanicsResult {
  return {
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime: 9.4,
    endRawTime: 21.82,
    identityZone,
    settings: {
      sampleFps: 10,
      minVisibility: 0.25,
      minMassCoverage: 0.75,
      smoothingWindowSeconds: 0.2,
      anthropometricModel: "athletevision-published-male-reference",
    },
    frames: [],
    metrics: {
      requestedFrames: 0,
      detectedFrames: 0,
      validFrames: 0,
      trackingCoverage: 0,
      validCoverage: 0,
      meanMassCoverage: 0,
      quality: "Needs review",
    },
    warnings: [],
  };
}
