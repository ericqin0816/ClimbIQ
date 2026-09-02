import { describe, expect, it } from "vitest";
import { resolveFinishSearchWindow } from "./finishSearchWindow";

describe("automatic finish search window", () => {
  it("stops a long event replay 30 seconds after the selected start", () => {
    expect(resolveFinishSearchWindow(600, 5855)).toEqual({ start: 603, end: 630 });
  });

  it("uses the end of a short attempt clip", () => {
    const result = resolveFinishSearchWindow(7.13, 32.17);
    expect(result.start).toBeCloseTo(10.13, 8);
    expect(result.end).toBeCloseTo(32.13, 8);
  });

  it("repairs an invalid maximum so the window never precedes its minimum", () => {
    expect(resolveFinishSearchWindow(4, 100, 3, 1)).toEqual({ start: 7, end: 34 });
  });
});
