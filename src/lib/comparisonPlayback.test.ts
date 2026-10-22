import { describe, expect, it } from "vitest";
import { comparisonPlaybackRange, comparisonPlaybackTime } from "./comparisonPlayback";
import { createPracticeSession } from "./practiceRecordings";

describe("comparison replay", () => {
  it("aligns elapsed time and stops each attempt at its own endpoint", () => {
    const a = comparisonPlaybackRange(createPracticeSession("a"), "total")!;
    const b = comparisonPlaybackRange(createPracticeSession("b"), "total")!;
    expect(comparisonPlaybackTime(a, 3)).toBe(4);
    expect(comparisonPlaybackTime(b, 3)).toBe(4);
    expect(comparisonPlaybackTime(a, 20)).toBe(6.6);
    expect(comparisonPlaybackTime(b, 20)).toBe(6.2);
    expect(comparisonPlaybackTime(a, -3)).toBe(1);
    expect(comparisonPlaybackTime(a, NaN)).toBe(1);
  });
  it("withholds phase replay until contact is frame reviewed", () => {
    const attempt = createPracticeSession("a");
    expect(comparisonPlaybackRange(attempt, "bottom")).toBeNull();
    attempt.timestamps.find(item => item.id === "hold10")!.acceptanceMode = "frame-review";
    expect(comparisonPlaybackRange(attempt, "bottom")).toEqual({ start: 1, end: 3.8 });
    expect(comparisonPlaybackRange(attempt, "top")).toEqual({ start: 3.8, end: 6.6 });
    attempt.timestamps.find(item => item.id === "hold10")!.rawTime = 9;
    expect(comparisonPlaybackRange(attempt, "bottom")).toBeNull();
  });
  it("retains practice identity on reopening without inventing reviewed contact", () => {
    const a = createPracticeSession("a"), copy = createPracticeSession("a");
    expect(a.id).not.toBe(copy.id);
    expect(a.attemptLineageId).toBe(copy.attemptLineageId);
    expect(a.timestamps.every(marker => marker.acceptanceMode !== "frame-review")).toBe(true);
  });
});
