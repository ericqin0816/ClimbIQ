import { describe, expect, it } from "vitest";
import { fuseStartEvidence } from "./startSignalFusion";

it("does not average an excluded artifact into an otherwise accepted light clock", () => {
  const decision = fuseStartEvidence([
    { kind: "color", rawTime: 2, confidence: "High", reason: "screen artifact", automaticVoteAllowed: false },
    { kind: "color", rawTime: 2.3, confidence: "High", reason: "valid sensor" },
  ]);
  expect(decision.autoAccept).toBe(true);
  expect(decision.rawTime).toBe(2.3);
});

describe("start signal fusion", () => {
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
