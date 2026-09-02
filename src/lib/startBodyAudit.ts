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
  const nearCuePreMotion = movement.debug.samples.some((sample) =>
    sample.time < proposedStartRawTime &&
    sample.time >= proposedStartRawTime - 0.15 &&
    sample.smoothedMotionScore >= movement.debug.threshold,
  );
  if (nearCuePreMotion) {
    return {
      safeToAutoAccept: false,
      reason: "Reliable lane-local motion was already present within 0.150s before the proposed start, so the cue is late and requires review.",
    };
  }

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
  // World Climbing treats a recorded reaction below 0.100 s as a false start.
  // Even when the race was valid, a shorter visual delay means our cue or
  // motion timestamp is wrong, so it must never be accepted automatically.
  if (delay >= -0.02 && delay < 0.1 - 1e-6) {
    return {
      safeToAutoAccept: false,
      reason: `The measured reaction was only ${Math.max(0, delay).toFixed(3)}s; reactions below 0.100s are not a plausible valid race start, so the timestamp requires review.`,
    };
  }

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
