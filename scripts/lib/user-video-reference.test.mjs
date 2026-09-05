import { describe, it, expect } from "vitest";
import { assessUserVideoReference } from "./user-video-reference.mjs";
const reference = { id: "test", sourceSha256: "abc", expectedTotalSeconds: 12.24, referenceSource: "user-reported total",
  requiredHoldMarkers: [{ holdId: 8, x: 0.33, y: 0.35, radius: 0.012 }] };
const outcome = { start: { rawTime: "9.400s" }, finish: { rawTime: "21.655s" }, routeMarkers: [{holdId:8,x:0.33,y:0.35}] };
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
