import type { FirstMovementDetectionResult } from "../types";

export function canAutomaticallyAcceptMovement(
  result: FirstMovementDetectionResult,
  finalRawTime: number,
  startRawTime: number,
  videoDuration: number,
  finishRawTime?: number,
): boolean {
  return Boolean(
    result.detected &&
    result.rawTime !== undefined &&
    result.confidence !== "None" &&
    result.confidence !== "Low" &&
    !result.debug.suspiciousFirstFrameDetection &&
    !result.debug.movementAlreadyUnderway &&
    Number.isFinite(finalRawTime) &&
    finalRawTime >= startRawTime + 0.1 - 1e-6 &&
    finalRawTime <= videoDuration + 0.001 &&
    (!Number.isFinite(finishRawTime) || finalRawTime < finishRawTime! - 0.001)
  );
}
