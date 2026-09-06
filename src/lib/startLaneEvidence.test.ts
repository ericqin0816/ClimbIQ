import { describe, expect, it } from "vitest";
import { associateStartLanes, deduplicateAnalysisLaneCandidates, startLaneId, type StartLaneEvidence } from "./startLaneEvidence";
import type { FusedStartDecision } from "./startSignalFusion";

const lane = (label: string, x: number, time = 2.85, score = 100): StartLaneEvidence => ({
  label, startRawTime: time, score, confidence: "High",
  zone: { id: "startLight", label, x1: x, x2: x + 0.025, y1: 0.8, y2: 0.83 },
  calibration: { beforeStartRGB: {r:10,g:100,b:20}, afterStartRGB: {r:10,g:20,b:100} },
});
const decision = (records: StartLaneEvidence[], time = 2.85): FusedStartDecision => ({
  found: true, rawTime: time, confidence: "High", autoAccept: true, conflict: false, reason: "test",
  supportingEvidence: records.map(record => ({ kind: "color", label: record.label, rawTime: record.startRawTime,
    confidence: record.confidence, reason: "visual cue", automaticVoteAllowed: record.automaticVoteAllowed })), rejectedEvidence: [],
});

describe("independent start-lane evidence association", () => {
  it("prefers verified visual support over a weak reflection closest to the beep", () => {
    const reflection = {...lane("reflection", .8), confidence:"Low" as const};
    const sensor = {...lane("sensor", .7, 2.95), confidence:"Medium" as const};
    for (const confidence of ["High", "Medium"] as const) {
      const result = associateStartLanes([reflection,sensor], {...decision([reflection,sensor]), confidence}, 2.85, undefined, true);
      expect(result.selected?.label).toBe("sensor");
      expect(result.candidates.map(c => c.startRawTime)).toEqual([2.95]);
      expect(result.audit.find(c => c.label === "reflection")).toMatchObject({eligible:false,selected:false});
    }
  });
  it("keeps standard-pass ordering and fallback availability when no new pixels recovered a cue", () => {
    const faint = {...lane("faint", .2), confidence:"Low" as const};
    const strong = lane("strong", .7, 2.95);
    const result = associateStartLanes([faint,strong], decision([faint,strong]), 2.85);
    expect(result.selected?.label).toBe("faint");
    expect(result.candidates.map(c=>c.label)).toEqual(["faint","strong"]);
  });
  it("retains faint-only lane evidence without manufacturing a stronger visual vote", () => {
    const faint = {...lane("faint", .7), confidence:"Low" as const};
    const result = associateStartLanes([faint], decision([faint]), 2.85);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBe("Low");
  });
  it("retains lane identity and order when audio demotion moves the clock", () => {
    const records = [lane("left", 0.2), lane("right", 0.7, 2.917)];
    const high = associateStartLanes(records, decision(records, 2.85), 2.85);
    const lower = associateStartLanes(records, { ...decision(records, 2.917), confidence: "Medium" }, 2.85);
    expect(lower.candidates.map(c => c.laneId)).toEqual(high.candidates.map(c => c.laneId));
    expect(lower.selected?.label).toBe("left");
    expect(lower.candidates.map(c => c.startRawTime)).toEqual([2.85, 2.917]);
  });
  it("keeps an adjacent corroborated lane across the old moving-window edge", () => {
    const a = lane("a", .2), b = lane("b", .7, 2.51);
    const result = associateStartLanes([a,b], decision([a], 2.917), 2.85);
    expect(result.candidates).toHaveLength(2);
  });
  it("never promotes an artifact even when it has the best hint match and score", () => {
    const bad = { ...lane("cut", .2), automaticVoteAllowed:false, artifactReason:"Camera cut" };
    const good = lane("sensor", .7, 2.88, 1);
    const result = associateStartLanes([bad,good], decision([bad,good]), 2.85);
    expect(result.candidates.map(c=>c.label)).toEqual(["sensor"]);
    expect(result.audit.find(c=>c.label === "cut")).toMatchObject({ eligible:false, selected:false, reason:"Camera cut" });
  });
  it("does not use an audio hint to manufacture supporting lane evidence", () => {
    const near = lane("near", .2), unrelated = lane("other race", .7, 8);
    const result = associateStartLanes([near,unrelated], decision([unrelated], 8), 2.85);
    expect(result.candidates.map(c=>c.label)).toEqual(["other race"]);
    expect(result.associationTime).toBe(8);
  });
  it("retains rejected lanes for diagnostics without passing them into Finish", () => {
    const a = lane("a",.2), b = lane("b",.7,8);
    const result = associateStartLanes([a,b], decision([a]), 2.85);
    expect(result.audit).toHaveLength(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.audit[1].eligible).toBe(false);
  });
  it("does not pass another athlete's light to Finish when a body lane was explicitly selected", () => {
    const a=lane("left",.2), b=lane("right",.7,2.85,1000);
    const body={id:"startBody" as const,label:"User lane",x1:.1,x2:.4,y1:.4,y2:.9};
    const result=associateStartLanes([a,b],decision([a,b]),2.85,body);
    expect(result.candidates.map(c=>c.label)).toEqual(["left"]);
    expect(result.audit[1].reason).toContain("user-selected");
  });
  it("gives no lane eligibility to a missing or invalid decision", () => {
    const a=lane("a",.2);
    for (const value of [{...decision([a]),found:false},{...decision([a]),rawTime:NaN}]) {
      expect(associateStartLanes([a],value,2.85).candidates).toEqual([]);
    }
  });
  it("keeps selection deterministic under equal-score input reordering", () => {
    const a=lane("a",.2), b=lane("b",.7);
    expect(associateStartLanes([a,b],decision([a,b])).selected?.label)
      .toBe(associateStartLanes([b,a],decision([a,b])).selected?.label);
  });
  it("keeps identity independent of labels, scores and candidate order", () => {
    const a=lane("a",.2), b={...a.zone,label:"renamed"};
    expect(startLaneId(a.zone)).toBe(startLaneId(b));
  });
  it("rejects malformed coordinates, empty calibration and invalid times", () => {
    const a=lane("a",.2);
    const bad = [{...a,startRawTime:NaN},{...a,calibration:{}},{...a,zone:{...a.zone,x1:-1}},
      {...a,zone:{...a.zone,x2:a.zone.x1}},{...a,score:Infinity},
      {...a,calibration:{...a.calibration,beforeStartRGB:{r:NaN,g:10,b:20}}}];
    expect(associateStartLanes(bad,decision([a]),2.85).candidates).toEqual([]);
  });
  it("deduplicates nearby patches without erasing a separate lane or its calibration", () => {
    const a=lane("a",.2), duplicate=lane("duplicate",.205), b=lane("b",.7);
    expect(deduplicateAnalysisLaneCandidates([a,duplicate,b])).toEqual([a,b]);
  });
});
