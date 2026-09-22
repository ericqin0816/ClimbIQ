import { describe, expect, it } from "vitest";
import type { SavedAnalysisSession, TimestampMarker } from "../types";
import { DEFAULT_ANALYSIS_SESSION_SETTINGS } from "./analysisSettings";
import { buildSavedAttemptRows, searchSavedAttempts } from "./savedAttemptSearch";

function session(id: string, overrides: Partial<SavedAnalysisSession> = {}): SavedAnalysisSession {
  const marker = (markerId: TimestampMarker["id"], rawTime: number): TimestampMarker => ({ id: markerId, label: markerId,
    rawTime, climbTime: rawTime - 1, source: "Manual", confidence: "High", detectedRawTime: null, offsetApplied: 0,
    acceptanceMode: "frame-review" });
  return { id, version: 1, name: `Attempt ${id}`, climberName: "", date: "2026-09-22", location: "", attemptType: "Training", notes: "",
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", videoMetadata: null,
    zones: {}, startLightCalibration: {}, settings: { ...DEFAULT_ANALYSIS_SESSION_SETTINGS },
    timestamps: [marker("startSignal", 1), marker("finishPad", 7)], ...overrides };
}

describe("saved attempt access", () => {
  it("matches multiple search terms across athlete, location and notes without accents or case", () => {
    const rows = buildSavedAttemptRows([session("a", { climberName: "José", location: "North Gym", notes: "Practice on right lane" }), session("b")]);
    expect(searchSavedAttempts(rows, "JOSE right NORTH", "all", "updated").map(row => row.session.id)).toEqual(["a"]);
    expect(searchSavedAttempts(rows, "jose missing", "all", "updated")).toEqual([]);
  });
  it("treats punctuation as literal search text", () => {
    const rows = buildSavedAttemptRows([session("a", { name: "Attempt [1]" }), session("b", { name: "Attempt 11" })]);
    expect(searchSavedAttempts(rows, "[1]", "all", "updated").map(row => row.session.id)).toEqual(["a"]);
  });
  it("does not present missing or out-of-order endpoints as usable timing", () => {
    const valid = session("a");
    const reversed = session("b", { timestamps: valid.timestamps.map(marker => ({ ...marker, rawTime: marker.id === "finishPad" ? 0.5 : marker.rawTime })) });
    const rows = buildSavedAttemptRows([valid, reversed, session("c", { timestamps: [] })]);
    expect(searchSavedAttempts(rows, "", "timed", "updated").map(row => row.session.id)).toEqual(["a"]);
    expect(rows.find(row => row.session.id === "b")?.totalSeconds).toBeNull();
    expect(searchSavedAttempts(rows, "", "review", "updated")).toHaveLength(2);
  });
  it("retains low-confidence timing for inspection while marking it for review", () => {
    const value = session("a"); value.timestamps[1].confidence = "Low";
    const [row] = buildSavedAttemptRows([value]);
    expect(row.totalSeconds).toBe(6); expect(row.needsReview).toBe(true);
  });
  it("uses recording date independently of save date and does not mutate input", () => {
    const rows = buildSavedAttemptRows([
      session("a", { date: "2026-09-01", updatedAt: "2026-09-22T12:00:00Z" }),
      session("b", { date: "2026-09-20", updatedAt: "2026-09-21T12:00:00Z" }),
    ]);
    expect(searchSavedAttempts(rows, "", "all", "updated").map(row => row.session.id)).toEqual(["a", "b"]);
    expect(searchSavedAttempts(rows, "", "all", "recorded").map(row => row.session.id)).toEqual(["b", "a"]);
    expect(rows.map(row => row.session.id)).toEqual(["a", "b"]);
  });
  it("sorts invalid imported dates after valid dates with deterministic ties", () => {
    const rows = buildSavedAttemptRows([session("b", { date: "invalid" }), session("a"), session("c", { date: "" })]);
    expect(searchSavedAttempts(rows, "  ", "all", "recorded").map(row => row.session.id)).toEqual(["a", "b", "c"]);
  });
});
