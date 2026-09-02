import { describe, expect, it } from "vitest";
import { resolveOfficialFinishRawTime } from "./officialTime";

describe("official finish time", () => {
  it("converts a valid official duration into raw video time", () => {
    expect(resolveOfficialFinishRawTime({
      startRawTime: 7.13,
      videoDuration: 32.17,
      officialTotalSeconds: 10.35,
    })).toBeCloseTo(17.48, 8);
  });

  it("rejects a total that extends beyond the video", () => {
    expect(resolveOfficialFinishRawTime({
      startRawTime: 9.4,
      videoDuration: 20,
      officialTotalSeconds: 15,
    })).toBeUndefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid totals (%s)", (officialTotalSeconds) => {
    expect(resolveOfficialFinishRawTime({
      startRawTime: 4,
      videoDuration: 20,
      officialTotalSeconds,
    })).toBeUndefined();
  });
});
