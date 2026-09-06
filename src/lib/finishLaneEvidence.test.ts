import { describe, expect, it } from "vitest";
import { prepareFinishLaneCandidates } from "./finishLaneEvidence";
import { startLaneId, type AnalysisLaneCandidate } from "./startLaneEvidence";

const lane = (x:number): AnalysisLaneCandidate => ({
  zone:{id:"startLight",label:"observed",x1:x,x2:x+.02,y1:.8,y2:.83},
  calibration:{beforeStartRGB:{r:10,g:100,b:20},afterStartRGB:{r:10,g:20,b:100}},
  label:"observed",startRawTime:2.85,score:10,
});
describe("Finish lane evidence handoff", () => {
  it("preserves observed cue and calibration when the accepted clock changes", () => {
    const observed=lane(.7);
    const [result]=prepareFinishLaneCandidates(observed.zone,undefined,2.917,[observed]);
    expect(result.startRawTime).toBe(2.85);
    expect(result.calibration).toBe(observed.calibration);
    expect(result.laneId).toBe(startLaneId(observed.zone));
  });
  it("honors an explicitly replaced or cleared selected calibration", () => {
    const observed=lane(.7), replacement={};
    expect(prepareFinishLaneCandidates(observed.zone,replacement,2.917,[observed])[0].calibration).toBe(replacement);
  });
  it("preserves fallback ordering and does not mutate the evidence ledger", () => {
    const a=lane(.2),b=lane(.7),before=JSON.stringify([a,b]);
    const result=prepareFinishLaneCandidates(b.zone,b.calibration,3,[a,b]);
    expect(result.map(c=>c.zone)).toEqual([b.zone,a.zone]);
    expect(JSON.stringify([a,b])).toBe(before);
  });
  it("blocks an old primary light and other-lane fallbacks after the user chooses a body lane", () => {
    const a=lane(.2),b=lane(.7);
    const body={id:"startBody" as const,label:"User athlete",x1:.1,x2:.4,y1:.4,y2:.9};
    expect(prepareFinishLaneCandidates(b.zone,b.calibration,3,[b,a],body).map(c=>c.zone)).toEqual([a.zone]);
    expect(prepareFinishLaneCandidates(b.zone,b.calibration,3,[b],body)).toEqual([]);
  });
  it("uses a manual clock only when there is no observed cue record", () => {
    const a=lane(.2);
    expect(prepareFinishLaneCandidates(a.zone,a.calibration,3,[])[0].startRawTime).toBe(3);
  });
  it("retains deduplication and the existing three-region budget", () => {
    const a=lane(.1), duplicate=lane(.105), b=lane(.3),c=lane(.5),d=lane(.7);
    expect(prepareFinishLaneCandidates(undefined,undefined,3,[a,duplicate,b,c,d])).toEqual([a,b,c]);
  });
});
