import { describe, expect, it } from "vitest";
import { analysisFailureFromOutcome, evaluateKnownVideoFailure } from "./known-video-failures.mjs";
const testCase = { id: "fixture", fileName: "fixture.mp4", sha256: "a".repeat(64), boundary: "finish", rejectedRawTime: 29.717, toleranceSeconds: 0.1, evidence: "Known reset" };
const outcome = time => ({ finish: { rawTime: time }, status: "Timing requires review." });

describe("known false-finish regression fingerprints", () => {
  it("fails an application exception instead of calling it safe abstention", () => {
    const failed = { ...outcome("Not set"), status: "Quick Analyze stopped: Decoder failed." };
    expect(analysisFailureFromOutcome(failed)).toContain("Decoder failed");
    expect(evaluateKnownVideoFailure(testCase, failed, testCase.sha256).failed).toBe(true);
    expect(analysisFailureFromOutcome({ status: "Quick Analyze cancelled. Existing timing was kept." })).toBeUndefined();
  });
  it("does not claim successful refusal when analysis status is unreadable", () => {
    expect(evaluateKnownVideoFailure(testCase, { ...outcome("Not set"), status: "" }, testCase.sha256).failed).toBe(true);
  });
  it("fails a reproduced reset even when no exact correct Finish is labeled", () => {
    expect(evaluateKnownVideoFailure(testCase, outcome("29.717s"), testCase.sha256)).toMatchObject({ failed: true, status: "known-failure-recurred", isIndependentAccuracyLabel: false });
  });
  it("verifies withholding without claiming overall accuracy", () => {
    expect(evaluateKnownVideoFailure(testCase, outcome("Not set"), testCase.sha256)).toMatchObject({ failed: false, status: "guard-held" });
  });
  it("does not silently bless a different unverified accepted boundary", () => {
    expect(evaluateKnownVideoFailure(testCase, outcome("14.3s"), testCase.sha256)).toMatchObject({ failed: false, status: "different-output-needs-review" });
  });
  it("refuses to apply a fingerprint to changed media", () => {
    expect(evaluateKnownVideoFailure(testCase, outcome("Not set"), "b".repeat(64))).toMatchObject({ failed: true, status: "media-mismatch" });
  });
  it("does not count a broken workflow as a safe refusal", () => {
    expect(evaluateKnownVideoFailure(testCase, { ...outcome("Not set"), workflow: { error: "decode failed" } }, testCase.sha256).failed).toBe(true);
  });
  it("validates the configured failure case", () => {
    expect(() => evaluateKnownVideoFailure({ ...testCase, toleranceSeconds: Infinity }, outcome("Not set"), testCase.sha256)).toThrow("Malformed");
  });
  it("does not count missing or malformed marker UI as a safe refusal", () => {
    for (const value of [undefined, "", "NaN", "unknown"]) {
      expect(evaluateKnownVideoFailure(testCase, outcome(value), testCase.sha256)).toMatchObject({ failed: true, status: "unreadable-boundary" });
    }
  });
});
