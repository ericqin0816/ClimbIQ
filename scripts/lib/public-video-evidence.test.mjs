import { describe, it, expect } from "vitest";
import { evaluatePublicVideoEvidence } from "./public-video-evidence.mjs";

const sha = "a".repeat(64);
function fixture() {
  const review = id => ({ reviewerId: id, method: "Original source PCM and native frames; synthetic test row only", sourceSha256: sha,
    independentOfPredictions: true, reviewedAt: "2026-10-23T01:00:00Z", status: "observable", bracket: [2, 2.04], eventDefinition: "recorded-third-tone-arrival", laneId: "global" });
  const reference = { status: "observable", reason: "Two synthetic overlapping observation intervals", frozenAt: "2026-10-23T01:01:00Z", reviews: [review("agent-a"), review("agent-b")] };
  return { schemaVersion: 1, observerType: "ai-agents", auditId: "synthetic-tests-not-field-evidence", frozenAt: "2026-10-23T00:00:00Z", toleranceSeconds: .1,
    clips: [{ id: "clip-a", attemptId: "attempt-a", sourceGroupId: "source-a", sourceSha256: sha, durationSeconds: 12, cohort: "broadcast", split: "held-out",
      sourceUrl: "https://example.org/source", sourceSpeedStatus: "unknown", clockDefinition: "Source presentation seconds", athleteGroupIds: ["athlete-a"],
      previouslyExposedToPredictions: false, primaryRunId: "primary-a", references: { start: reference } }],
    runs: [{ id: "primary-a", clipId: "clip-a", sourceSha256: sha, startedAt: "2026-10-23T02:00:00Z", build: { commitSha: "b".repeat(40), workingTreeDirty: false },
      browser: "synthetic-test", evidenceFileSha256: "c".repeat(64), automaticSnapshot: true, events: {
        start: { status: "automatic", rawTime: 2.02, eventDefinition: "recorded-third-tone-arrival", laneId: "global" }, finish: { status: "review", rawTime: 8.1 } } }] };
}
describe("public observational evidence keeps inference limits and denominators", () => {
  it("reports an interval rather than inventing an exact midpoint label", () => {
    const report = evaluatePublicVideoEvidence(fixture());
    expect(report.independentHumanStudy).toBe(false);
    expect(report.rows[0].comparison.signedDistanceRangeSeconds[0]).toBeCloseTo(-.02);
    expect(report.rows[0].comparison.signedDistanceRangeSeconds[1]).toBeCloseTo(.02);
    expect(report.endpoints.start).toMatchObject({ originals: 1, automatic: 1, comparable: 1, whollyWithinTolerance: 1 });
    expect(report.endpoints.finish).toMatchObject({ originals: 1, review: 1, comparable: 0 });
  });
  it.each([[2.2, "certainly-outside"], [2.12, "indeterminate"], [2.04, "wholly-within"]])("classifies conservative tolerance range at%s", (rawTime, result) => {
    const study = fixture(); study.runs[0].events.start.rawTime = rawTime;
    expect(evaluatePublicVideoEvidence(study).rows[0].comparison.toleranceResult).toBe(result);
  });
  it("preserves the union envelope, never the narrower intersection", () => {
    const study = fixture(); study.clips[0].references.start.reviews[1].bracket = [2.02, 2.08];
    expect(evaluatePublicVideoEvidence(study).rows[0].reference.bracket).toEqual([2, 2.08]);
  });
  it("counts a missing primary run even when a later better rerun exists", () => {
    const study = fixture(); study.runs[0].id = "rerun-a";
    expect(evaluatePublicVideoEvidence(study).endpoints.start).toMatchObject({ originals: 1, missing: 1, automatic: 0 });
  });
  it("rejects a nonprimary prediction before references were frozen", () => {
    const study = fixture(), early = structuredClone(study.runs[0]);
    Object.assign(early, { id: "earlier-unblinding-run", startedAt: "2026-10-23T00:30:00Z" }); study.runs.push(early);
    expect(() => evaluatePublicVideoEvidence(study)).toThrow(/frozen before predictions/);
  });
  it.each(["derivative", "athlete", "source"])("rejects earlier predictions in the same%s group", kind => {
    const study = fixture(), other = structuredClone(study.clips[0]), early = structuredClone(study.runs[0]);
    Object.assign(other, { id: "related-clip", sourceSha256: "d".repeat(64), primaryRunId: "early-run", references: {} });
    if (kind === "derivative") other.parentClipId = "clip-a";
    else { other.attemptId = "related-attempt"; if (kind === "athlete") other.sourceGroupId = "another-source"; else other.athleteGroupIds = []; }
    study.clips.push(other);
    Object.assign(early, { id: "early-run", clipId: other.id, sourceSha256: other.sourceSha256, startedAt: "2026-10-23T00:30:00Z" }); study.runs.push(early);
    expect(() => evaluatePublicVideoEvidence(study)).toThrow(/frozen before predictions/);
  });
  it.each(["eventDefinition", "laneId"])("does not score mismatched%s as correct", field => {
    const study = fixture(); study.runs[0].events.start[field] = "another-event-or-lane";
    expect(evaluatePublicVideoEvidence(study).endpoints.start).toMatchObject({ automatic: 1, comparable: 0, unverifiedAutomatic: 1 });
  });
  it("cannot qualify an unobservable original through an observable reference", () => {
    const study = fixture(); study.clips[0].references.start.reviews[1].status = "unobservable";
    expect(() => evaluatePublicVideoEvidence(study)).toThrow(/unobservable/);
  });
  it.each([
    ["dirty build", study => { study.runs[0].build.workingTreeDirty = true; }],
    ["corrected snapshot", study => { study.runs[0].automaticSnapshot = false; }],
    ["source mismatch", study => { study.runs[0].sourceSha256 = "d".repeat(64); }],
    ["same observer", study => { study.clips[0].references.start.reviews[1].reviewerId = "agent-a"; }],
    ["postprediction freeze", study => { study.clips[0].references.start.frozenAt = "2026-10-23T03:00:00Z"; }],
    ["postfreeze observation", study => { study.clips[0].references.start.reviews[1].reviewedAt = "2026-10-23T01:02:00Z"; }],
    ["disjoint brackets", study => { study.clips[0].references.start.reviews[1].bracket = [2.05, 2.08]; }],
    ["previously exposed holdout", study => { study.clips[0].previouslyExposedToPredictions = true; }],
    ["unknown browser", study => { study.runs[0].browser = null; }],
    ["invalid automatic time", study => { study.runs[0].events.start.rawTime = null; }],
  ])("rejects%s", (_name, mutate) => { const study = fixture(); mutate(study); expect(() => evaluatePublicVideoEvidence(study)).toThrow(); });
  it.each(["sourceGroupId", "athleteGroupIds"])("rejects whole%s split leakage", field => {
    const study = fixture(), second = structuredClone(study.clips[0]);
    Object.assign(second, { id: "clip-b", attemptId: "attempt-b", sourceSha256: "d".repeat(64), primaryRunId: "primary-b", sourceGroupId: "source-b", athleteGroupIds: ["athlete-b"], split: "development", references: {} });
    second[field] = study.clips[0][field]; study.clips.push(second);
    expect(() => evaluatePublicVideoEvidence(study)).toThrow(/leakage/);
  });
  it("does not count a derivative as another independent attempt", () => {
    const study = fixture(), child = structuredClone(study.clips[0]);
    Object.assign(child, { id: "clip-child", parentClipId: "clip-a", sourceSha256: "d".repeat(64), primaryRunId: "child-run", references: {} });
    study.clips.push(child);
    const report = evaluatePublicVideoEvidence(study);
    expect(report).toMatchObject({ originals: 1, derivatives: 1 });
    expect(report.endpoints.start.originals).toBe(1);
  });
});
