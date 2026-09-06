import { describe, expect, it } from "vitest";
import type { Confidence } from "../types";
import { preferDetailedStartLight, shouldRetryStartLightDetail, type AutomaticStartLightResult } from "./detectAutomaticStartLight";

function pass(confidence: Confidence, rawTime = 3): AutomaticStartLightResult {
  return { found:true, confidence, score:1, reason:"test", laneResults:[{
    detected:true, confidence, rawTime, reason:"test", threshold:1,
    debug:{zoneExists:true, framesSampled:12, maxColorDistance:30, threshold:1, detectedCrossings:[], samples:[]},
  }] };
}

describe("bounded source-detail retry", () => {
  it("does not retry a strong refined visual cue", () => {
    expect(shouldRetryStartLightDetail(pass("High"),1080,1920)).toBe(false);
  });
  it("retries weak visual evidence only when unsampled source pixels exist", () => {
    expect(shouldRetryStartLightDetail(pass("Low"),720,1280)).toBe(true);
    expect(shouldRetryStartLightDetail(pass("Medium"),480,320)).toBe(false);
    expect(shouldRetryStartLightDetail(pass("Low"),NaN,1920)).toBe(false);
  });
  it("retains the standard result for equal-strength or weaker alternatives", () => {
    expect(preferDetailedStartLight(pass("Medium"),pass("Medium",3.1))).toBe(false);
    expect(preferDetailedStartLight(pass("Medium"),pass("Low"))).toBe(false);
    expect(preferDetailedStartLight(pass("None"),pass("Low"))).toBe(false);
  });
  it("accepts a stronger refined visual pass, not more votes from the same pixels", () => {
    expect(preferDetailedStartLight(pass("Low"),pass("Medium"))).toBe(true);
    expect(preferDetailedStartLight(pass("Medium"),pass("High"))).toBe(true);
  });
  it("does not let a different event replace the protocol-guided search", () => {
    expect(preferDetailedStartLight(pass("Low"),pass("High",8),3)).toBe(false);
    expect(preferDetailedStartLight(pass("Low"),pass("High",3.1),3)).toBe(true);
  });
  it("ignores invalid times even with a high confidence label", () => {
    expect(preferDetailedStartLight(pass("Low"),pass("High",NaN))).toBe(false);
    expect(preferDetailedStartLight(pass("Low"),pass("High",-1))).toBe(false);
  });
});
