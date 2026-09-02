import type { Confidence } from "../types";

export interface Hold10PhaseSplits {
  available: boolean;
  startToHold10Seconds?: number;
  hold10ToFinishSeconds?: number;
  totalSeconds?: number;
  hold10Share?: number;
  phaseDifferenceSeconds?: number;
  slowerPhase?: "start-to-hold10" | "hold10-to-finish" | "balanced";
  confidence: Confidence;
  reason: string;
}

/**
 * Calculates the two contact-defined race phases without substituting a COM
 * height crossing for Hold 10. Inputs must be accepted timestamps in raw-video
 * time, and their ordering is validated so a stale or manually mistyped marker
 * cannot produce plausible-looking negative splits.
 */
export function calculateHold10PhaseSplits(
  startRawTime: number | null | undefined,
  hold10RawTime: number | null | undefined,
  finishRawTime: number | null | undefined,
  hold10Confidence: Confidence = "None",
): Hold10PhaseSplits {
  if (![startRawTime, hold10RawTime, finishRawTime].every((value) =>
    typeof value === "number" && Number.isFinite(value),
  )) {
    return unavailable("Accepted Start, Hold 10, and Finish timestamps are required.");
  }

  const start = startRawTime!;
  const hold10 = hold10RawTime!;
  const finish = finishRawTime!;
  if (finish <= start) {
    return unavailable("Finish must occur after Start before race phases can be calculated.");
  }
  if (hold10 <= start || hold10 >= finish) {
    return unavailable("Hold 10 must occur strictly between the accepted Start and Finish.");
  }

  const startToHold10Seconds = roundTime(hold10 - start);
  const hold10ToFinishSeconds = roundTime(finish - hold10);
  const totalSeconds = roundTime(finish - start);
  const phaseDifferenceSeconds = roundTime(Math.abs(startToHold10Seconds - hold10ToFinishSeconds));
  const slowerPhase = phaseDifferenceSeconds <= 0.05
    ? "balanced"
    : startToHold10Seconds > hold10ToFinishSeconds
      ? "start-to-hold10"
      : "hold10-to-finish";
  return {
    available: true,
    startToHold10Seconds,
    hold10ToFinishSeconds,
    totalSeconds,
    hold10Share: roundTime(startToHold10Seconds / totalSeconds),
    phaseDifferenceSeconds,
    slowerPhase,
    confidence: hold10Confidence,
    reason: "Race phases use the accepted start, verified Hold 10 hand contact, and accepted finish.",
  };
}

function unavailable(reason: string): Hold10PhaseSplits {
  return {
    available: false,
    confidence: "None",
    reason,
  };
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}
