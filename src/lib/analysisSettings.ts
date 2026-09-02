import type { AnalysisSessionSettings } from "../types";

const MAX_ANALYSIS_VIDEO_SECONDS = 6 * 60 * 60;

export const DEFAULT_ANALYSIS_SESSION_SETTINGS: AnalysisSessionSettings = {
  startSearchStart: 0,
  startSearchEnd: 12,
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
  // Leave room for a valid search window while supporting full event replays,
  // which commonly run longer than one hour.
  const startSearchStart = bounded(candidate.startSearchStart, 0, MAX_ANALYSIS_VIDEO_SECONDS - 0.5, 0);
  const requestedEnd = bounded(candidate.startSearchEnd, 0, MAX_ANALYSIS_VIDEO_SECONDS, 12);
  return {
    startSearchStart,
    startSearchEnd: requestedEnd > startSearchStart
      ? requestedEnd
      : Math.min(MAX_ANALYSIS_VIDEO_SECONDS, startSearchStart + 12),
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

export function resolveStartSearchWindow(
  value: unknown,
  videoDurationSeconds: number,
): { start: number; end: number } {
  const settings = sanitizeAnalysisSessionSettings(value);
  const duration = Number.isFinite(videoDurationSeconds) && videoDurationSeconds > 0
    ? videoDurationSeconds
    : 0;
  const start = Math.min(settings.startSearchStart, Math.max(0, duration - 0.5));
  const minimumEnd = Math.min(duration, start + 0.5);
  return {
    start,
    end: Math.min(duration, Math.max(minimumEnd, settings.startSearchEnd)),
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
