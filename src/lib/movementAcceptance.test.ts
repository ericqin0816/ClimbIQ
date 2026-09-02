import { describe, expect, it } from "vitest";
import type { FirstMovementDetectionResult } from "../types";
import { canAutomaticallyAcceptMovement } from "./movementAcceptance";

describe("automatic movement acceptance", () => {
  it("accepts reliable in-range corrected movement", () => {
    expect(canAutomaticallyAcceptMovement(movement(), 7.23, 7.13, 32)).toBe(true);
  });

  it("rejects an offset that moves the final marker before Start", () => {
    expect(canAutomaticallyAcceptMovement(movement(), 7.12, 7.13, 32)).toBe(false);
  });

  it("requires review when correction moves a valid-race reaction below 0.100 seconds", () => {
    expect(canAutomaticallyAcceptMovement(movement(), 7.229, 7.13, 32)).toBe(false);
  });

  it("rejects an offset that moves the final marker beyond the video", () => {
    expect(canAutomaticallyAcceptMovement(movement(), 32.1, 7.13, 32)).toBe(false);
  });

  it("rejects a corrected movement at or after the finish boundary", () => {
    expect(canAutomaticallyAcceptMovement(movement(), 17.48, 7.13, 32, 17.48)).toBe(false);
  });

  it("rejects weak, suspicious, or already-underway detections", () => {
    expect(canAutomaticallyAcceptMovement(movement({ confidence: "Low" }), 7.23, 7.13, 32)).toBe(false);
    expect(canAutomaticallyAcceptMovement(movement({ suspiciousFirstFrameDetection: true }), 7.23, 7.13, 32)).toBe(false);
    expect(canAutomaticallyAcceptMovement(movement({ movementAlreadyUnderway: true }), 7.23, 7.13, 32)).toBe(false);
  });
});

function movement(overrides: Partial<FirstMovementDetectionResult["debug"]> & {
  confidence?: FirstMovementDetectionResult["confidence"];
} = {}): FirstMovementDetectionResult {
  return {
    detected: true,
    rawTime: 7.23,
    climbTime: 0.1,
    confidence: overrides.confidence ?? "Medium",
    reason: "test",
    threshold: 1,
    candidates: [],
    debug: {
      zoneExists: true,
      framesSampled: 10,
      maxMotion: 2,
      threshold: 1,
      detectedSpikes: [],
      samples: [],
      movementAlreadyUnderway: overrides.movementAlreadyUnderway ?? false,
      suspiciousFirstFrameDetection: overrides.suspiciousFirstFrameDetection ?? false,
    },
  };
}
