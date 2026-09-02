import { describe, expect, it } from "vitest";
import type { FirstMovementDetectionResult } from "../types";
import { assessAutomaticStartBodyAudit } from "./startBodyAudit";

describe("automatic start body audit", () => {
  it("allows light/audio timing when lane-local movement follows immediately", () => {
    const result = assessAutomaticStartBodyAudit(movement({ rawTime: 4.4, confidence: "High" }), 4.29);
    expect(result.safeToAutoAccept).toBe(true);
  });

  it("requires review when the measured reaction is below the valid-race floor", () => {
    const result = assessAutomaticStartBodyAudit(movement({ rawTime: 8.85, confidence: "High" }), 8.817);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("below 0.100s");
  });

  it("blocks a late event when motion is already underway", () => {
    const result = assessAutomaticStartBodyAudit(movement({
      rawTime: 14.9,
      confidence: "Medium",
      movementAlreadyUnderway: true,
      suspiciousFirstFrameDetection: true,
    }), 14.9);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("already underway");
  });

  it("requires review when no athlete launch is found in the selected start lane", () => {
    const result = assessAutomaticStartBodyAudit(movement({ detected: false, rawTime: undefined, confidence: "None" }), 5.25);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("did not show a reliable launch");
  });

  it("rejects motion that starts well before the proposed signal", () => {
    const result = assessAutomaticStartBodyAudit(movement({ rawTime: 7, confidence: "High" }), 9);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("before the proposed start");
  });

  it("rejects a cue when threshold-level motion is visible just before it", () => {
    const candidate = movement({ rawTime: 8.85, confidence: "High" });
    candidate.debug.threshold = 1;
    candidate.debug.samples = [
      { time: 8.7, motionScore: 1.4, smoothedMotionScore: 1.4 },
      { time: 8.85, motionScore: 1.6, smoothedMotionScore: 1.6 },
    ];
    const result = assessAutomaticStartBodyAudit(candidate, 8.817);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("before the proposed start");
  });

  it("rejects a delayed movement that is unlikely to belong to the proposed cue", () => {
    const result = assessAutomaticStartBodyAudit(movement({ rawTime: 5.1, confidence: "High" }), 4.29);
    expect(result.safeToAutoAccept).toBe(false);
    expect(result.reason).toContain("too long after");
  });
});

function movement({
  detected = true,
  rawTime = 4.39,
  confidence = "High",
  movementAlreadyUnderway = false,
  suspiciousFirstFrameDetection = false,
}: {
  detected?: boolean;
  rawTime?: number;
  confidence?: FirstMovementDetectionResult["confidence"];
  movementAlreadyUnderway?: boolean;
  suspiciousFirstFrameDetection?: boolean;
}): FirstMovementDetectionResult {
  return {
    detected,
    rawTime,
    climbTime: rawTime === undefined ? undefined : rawTime - 4.29,
    confidence,
    reason: "test movement",
    threshold: 1,
    candidates: [],
    debug: {
      zoneExists: true,
      framesSampled: 20,
      maxMotion: 2,
      threshold: 1,
      detectedSpikes: [],
      samples: [],
      movementAlreadyUnderway,
      suspiciousFirstFrameDetection,
    },
  };
}
