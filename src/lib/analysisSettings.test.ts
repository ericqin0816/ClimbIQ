import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYSIS_SESSION_SETTINGS,
  resolveStartSearchWindow,
  sanitizeAnalysisSessionSettings,
} from "./analysisSettings";

describe("analysis session settings", () => {
  it("preserves valid zero-valued timing settings", () => {
    const result = sanitizeAnalysisSessionSettings({
      ...DEFAULT_ANALYSIS_SESSION_SETTINGS,
      reactionTimeOffset: 0,
      committedLaunchMinDelay: 0,
      startSignalOffset: 0,
      firstMovementOffset: 0,
    });
    expect(result.reactionTimeOffset).toBe(0);
    expect(result.committedLaunchMinDelay).toBe(0);
  });

  it("replaces invalid imported modes and numeric ranges", () => {
    const result = sanitizeAnalysisSessionSettings({
      startSearchStart: -5,
      startSearchEnd: Number.POSITIVE_INFINITY,
      startSensitivity: "extreme",
      startDetectionProfile: "magic",
      firstMovementDefinition: "guess",
      reactionTimeOffset: 99,
    });
    expect(result).toMatchObject({
      startSearchStart: 0,
      startSearchEnd: 12,
      startSensitivity: "medium",
      startDetectionProfile: "auto",
      firstMovementDefinition: "earliest",
      reactionTimeOffset: 0.2,
    });
  });

  it("repairs an end bound that is not after the start bound", () => {
    const result = sanitizeAnalysisSessionSettings({ startSearchStart: 12, startSearchEnd: 8 });
    expect(result.startSearchStart).toBe(12);
    expect(result.startSearchEnd).toBe(24);
  });

  it("keeps the search window valid at the supported upper boundary", () => {
    const result = sanitizeAnalysisSessionSettings({ startSearchStart: 21600, startSearchEnd: 21600 });
    expect(result.startSearchStart).toBe(0);
    expect(result.startSearchEnd).toBe(21600);
    expect(result.startSearchEnd).toBeGreaterThan(result.startSearchStart);
  });

  it("migrates a finite numeric official time from older session data", () => {
    expect(sanitizeAnalysisSessionSettings({ officialTotalTime: 6.18 }).officialTotalTime).toBe("6.18");
  });

  it("returns complete defaults for missing input", () => {
    expect(sanitizeAnalysisSessionSettings(null)).toEqual(DEFAULT_ANALYSIS_SESSION_SETTINGS);
  });

  it("resolves an absolute window without scanning the rest of a long video", () => {
    expect(resolveStartSearchWindow({ startSearchStart: 590, startSearchEnd: 610 }, 5855)).toEqual({
      start: 590,
      end: 610,
    });
  });

  it("repairs invalid live values and clips the window to video duration", () => {
    expect(resolveStartSearchWindow({ startSearchStart: Number.NaN, startSearchEnd: 99 }, 12)).toEqual({
      start: 0,
      end: 12,
    });
  });
});
