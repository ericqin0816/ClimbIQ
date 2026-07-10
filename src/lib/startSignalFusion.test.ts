import { describe, expect, it } from "vitest";
import { fuseStartEvidence } from "./startSignalFusion";

describe("start signal fusion", () => {
  it("gives high confidence when light and final beep agree", () => {
    const result = fuseStartEvidence([
      { kind: "color", rawTime: 3.02, confidence: "High", reason: "blue transition" },
      { kind: "audio", rawTime: 3, confidence: "High", reason: "final beep" },
      { kind: "motion", rawTime: 3.18, confidence: "Medium", reason: "launch" },
    ]);
    expect(result.confidence).toBe("High");
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBeCloseTo(3.01, 2);
  });

  it("treats earlier rocking as premovement when light and audio agree later", () => {
    const result = fuseStartEvidence([
      { kind: "motion", rawTime: 2.1, confidence: "Medium", reason: "rocking" },
      { kind: "color", rawTime: 3, confidence: "Medium", reason: "blue transition" },
      { kind: "audio", rawTime: 3.04, confidence: "High", reason: "final beep" },
    ]);
    expect(result.rawTime).toBeCloseTo(3.02, 2);
    expect(result.reason).toContain("setup rocking");
    expect(result.rejectedEvidence.some((item) => item.kind === "motion")).toBe(true);
  });

  it("auto-accepts when the final beep and body motion agree", () => {
    const result = fuseStartEvidence([
      { kind: "audio", rawTime: 2.4, confidence: "Medium", reason: "single loud beep" },
      { kind: "motion", rawTime: 2.55, confidence: "Medium", reason: "launch" },
    ]);
    expect(result.confidence).toBe("Medium");
    expect(result.autoAccept).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.4, 2);
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
});
