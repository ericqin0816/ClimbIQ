import type { Confidence } from "../types";

/** Observation spacing is a measurement limitation, not a validated error bar. */
export function sanitizeObservationInterval(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.001 && value <= 2 ? value : undefined;
}

export function finishObservationInterval(
  samples: readonly { time: number; timestampMethod?: "video-frame" | "seek-cursor"; sourceFrameDurationSeconds?: number }[],
  selectedRawTime: number | undefined,
): number | undefined {
  if (selectedRawTime === undefined || !Number.isFinite(selectedRawTime)) return undefined;
  const index = samples.findIndex(sample => Math.abs(sample.time - selectedRawTime) <= 0.001);
  const selected = samples[index], previous = samples[index - 1];
  if (!selected || selected.timestampMethod !== "video-frame") return undefined;
  const duration = sanitizeObservationInterval(selected.sourceFrameDurationSeconds);
  const spacing = previous?.timestampMethod === "video-frame"
    ? sanitizeObservationInterval(selected.time - previous.time) : undefined;
  const interval = Math.max(duration ?? 0, spacing ?? 0);
  return interval > 0 ? interval : undefined;
}

type TimingMarker = { rawTime: number | null; confidence: Confidence; observationIntervalSeconds?: number };

export function timingConfidence(start: TimingMarker, finish: TimingMarker): Confidence {
  if (start.rawTime === null || finish.rawTime === null) return "None";
  const levels: Confidence[] = ["None", "Low", "Medium", "High"];
  const rank = Math.min(levels.indexOf(start.confidence), levels.indexOf(finish.confidence));
  return levels[Math.max(0, rank)];
}

export function finishPrecisionNote(finish: TimingMarker): string {
  if (finish.rawTime === null) return "";
  const interval = sanitizeObservationInterval(finish.observationIntervalSeconds);
  return interval === undefined
    ? "Video timing precision is unverified. Decimal places and detection confidence are not an accuracy bound."
    : `Finish observation interval: about ${Math.round(interval * 1000)} ms. Detection confidence is not a timing-accuracy bound.`;
}

/** Conservative comparison policy for two event boundaries, not a confidence interval. */
export function observationComparisonFloor(markers: readonly { observationIntervalSeconds?: number }[]): number {
  return 2 * markers.reduce((sum, marker) => sum + (sanitizeObservationInterval(marker.observationIntervalSeconds) ?? 0), 0);
}
