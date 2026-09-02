import type { FirstMovementDetectionResult } from "../types";

export interface StartBodyAudit {
  safeToAutoAccept: boolean;
  reason: string;
}

/**
 * A fused light/audio timestamp is only auto-accepted when the selected lane
 * also shows a plausible launch immediately afterward. This is deliberately a
 * safety gate, not a replacement clock: light/audio still define the exact
 * timestamp, while body motion prevents a later gym beep or duplicate light
 * event from being accepted after the athlete has already left the start.
 */
export function assessAutomaticStartBodyAudit(
  movement: FirstMovementDetectionResult,
  proposedStartRawTime: number,
): StartBodyAudit {
  if (movement.debug.movementAlreadyUnderway) {
    return {
      safeToAutoAccept: false,
      reason: "Body motion was already underway at the proposed start, so the later light/audio event requires review.",
    };
  }

  if (!movement.detected || movement.rawTime === undefined || movement.confidence === "None" || movement.confidence === "Low") {
    return {
      safeToAutoAccept: false,
      reason: "The selected lane did not show a reliable launch after the proposed start, so the timestamp requires review.",
    };
  }

  const delay = movement.rawTime - proposedStartRawTime;
  // A speed-climbing launch should follow the start cue promptly. A generous
  // 0.75 s ceiling still covers unusually slow reactions while refusing to
  // connect an unrelated later movement to an earlier gym beep/light change.
  if (delay < -0.02 || delay > 0.75) {
    return {
      safeToAutoAccept: false,
      reason: delay < 0
        ? "Reliable body motion began before the proposed start, so the later light/audio event requires review."
        : "Reliable body motion began too long after the proposed start, so the timestamp requires review.",
    };
  }

  if (movement.debug.suspiciousFirstFrameDetection) {
    return {
      safeToAutoAccept: false,
      reason: "Motion was already strong on the first post-start sample, so ClimbIQ cannot prove the athlete launched after this timestamp.",
    };
  }

  return {
    safeToAutoAccept: true,
    reason: `Lane-local body motion confirmed a launch ${Math.max(0, delay).toFixed(3)}s after the proposed start.`,
  };
}
