import { describe, expect, it } from "vitest";
import { finishObservationInterval, finishPrecisionNote, observationComparisonFloor, sanitizeObservationInterval, timingConfidence } from "./timingEvidence";

describe("timing evidence versus precision", () => {
  it("reports 200 ms observations for a decoded 5 fps source, not the requested 30 fps scan", () => {
    const samples=[21.4,21.6,21.8].map(time=>({time,timestampMethod:"video-frame" as const,sourceFrameDurationSeconds:.2}));
    expect(finishObservationInterval(samples,21.6)).toBeCloseTo(.2,8);
    expect(finishPrecisionNote({rawTime:21.6,confidence:"High",observationIntervalSeconds:.2})).toContain("200 ms");
  });
  it("uses the wider sampled bracket rather than overstating high-FPS precision", () => {
    expect(finishObservationInterval([{time:1,timestampMethod:"video-frame"},{time:1.2,timestampMethod:"video-frame",sourceFrameDurationSeconds:1/60}],1.2)).toBeCloseTo(.2,8);
  });
  it("handles millisecond-rounded selected times and variable source intervals", () => {
    expect(finishObservationInterval([{time:17.438333,timestampMethod:"video-frame"},{time:17.471667,timestampMethod:"video-frame",sourceFrameDurationSeconds:.035}],17.472)).toBe(.035);
  });
  it("does not invent source precision from cursor timestamps or missing evidence", () => {
    expect(finishObservationInterval([{time:1,timestampMethod:"seek-cursor",sourceFrameDurationSeconds:.2}],1)).toBeUndefined();
    expect(finishObservationInterval([],1)).toBeUndefined();
    expect(finishObservationInterval([{time:1,timestampMethod:"video-frame"}],1)).toBeUndefined();
    expect(finishPrecisionNote({rawTime:1,confidence:"High"})).toContain("unverified");
  });
  it("bounds imported intervals and refuses non-numeric values", () => {
    for(const value of [null,"0.2",0,-1,NaN,Infinity,3]) expect(sanitizeObservationInterval(value)).toBeUndefined();
    expect(sanitizeObservationInterval(.2)).toBe(.2);
  });
  it("does not let a High finish conceal a Low start", () => {
    expect(timingConfidence({rawTime:1,confidence:"Low"},{rawTime:10,confidence:"High"})).toBe("Low");
    expect(timingConfidence({rawTime:null,confidence:"High"},{rawTime:10,confidence:"High"})).toBe("None");
  });
  it("makes comparisons more conservative for coarse source evidence", () => {
    expect(observationComparisonFloor([{observationIntervalSeconds:.2},{}])).toBe(.4);
    expect(observationComparisonFloor([{observationIntervalSeconds:.035},{observationIntervalSeconds:.035}])).toBe(.14);
  });
});
