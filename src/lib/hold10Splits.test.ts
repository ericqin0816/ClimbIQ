import { describe, expect, it } from "vitest";
import { calculateHold10PhaseSplits } from "./hold10Splits";

describe("Hold 10 race-phase splits", () => {
  it("calculates Start to Hold 10 and Hold 10 to Finish from accepted raw times", () => {
    expect(calculateHold10PhaseSplits(7.13, 12.53, 17.48, "High")).toEqual({
      available: true,
      startToHold10Seconds: 5.4,
      hold10ToFinishSeconds: 4.95,
      totalSeconds: 10.35,
      hold10Share: 0.522,
      confidence: "High",
      reason: "Race phases use the accepted start, verified Hold 10 hand contact, and accepted finish.",
    });
  });

  it("keeps sub-frame decimal precision stable", () => {
    const result = calculateHold10PhaseSplits(4.29, 9.6476, 14.29, "Medium");
    expect(result.startToHold10Seconds).toBe(5.358);
    expect(result.hold10ToFinishSeconds).toBe(4.642);
    expect(result.totalSeconds).toBe(10);
  });

  it.each([
    [null, 5, 10],
    [0, null, 10],
    [0, 5, null],
    [0, Number.NaN, 10],
  ])("stays unavailable when any accepted boundary is missing or invalid", (start, hold10, finish) => {
    expect(calculateHold10PhaseSplits(start, hold10, finish).available).toBe(false);
  });

  it("rejects Hold 10 at or outside the accepted climb range", () => {
    expect(calculateHold10PhaseSplits(5, 5, 12).reason).toContain("strictly between");
    expect(calculateHold10PhaseSplits(5, 12, 12).reason).toContain("strictly between");
    expect(calculateHold10PhaseSplits(5, 4, 12).reason).toContain("strictly between");
  });

  it("rejects a non-positive accepted climb range", () => {
    expect(calculateHold10PhaseSplits(12, 10, 5).reason).toContain("Finish must occur after Start");
  });
});
