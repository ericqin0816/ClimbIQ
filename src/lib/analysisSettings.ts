import type { AnalysisSessionSettings } from "../types";

export const DEFAULT_ANALYSIS_SESSION_SETTINGS: AnalysisSessionSettings = {
  startSearchStart: 0,
  startSearchEnd: 8,
  startSensitivity: "medium",
  startLightVisibility: "clear",
  startDetectionProfile: "auto",
  reactionTimeOffset: 0.2,
  startSignalOffset: 0,
  movementSensitivity: "medium",
  firstMovementDefinition: "earliest",
  committedLaunchMinDelay: 0.1,
  firstMovementOffset: 0,
  officialTotalTime: "",
};

export function sanitizeAnalysisSessionSettings(value: unknown): AnalysisSessionSettings {
  const candidate = value && typeof value === "object" ? value as Partial<AnalysisSessionSettings> : {};
  // Leave at least one second of room for a valid search window. A value of
  // exactly 3600 could never have an end bound after it within our supported
  // one-hour range.
  const startSearchStart = bounded(candidate.startSearchStart, 0, 3599, 0);
  const requestedEnd = bounded(candidate.startSearchEnd, 0, 3600, 8);
  return {
    startSearchStart,
    startSearchEnd: requestedEnd > startSearchStart ? requestedEnd : Math.min(3600, startSearchStart + 8),
    startSensitivity: oneOf(candidate.startSensitivity, ["low", "medium", "high"] as const, "medium"),
    startLightVisibility: oneOf(candidate.startLightVisibility, ["clear", "blocked"] as const, "clear"),
    startDetectionProfile: oneOf(candidate.startDetectionProfile, ["auto", "calibrated", "generic", "blocked", "motion", "manual"] as const, "auto"),
    reactionTimeOffset: bounded(candidate.reactionTimeOffset, 0, 2, 0.2),
    startSignalOffset: bounded(candidate.startSignalOffset, -2, 2, 0),
    movementSensitivity: oneOf(candidate.movementSensitivity, ["low", "medium", "high"] as const, "medium"),
    firstMovementDefinition: oneOf(candidate.firstMovementDefinition, ["earliest", "committed"] as const, "earliest"),
    committedLaunchMinDelay: bounded(candidate.committedLaunchMinDelay, 0, 2, 0.1),
    firstMovementOffset: bounded(candidate.firstMovementOffset, -2, 2, 0),
    officialTotalTime: typeof candidate.officialTotalTime === "string"
      ? candidate.officialTotalTime
      : finiteNonNegativeString(candidate.officialTotalTime),
  };
}

function finiteNonNegativeString(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "";
}

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}
