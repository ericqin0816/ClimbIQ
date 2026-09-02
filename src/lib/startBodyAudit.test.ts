import { describe, expect, it } from "vitest";
import type { FirstMovementDetectionResult } from "../types";
import { assessAutomaticStartBodyAudit } from "./startBodyAudit";

describe("automatic start body audit", () => {
  it("allows light/audio timing when lane-local movement follows immediately", () => {
    const result = assessAutomaticStartBodyAudit(movement({ rawTime: 4.39, confidence: "High" }), 4.29);
    expect(result.safeToAutoAccept).toBe(true);
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
