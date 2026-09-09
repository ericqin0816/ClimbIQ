import { describe, expect, it } from "vitest";
import { buildCoachingCatalog, parseCoachingPacket, validateCoachingPlan, type CoachingPacket } from "./coachingPolicy";

export const packet = (): CoachingPacket => ({ version: 1, goal: "overview", baseline: null, current: {
  timingState: "accepted", totalSeconds: 12.255, movementSeconds: .2, reviewedHold10: false,
  bottomSeconds: null, topSeconds: null, speedCoverage: .6, comparisonFloorSeconds: .1,
} });
describe("coaching evidence policy", () => {
  it("keeps the known run's accepted video total without claiming timer verification", () => {
    const catalog = buildCoachingCatalog(packet());
    expect(catalog.observations[0].text).toContain("12.255s");
    expect(catalog.observations[0].text).toContain("not an electronic-timer verification");
    expect(catalog.limitations.map(x => x.id)).toContain("hold10-review");
    expect(catalog.observations.map(x => x.id)).not.toContain("halves");
  });
  it("withholds all performance conclusions when timing needs review", () => {
    const p = packet(); p.current = { ...p.current, timingState: "review", totalSeconds: null, movementSeconds: null, speedCoverage: null };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.observations).toEqual([]);
    expect(catalog.defaultPlan).toEqual({ observationIds: [], focusId: "review-timing" });
  });
  it("rejects unreviewed phases and inconsistent arithmetic", () => {
    const p = packet(); p.current.bottomSeconds = 5; p.current.topSeconds = 7.255;
    expect(() => parseCoachingPacket(p)).toThrow();
    p.current.reviewedHold10 = true; expect(() => parseCoachingPacket(p)).not.toThrow();
    p.current.topSeconds = 8; expect(() => parseCoachingPacket(p)).toThrow();
  });
  it("does not label changes below the comparison floor as improvements", () => {
    const p = packet(); p.baseline = { ...p.current, totalSeconds: 12.24 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.observations.map(x => x.id)).toContain("no-change");
    expect(catalog.observations.map(x => x.id)).not.toContain("total-change");
  });
  it("only compares halves when both contacts are reviewed", () => {
    const p = packet(); p.current = { ...p.current, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7.255 };
    p.baseline = { ...p.current, totalSeconds: 13.255, bottomSeconds: 6 };
    expect(buildCoachingCatalog(p).observations.map(x => x.id)).toContain("bottom-change");
    p.baseline = { ...p.baseline, reviewedHold10: false, bottomSeconds: null, topSeconds: null };
    expect(buildCoachingCatalog(p).observations.map(x => x.id)).not.toContain("bottom-change");
  });
  it.each([NaN, Infinity, -1, 601, "12.24"])("rejects invalid total %s", value => {
    const p = packet(); (p.current as unknown as Record<string, unknown>).totalSeconds = value;
    expect(() => parseCoachingPacket(p)).toThrow();
  });
  it("rejects names, notes, URLs and unknown packet keys", () => {
    for (const key of ["name", "notes", "videoUrl", "instructions"]) expect(() => parseCoachingPacket({ ...packet(), [key]: "private" })).toThrow();
  });
  it("prevents the model from supplying prose, new facts or unsupported focuses", () => {
    const catalog = buildCoachingCatalog(packet());
    expect(validateCoachingPlan(catalog.defaultPlan, catalog)).toEqual(catalog.defaultPlan);
    for (const value of [
      { ...catalog.defaultPlan, advice: "Your hips are too far out" },
      { observationIds: ["fatigue"], focusId: "review-start" },
      { observationIds: ["total"], focusId: "injury-rehab" },
      { observationIds: ["total", "total"], focusId: "review-start" },
    ]) expect(() => validateCoachingPlan(value, catalog)).toThrow();
    expect(catalog.limitations.map(x => x.id)).toEqual(expect.arrayContaining(["measurement-limits", "tracking-gaps", "hold10-review"]));
  });
});
