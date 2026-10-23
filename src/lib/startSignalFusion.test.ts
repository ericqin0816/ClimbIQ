import { describe, expect, it } from "vitest";
import { fuseStartEvidence, fusedObservationInterval, requireContinuousStartScene, visualConfirmationConsensus, type StartEvidence } from "./startSignalFusion";

it("does not average an excluded artifact into an otherwise accepted light clock", () => {
  const decision = fuseStartEvidence([
    { kind: "color", rawTime: 2, confidence: "High", reason: "screen artifact", automaticVoteAllowed: false },
    { kind: "color", rawTime: 2.3, confidence: "High", reason: "valid sensor" },
  ]);
  expect(decision.autoAccept).toBe(true);
  expect(decision.rawTime).toBe(2.3);
});

describe("start signal fusion", () => {
  it("does not describe a weak coincident color patch as an accepted light when exact audio owns Start", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 8.59, confidence: "High", reason: "Complete countdown" },
      { kind: "color", rawTime: 8.835, confidence: "Low", label: "weak foreground", reason: "Review only" },
    ]);
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBe(8.59);
    expect(result.reason).toContain("final beep");
    expect(result.reason).not.toContain("green→blue light");
    expect(result.supportingEvidence.some(item => item.label === "weak foreground")).toBe(true);
  });
  it("does not rank a known camera cut above an eligible alternative review event", () => {
    // Reconstructed from the Edinburgh4103 development export. These are
    // observed cues, not independent labels for the true electronic Start.
    const cut: StartEvidence = { kind: "color", rawTime: 5.433333, confidence: "High", label: "cut",
      automaticVoteAllowed: false, artifactReason: "Camera cut changed 40.9% of the frame.", reason: "excluded patch" };
    const alternative: StartEvidence = { kind: "color", rawTime: 6.466667, confidence: "High", label: "alternative", reason: "eligible visual cue" };
    const decision = fuseStartEvidence([cut, alternative,
      { kind: "color", rawTime: 5.2, confidence: "Low", reason: "weak patch" },
      { kind: "audio", rawTime: 9.82, confidence: "Medium", reason: "approximate beep" },
      { kind: "motion", rawTime: 0.8, confidence: "Low", reason: "motion estimate" },
    ]);
    expect(decision.rawTime).toBe(6.467);
    expect(decision.autoAccept).toBe(false);
    expect(decision.confidence).toBe("Medium");
    expect(decision.supportingEvidence).toEqual([alternative]);
    expect(decision.rejectedEvidence).toContain(cut);
    expect(decision.reason).toContain(cut.artifactReason);
    expect(decision.reason).toContain("still requires frame review");
  });

  it("omits an artifact from a mixed review clock without discarding its diagnostics", () => {
    const artifact: StartEvidence = { kind: "color", rawTime: 2, confidence: "High", reason: "overlay", automaticVoteAllowed: false };
    const decision = fuseStartEvidence([artifact,
      { kind: "color", rawTime: 2.2, confidence: "Medium", reason: "eligible light" },
      { kind: "motion", rawTime: 2.3, confidence: "Low", reason: "uncertain motion" },
    ]);
    expect(decision.rawTime).toBe(2.2);
    expect(decision.autoAccept).toBe(false);
    expect(decision.rejectedEvidence).toContain(artifact);
    expect(decision.supportingEvidence).not.toContain(artifact);
  });

  it("does not promote a different event after removing an artifact's ranking vote", () => {
    const decision = fuseStartEvidence([
      { kind: "color", rawTime: 1, confidence: "High", reason: "overlay", automaticVoteAllowed: false },
      { kind: "color", rawTime: 3, confidence: "High", reason: "other visual event" },
    ]);
    expect(decision.rawTime).toBe(3);
    expect(decision.autoAccept).toBe(false);
    expect(decision.conflict).toBe(true);
  });

  it("keeps a changed event review-only even when weak artifacts cannot trigger the strong-conflict veto", () => {
    const artifacts = Array.from({ length: 7 }, (_, index): StartEvidence => ({
      kind: "color", rawTime: 1 + index * 0.001, confidence: "Low", reason: "weak overlay patch", automaticVoteAllowed: false,
    }));
    const decision = fuseStartEvidence([...artifacts,
      { kind: "color", rawTime: 3, confidence: "High", reason: "eligible alternative" },
    ]);
    expect(decision.rawTime).toBe(3);
    expect(decision.conflict).toBe(false);
    expect(decision.autoAccept).toBe(false);
    expect(decision.confidence).toBe("Medium");
  });

  it("preserves an exact eligible audio clock even when a rejected visual cluster ranks highly", () => {
    const decision = fuseStartEvidence([
      { kind: "color", rawTime: 1, confidence: "High", reason: "overlay", automaticVoteAllowed: false },
      { kind: "color", rawTime: 1.01, confidence: "High", reason: "overlay duplicate", automaticVoteAllowed: false },
      { kind: "audio", rawTime: 4, confidence: "High", reason: "exact protocol" },
      { kind: "color", rawTime: 4.05, confidence: "Medium", reason: "eligible sensor" },
    ]);
    expect(decision.rawTime).toBe(4);
    // Existing competing-evidence veto remains in force.
    expect(decision.autoAccept).toBe(false);
  });

  it("keeps an accepted exact-audio clock with an artifact neighbor ahead of more Medium visual votes elsewhere", () => {
    const audio: StartEvidence = { kind: "audio", rawTime: 2, confidence: "High", reason: "exact protocol" };
    const artifact: StartEvidence = { kind: "color", rawTime: 2.1, confidence: "High", reason: "blocked neighboring patch", automaticVoteAllowed: false };
    const alternatives = [5, 5.05, 5.1, 5.15].map((rawTime): StartEvidence => ({
      kind: "color", rawTime, confidence: "Medium", reason: "unrelated visual event",
    }));
    const decision = fuseStartEvidence([audio, artifact, ...alternatives,
      { kind: "motion", rawTime: 5.2, confidence: "Low", reason: "passerby" },
    ]);
    expect(decision.rawTime).toBe(2);
    expect(decision.confidence).toBe("High");
    expect(decision.autoAccept).toBe(true);
    expect(decision.conflict).toBe(false);
    expect(decision.supportingEvidence).toEqual([audio]);
    expect(decision.rejectedEvidence).toContain(artifact);
  });

  it("does not replace the original eligible exact-audio event with a later higher-scoring exact-audio cluster", () => {
    const original: StartEvidence = { kind: "audio", rawTime: 2, confidence: "High", reason: "first exact protocol" };
    const artifacts = Array.from({ length: 7 }, (_, index): StartEvidence => ({
      kind: "color", rawTime: 2.01 + index * 0.001, confidence: "High", reason: "blocked neighbor", automaticVoteAllowed: false,
    }));
    const alternatives = [5.05, 5.1, 5.15, 5.2].map((rawTime): StartEvidence => ({
      kind: "color", rawTime, confidence: "Medium", reason: "later visual event",
    }));
    const decision = fuseStartEvidence([original, ...artifacts, ...alternatives,
      { kind: "audio", rawTime: 5, confidence: "High", reason: "later exact protocol" },
      { kind: "motion", rawTime: 5.2, confidence: "Low", reason: "passerby" },
    ]);
    expect(decision.rawTime).toBe(2);
    expect(decision.autoAccept).toBe(true);
    expect(decision.confidence).toBe("High");
    expect(decision.supportingEvidence).toEqual([original]);
  });

  it("keeps an all-artifact cursor inspectable when no eligible light or audio clock exists", () => {
    const artifact: StartEvidence = { kind: "color", rawTime: 1, confidence: "High", reason: "cut", automaticVoteAllowed: false };
    const decision = fuseStartEvidence([artifact,
      { kind: "motion", rawTime: 1.1, confidence: "Low", reason: "uncertain motion" },
    ]);
    expect(decision.rawTime).toBe(1);
    expect(decision.autoAccept).toBe(false);
    expect(decision.supportingEvidence).toContain(artifact);
  });

  it("does not veto agreeing departures because their later blue confirmations differ", () => {
    const cues = [7.1, 7.3, 7.5].map((blue): StartEvidence => ({
      kind: "color", rawTime: 7.033333, blueConfirmationRawTime: blue,
      observationIntervalSeconds: 1 / 30, confidence: "High", reason: "same departure",
    }));
    expect(visualConfirmationConsensus(cues)).toEqual({outliers: [], ambiguous: false});
    expect(fuseStartEvidence(cues).autoAccept).toBe(true);
  });
  it("does not exclude a clock near the majority solely for slower blue visibility", () => {
    const cues = [[9.31,9.45],[9.38,9.48],[9.414,9.7]].map(([rawTime,blue]): StartEvidence => ({
      kind: "color", rawTime, blueConfirmationRawTime: blue,
      observationIntervalSeconds: 1 / 30, confidence: "High", reason: "different exposure",
    }));
    expect(visualConfirmationConsensus(cues)).toEqual({outliers: [], ambiguous: false});
    expect(fuseStartEvidence(cues).supportingEvidence).toHaveLength(3);
  });
  it("excludes a native-refined temporal outlier instead of averaging it into an agreeing blue transition",()=>{
    const cue=(label:string,time:number,blue:number,confidence:"High"|"Medium"):StartEvidence=>({label,kind:"color",rawTime:time,
      blueConfirmationRawTime:blue,observationIntervalSeconds:1/30,confidence,reason:"test"});
    const early=cue("early",6.7,6.85,"Medium");
    const a=cue("a",7.066667,7.066667,"High"),b=cue("b",7.066667,7.066667,"High");
    const result=fuseStartEvidence([early,a,b]);
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBe(7.067);
    expect(result.supportingEvidence).toEqual([a,b]);
    expect(result.rejectedEvidence).toContain(early);
    expect(result.visualTimingOutlierLabels).toEqual(["early"]);
  });
  it("keeps balanced overlapping visual groups for review instead of picking an arbitrary majority",()=>{
    const cues=[1,1.08,1.16].map((time):StartEvidence=>({kind:"color",rawTime:time,blueConfirmationRawTime:time,
      observationIntervalSeconds:1/30,confidence:"High",reason:"test"}));
    expect(visualConfirmationConsensus(cues).ambiguous).toBe(true);
    expect(fuseStartEvidence(cues).autoAccept).toBe(false);
  });
  it("does not invent native consensus from missing metadata or let it replace an exact audio clock",()=>{
    const cues=[1,1.01,1.3].map((time):StartEvidence=>({kind:"color",rawTime:time,blueConfirmationRawTime:time,
      observationIntervalSeconds:1/30,confidence:"High",reason:"test"}));
    expect(visualConfirmationConsensus(cues.map(c=>({...c,observationIntervalSeconds:undefined})))).toEqual({outliers:[],ambiguous:false});
    expect(fuseStartEvidence([...cues,{kind:"audio",rawTime:1.02,confidence:"High",reason:"protocol"}]).rawTime).toBe(1.02);
  });
  it("does not let another patch bypass a full-frame camera-cut check in the same event",()=>{
    const decision=fuseStartEvidence([
      {kind:"color",rawTime:8.8,confidence:"High",reason:"colored banner"},
      {kind:"audio",rawTime:8.7,confidence:"Medium",reason:"approximate beep"},
    ]);
    expect(decision.autoAccept).toBe(true);
    const checked=requireContinuousStartScene(decision,[9.033333]);
    expect(checked.autoAccept).toBe(false);
    expect(checked.rawTime).toBe(decision.rawTime);
    expect(checked.reason).toContain("camera-cut");
    expect(decision.autoAccept).toBe(true);
  });
  it("keeps an audio clock inspectable but does not certify launch across a nearby cut",()=>{
    const decision=fuseStartEvidence([{kind:"audio",rawTime:7.8,confidence:"High",reason:"protocol"}]);
    expect(requireContinuousStartScene(decision,[8]).autoAccept).toBe(false);
  });
  it("does not veto an unrelated later cut or malformed cut timestamp",()=>{
    const decision=fuseStartEvidence([{kind:"color",rawTime:2,confidence:"High",reason:"sensor"}]);
    expect(requireContinuousStartScene(decision,[4,NaN,-1])).toBe(decision);
    expect(requireContinuousStartScene(fuseStartEvidence([]),[2]).found).toBe(false);
  });
  it("retains native light observation spacing without narrowing it by averaging lanes",()=>{
    const result=fuseStartEvidence([
      {kind:"color",rawTime:2,confidence:"High",reason:"lane one",observationIntervalSeconds:.1},
      {kind:"color",rawTime:2.05,confidence:"High",reason:"lane two",observationIntervalSeconds:.033},
    ]);
    expect(result.observationIntervalSeconds).toBeCloseTo(.15,8);
  });
  it("never transfers visual precision to an audio-defined clock",()=>{
    const result=fuseStartEvidence([
      {kind:"color",rawTime:2,confidence:"High",reason:"lane",observationIntervalSeconds:.033},
      {kind:"audio",rawTime:2.05,confidence:"High",reason:"exact protocol"},
    ]);
    expect(result.rawTime).toBe(2.05);
    expect(result.observationIntervalSeconds).toBeUndefined();
  });
  it("does not invent native precision for missing or invalid timing metadata",()=>{
    expect(fusedObservationInterval([])).toBeUndefined();
    for(const interval of [undefined,NaN,-1,4]) expect(fusedObservationInterval([
      {kind:"color",rawTime:2,confidence:"High",reason:"unknown",observationIntervalSeconds:interval},
    ])).toBeUndefined();
  });
  it("keeps a reliable cue cluster from being dragged away by earlier weak reflections", () => {
    const result = fuseStartEvidence([
      {kind:"color",rawTime:2.45,confidence:"Low",reason:"edge reflection"},
      {kind:"color",rawTime:2.65,confidence:"Low",reason:"weak patch"},
      {kind:"audio",rawTime:2.85,confidence:"Medium",reason:"approximate protocol"},
      {kind:"color",rawTime:2.967,confidence:"Medium",reason:"refined visual transition"},
    ]);
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBe(2.967);
  });

  it("does not promote weak reflections plus Medium audio without a reliable visual cue", () => {
    const result = fuseStartEvidence([
      {kind:"color",rawTime:2.45,confidence:"Low",reason:"edge reflection"},
      {kind:"color",rawTime:2.65,confidence:"Low",reason:"weak patch"},
      {kind:"audio",rawTime:2.85,confidence:"Medium",reason:"approximate protocol"},
    ]);
    expect(result.autoAccept).toBe(false);
    expect(result.rawTime).toBe(2.85);
  });

  it("keeps an artifact cursor inspectable without allowing correlated visual votes to accept it", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 1, confidence: "High", reason: "first patch", automaticVoteAllowed: false, artifactReason: "Camera cut." },
      { kind: "color", rawTime: 1.02, confidence: "High", reason: "second patch", automaticVoteAllowed: false, artifactReason: "Camera cut." },
      { kind: "motion", rawTime: 1.1, confidence: "Low", reason: "edit motion" },
    ]);
    expect(result.rawTime).toBeCloseTo(1.01, 3);
    expect(result.found).toBe(true);
    expect(result.autoAccept).toBe(false);
    expect(result.confidence).toBe("Low");
    expect(result.reason).toContain("Camera cut");
  });
  it("gives high confidence when light and exact final beep agree, timed by exact audio", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 3.02, confidence: "High", reason: "blue transition" },
      { kind: "audio", rawTime: 3, confidence: "High", reason: "final beep" },
      { kind: "motion", rawTime: 3.18, confidence: "Medium", reason: "launch" },
    ]);
    expect(result.confidence).toBe("High");
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBeCloseTo(3, 3);
  });

  it("treats earlier rocking as premovement when light and audio agree later", () => {
    const result = fuseStartEvidence([
      { kind: "motion", rawTime: 2.1, confidence: "Medium", reason: "rocking" },
      { kind: "color", rawTime: 3, confidence: "Medium", reason: "blue transition" },
      { kind: "audio", rawTime: 3.04, confidence: "High", reason: "final beep" },
    ]);
    expect(result.rawTime).toBeCloseTo(3.04, 3);
    expect(result.reason).toContain("setup rocking");
    expect(result.rejectedEvidence.some((item) => item.kind === "motion")).toBe(true);
  });

  it("keeps a generic beep plus body motion for review", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 2.4, confidence: "Medium", reason: "single loud beep" },
      { kind: "motion", rawTime: 2.55, confidence: "Medium", reason: "launch" },
    ]);
    expect(result.confidence).toBe("Medium");
    expect(result.autoAccept).toBe(false);
    expect(result.rawTime).toBeCloseTo(2.4, 2);
  });

  it("keeps Medium audio plus Low motion for review", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 4.29, confidence: "Medium", reason: "possible final beep" },
      { kind: "motion", rawTime: 4.41, confidence: "Low", reason: "weak lower-wall motion" },
    ]);

    expect(result.confidence).toBe("Medium");
    expect(result.autoAccept).toBe(false);
    expect(result.rawTime).toBeCloseTo(4.29, 3);
  });

  it("never auto-accepts motion as the only cue", () => {
    const result = fuseStartEvidence([
      { kind: "motion", rawTime: 2.1, confidence: "High", reason: "movement" },
    ]);
    expect(result.confidence).toBe("Low");
    expect(result.autoAccept).toBe(false);
  });

  it("requires review when strong audio and color cues conflict", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 2, confidence: "High", reason: "blue transition" },
      { kind: "audio", rawTime: 3.2, confidence: "High", reason: "final beep" },
    ]);
    expect(result.conflict).toBe(true);
    expect(result.autoAccept).toBe(false);
  });

  it("keeps a lone Medium color cue for review", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 7.2, confidence: "Medium", reason: "possible lower-wall color change" },
    ]);
    expect(result.rawTime).toBe(7.2);
    expect(result.autoAccept).toBe(false);
  });

  it("uses exact high-confidence audio instead of one low-confidence faint light as the clock", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 3, confidence: "Low", reason: "coarse faint light" },
      { kind: "audio", rawTime: 3.3, confidence: "High", reason: "same/same/different beep" },
    ]);

    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeCloseTo(3.3, 3);
  });

  it("does not downgrade exact audio when body motion also agrees", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 2.4, confidence: "High", reason: "same/same/different beep" },
      { kind: "motion", rawTime: 2.55, confidence: "Medium", reason: "launch" },
    ]);

    expect(result.confidence).toBe("High");
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.4, 3);
  });

  it("keeps exact audio authoritative over a later Medium occlusion color plus Low passerby motion", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 4.29, confidence: "High", reason: "554/554/1105 Hz start protocol" },
      { kind: "color", rawTime: 7.2, confidence: "Medium", reason: "dark occlusion" },
      { kind: "motion", rawTime: 7.12, confidence: "Low", reason: "foreground passerby" },
    ]);

    expect(result.rawTime).toBeCloseTo(4.29, 3);
    expect(result.confidence).toBe("High");
    expect(result.autoAccept).toBe(true);
    expect(result.rejectedEvidence).toHaveLength(2);
  });
});
