import { describe, it, expect } from "vitest";
import { assessUserVideoReference, isUnverifiedReviewCursor, sourceFingerprintMatches } from "./user-video-reference.mjs";
const reference = { id: "test", sourceSha256: "abc", expectedTotalSeconds: 12.24, referenceSource: "user-reported total",
  requiredHoldMarkers: [{ holdId: 8, x: 0.33, y: 0.35, radius: 0.012 }] };
const outcome = { start: { rawTime: "9.400s" }, finish: { rawTime: "21.655s" }, routeMarkers: [{holdId:8,x:0.33,y:0.35}] };
describe("review cursor regression policy", () => {
  it("reports explicitly unverified private cursor changes without treating them as target labels", () => {
    expect(isUnverifiedReviewCursor({ reviewedCorrect: false }, "compared")).toBe(true);
  });
  it("continues to pin established private regression observations", () => {
    expect(isUnverifiedReviewCursor({ reviewedCorrect: true }, "compared")).toBe(false);
    expect(isUnverifiedReviewCursor({}, "compared")).toBe(false);
  });
  it("keeps unknown and explicitly false public cursors observational", () => {
    for (const reviewedCorrect of [undefined, null, false]) {
      expect(isUnverifiedReviewCursor({ reviewedCorrect }, "research-compared")).toBe(true);
    }
    expect(isUnverifiedReviewCursor({ reviewedCorrect: true }, "research-compared")).toBe(false);
  });
});
describe("benchmark source fingerprints", () => {
  it("matches exact SHA-256 bytes regardless of hex case", () => {
    expect(sourceFingerprintMatches("ab".repeat(32), "AB".repeat(32))).toBe(true);
  });
  it("rejects a different file with the same expected filename", () => {
    expect(sourceFingerprintMatches("ab".repeat(32), "cd".repeat(32))).toBe(false);
  });
  it("rejects absent, malformed and shortened digests instead of skipping validation", () => {
    for (const digest of [undefined, null, "", "abc", "g".repeat(64), "a".repeat(63), 123]) {
      expect(sourceFingerprintMatches(digest, "a".repeat(64))).toBe(false);
      expect(sourceFingerprintMatches("a".repeat(64), digest)).toBe(false);
    }
  });
});
describe("source-matched user feedback", () => {
  it("reports total error without manufacturing start/finish labels", () => {
    const result = assessUserVideoReference(reference, outcome, "abc", true);
    expect(result.errors).toEqual([]);
    expect(result.signedTotalErrorSeconds).toBe(0.015);
    expect(result.interpretation).toContain("does not independently validate");
  });
  it("rejects the wrong source even when its filename and result appear right", () => {
    expect(assessUserVideoReference(reference,outcome,"different",true).matched).toBe(false);
    expect(assessUserVideoReference({...reference,sourceSha256:null},outcome,"abc",true).matched).toBe(false);
  });
  it("fails the original 9-for-8 marker regression and missing or misplaced markers", () => {
    for (const routeMarkers of [[],[{holdId:9,x:.33,y:.35}],[{holdId:8,x:.5,y:.35}],[{holdId:8,x:NaN,y:.35}]]) {
      expect(assessUserVideoReference(reference,{...outcome,routeMarkers},"abc",true).errors).toHaveLength(1);
    }
  });
  it("does not demand route markers from timing-only tests or invent missing totals", () => {
    const result = assessUserVideoReference(reference,{},"abc",false);
    expect(result.errors).toEqual([]);
    expect(result.measuredTotalSeconds).toBeNull();
    expect(result.signedTotalErrorSeconds).toBeNull();
  });
});
