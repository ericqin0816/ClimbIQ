import { describe, expect, it } from "vitest";
import { buildCoachingCatalog, buildCoachingSelectionCatalog, coachingPlanForClient, normalizeCoachingPacket, parseCoachingPacket, validateCoachingPlan, type LegacyCoachingPacket } from "./coachingPolicy";

export const packet = (): LegacyCoachingPacket => ({ version: 1, goal: "overview", baseline: null, current: {
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
  it("prioritizes the largest measured phase change instead of static single-run facts", () => {
    const p = packet();
    p.current = { ...p.current, totalSeconds: 12, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7 };
    p.baseline = { ...p.current, totalSeconds: 13, bottomSeconds: 6 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.headline).toMatchObject({ state: "shorter", title: "1.000s shorter overall" });
    expect(catalog.defaultPlan.observationIds.slice(0, 2)).toEqual(["total-change", "bottom-change"]);
    expect(catalog.defaultPlan.focusId).toBe("review-bottom");
    expect(catalog.comparisonRows).toMatchObject([
      { id: "total", deltaSeconds: -1, outcome: "shorter" },
      { id: "bottom", deltaSeconds: -1, outcome: "shorter" },
      { id: "top", deltaSeconds: 0, outcome: "similar" },
    ]);
  });
  it("explains offsetting section changes even when the total is unchanged", () => {
    const p = packet();
    p.current = { ...p.current, totalSeconds: 12, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7 };
    p.baseline = { ...p.current, bottomSeconds: 6, topSeconds: 6 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.headline.state).toBe("similar");
    expect(catalog.defaultPlan.observationIds).toEqual(["no-change", "phase-balance", "bottom-change"]);
    expect(catalog.observations.find(item => item.id === "phase-balance")?.text).toContain("total difference still falls within");
    expect(catalog.limitations.map(item => item.id)).toContain("phase-overlap");
  });
  it("uses the stronger top-phase change as the next review even if bottom improved", () => {
    const p = packet();
    p.current = { ...p.current, totalSeconds: 13, reviewedHold10: true, bottomSeconds: 4.5, topSeconds: 8.5 };
    p.baseline = { ...p.current, totalSeconds: 12, bottomSeconds: 5, topSeconds: 7 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.defaultPlan.focusId).toBe("review-top");
    expect(catalog.defaultPlan.observationIds).toEqual(["total-change", "phase-balance", "top-change"]);
    expect(catalog.headline).toMatchObject({ title: "1.000s longer overall", state: "longer" });
  });
  it("respects the chosen start focus without inventing movement improvements", () => {
    const p = packet(); p.goal = "start"; p.baseline = { ...p.current, totalSeconds: 14, movementSeconds: .9 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.defaultPlan.observationIds.slice(0, 2)).toEqual(["total-change", "movement"]);
    expect(catalog.defaultPlan.focusId).toBe("review-start");
    expect(catalog.comparisonRows.map(item => item.id)).toEqual(["total"]);
  });
  it("keeps unfinished evidence checks independent from model-selected findings", () => {
    const p = packet(); p.current.movementSeconds = null; p.current.speedCoverage = null;
    p.baseline = { ...p.current, totalSeconds: 13 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.reviewTasks.map(item => item.id)).toEqual(expect.arrayContaining(["review-movement", "review-hold10", "improve-recording", "review-baseline-hold10"]));
    const plan = validateCoachingPlan({ observationIds: ["total"], focusId: "record-comparable" }, catalog);
    expect(plan.observationIds).toEqual(["total"]);
    expect(catalog.reviewTasks).toHaveLength(4);
    expect(catalog.comparisonRows).toHaveLength(1);
    expect(catalog.headline.state).toBe("shorter");
  });
  it("never treats partial coverage as one continuous trace", () => {
    const catalog = buildCoachingCatalog(packet());
    expect(catalog.observations.find(item => item.id === "tracking")?.text).toContain("segments cover 60%");
    expect(catalog.observations.find(item => item.id === "tracking")?.text).not.toContain("continuous");
  });
  it("classifies rounded boundary differences consistently with attempt comparison", () => {
    const p = packet(); p.current.totalSeconds = 10; p.baseline = { ...p.current, totalSeconds: 10.1 };
    const catalog = buildCoachingCatalog(p);
    expect(catalog.comparisonRows[0]).toMatchObject({ deltaSeconds: -.1, outcome: "similar" });
    expect(catalog.headline.state).toBe("similar");
    p.current.comparisonFloorSeconds = .4; p.baseline.totalSeconds = 10.3;
    expect(buildCoachingCatalog(p).comparisonRows[0]).toMatchObject({ thresholdSeconds: .4, outcome: "similar" });
  });
  it("remains deterministic and leaves the accepted evidence untouched", () => {
    const p = packet(); const before = JSON.stringify(p);
    const first = buildCoachingCatalog(p);
    expect(buildCoachingCatalog(p)).toEqual(first);
    expect(JSON.stringify(p)).toBe(before);
    for (const goal of ["overview", "start", "halves", "consistency"] as const) {
      const catalog = buildCoachingCatalog({ ...p, goal });
      expect(validateCoachingPlan(catalog.defaultPlan, catalog)).toEqual(catalog.defaultPlan);
    }
  });
  it("preserves v1 packet shape and version while normalizing only internal calculations", () => {
    const old = packet(); old.current.comparisonFloorSeconds = .75;
    old.current = { ...old.current, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7.255 };
    old.baseline = { ...old.current, totalSeconds: 12.555, topSeconds: 7.555 };
    const serialized = JSON.stringify(old);
    expect(parseCoachingPacket(old)).toBe(old);
    expect(JSON.stringify(parseCoachingPacket(old))).toBe(serialized);
    expect(normalizeCoachingPacket(old)).toMatchObject({ version: 2, current: { comparisonFloorsSeconds: { total: .75, bottom: .75, top: .75 } } });
    expect(buildCoachingCatalog(old).comparisonRows.every(row => row.thresholdSeconds === .75)).toBe(true);
    expect(buildCoachingCatalog(old).headline.state).toBe("similar");
    expect(JSON.stringify(old)).toBe(serialized);
  });
  it("uses independent v2 floors for total and each reviewed phase", () => {
    const next = normalizeCoachingPacket(packet());
    next.current = { ...next.current, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7.255,
      comparisonFloorsSeconds: { total: .1, bottom: .8, top: .8 } };
    next.baseline = { ...next.current, totalSeconds: 12.555, bottomSeconds: 5.3 };
    const catalog = buildCoachingCatalog(next);
    expect(catalog.comparisonRows).toMatchObject([
      { id: "total", deltaSeconds: -.3, outcome: "shorter", thresholdSeconds: .1 },
      { id: "bottom", deltaSeconds: -.3, outcome: "similar", thresholdSeconds: .8 },
      { id: "top", deltaSeconds: 0, outcome: "similar", thresholdSeconds: .8 },
    ]);
    expect(catalog.defaultPlan.observationIds[0]).toBe("total-change");
  });
  it("strictly rejects mixed-version, private, and inconsistent floor fields", () => {
    const next = normalizeCoachingPacket(packet());
    for (const field of ["attemptLineageId", "rawTime", "notes", "comparisonFloorSeconds"]) {
      expect(() => parseCoachingPacket({ ...next, current: { ...next.current, [field]: "private" } })).toThrow();
    }
    for (const total of [NaN, Infinity, .01, null, "0.1", 601]) {
      expect(() => parseCoachingPacket({ ...next, current: { ...next.current, comparisonFloorsSeconds: { total, bottom: null, top: null } } })).toThrow();
    }
    expect(() => parseCoachingPacket({ ...next, current: { ...next.current, comparisonFloorsSeconds: { total: .1, bottom: .1, top: .1 } } })).toThrow();
    expect(() => parseCoachingPacket({ ...next, current: { ...next.current, comparisonFloorsSeconds: { total: .1, bottom: null, top: null, rawTime: 1 } } })).toThrow();
    expect(() => parseCoachingPacket({ ...next, version: 1 })).toThrow();
    expect(() => parseCoachingPacket({ ...packet(), version: 2 })).toThrow();
  });
  it("offers v1 models only IDs understood by the original client", () => {
    const old = packet();
    old.current = { ...old.current, reviewedHold10: true, bottomSeconds: 5, topSeconds: 7.255 };
    old.baseline = { ...old.current, bottomSeconds: 6, topSeconds: 6.255 };
    const catalog = buildCoachingCatalog(old);
    expect(catalog.defaultPlan.observationIds).toContain("phase-balance");
    const legacyCatalog = buildCoachingSelectionCatalog(old);
    expect(legacyCatalog.observations.map(item => item.id)).not.toContain("phase-balance");
    expect(legacyCatalog.focuses.map(item => item.id)).not.toEqual(expect.arrayContaining(["review-movement", "review-baseline-hold10"]));
    const adapted = coachingPlanForClient(old, catalog.defaultPlan);
    expect(adapted.observationIds).not.toContain("phase-balance");
    expect(validateCoachingPlan(adapted, legacyCatalog)).toEqual(adapted);
    const next = normalizeCoachingPacket(old);
    expect(coachingPlanForClient(next, catalog.defaultPlan).observationIds).toContain("phase-balance");
  });
  it("adapts newer archived v1 review tasks without inventing a performance fact", () => {
    const old = packet(); old.current.movementSeconds = null;
    const adapted = coachingPlanForClient(old, { observationIds: ["total"], focusId: "review-movement" });
    expect(adapted.observationIds).toEqual(["total"]);
    expect(adapted.focusId).not.toBe("review-movement");
    expect(() => coachingPlanForClient(old, { observationIds: ["injury-risk"], focusId: "review-movement" })).toThrow();
  });
});
