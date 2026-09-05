import { describe, expect, it } from "vitest";
import { compareVideoRuns, parseComparisonArgs } from "./compare-video-runs.mjs";

const run = (start = "7.13s", finish = "17.48s") => ({ sourceName: "unit.mov", variationId: "control-720",
  media: { sha256: "a".repeat(64), sourceSha256: "b".repeat(64) }, app: { version: "test" },
  outcome: { start: { rawTime: start }, finish: { rawTime: finish }, workflow: { validFrames: 40, requestedFrames: 50 } } });
const report = (...runs) => ({ finishedAt: "2026-09-05T10:00:00Z", fullWorkflow: true, runs });

describe("paired video-run comparison", () => {
  it("can expose a 43 ms output change with a stricter comparison policy", () => {
    const result = compareVideoRuns(report(run()), report(run("7.13", "17.523")), 0.01);
    expect(result.summary.timingDrifts).toBe(1);
    expect(result.cases[0].boundaries.finish.deltaSeconds).toBe(0.043);
    expect(result.summary.accuracy).toBeNull();
  });
  it("accepts an explicit CLI tolerance without silently weakening the default", () => {
    expect(parseComparisonArgs(["before.json", "after.json"])).toEqual({ beforePath: "before.json", afterPath: "after.json", toleranceSeconds: 0.1 });
    expect(parseComparisonArgs(["before.json", "after.json", "--tolerance=0.01"]).toleranceSeconds).toBe(0.01);
    expect(parseComparisonArgs(["--tolerance=0", "before.json", "after.json"]).toleranceSeconds).toBe(0);
  });
  it("rejects invalid, empty or repeated CLI tolerances", () => {
    for (const extra of [["--tolerance="], ["--tolerance=-1"], ["--tolerance=Infinity"], ["--tolerance=0.01", "--tolerance=1"], ["--unknown"]]) {
      expect(() => parseComparisonArgs(["before.json", "after.json", ...extra])).toThrow();
    }
  });
  it("keeps identical unverified output separate from accuracy", () => {
    const result = compareVideoRuns(report(run()), report(run()));
    expect(result.summary).toMatchObject({ pairedCases: 1, timingDrifts: 0, accuracy: null });
    expect(result.cases[0].boundaries.start.status).toBe("unchanged");
  });
  it("detects equal boundary shifts even when duration does not change", () => {
    const result = compareVideoRuns(report(run()), report(run("8.13", "18.48")));
    expect(result.summary.timingDrifts).toBe(2);
  });
  it("distinguishes availability loss from newly accepted unverified output", () => {
    const result = compareVideoRuns(report(run("Not set", "17.48")), report(run("7.13", "Not set")));
    expect(result.summary).toMatchObject({ availabilityLosses: 1, newUnverifiedAcceptances: 1, timingDrifts: 0 });
  });
  it("reports small real output changes rather than rounding them away", () => {
    const result = compareVideoRuns(report(run()), report(run("7.131", "17.580")));
    expect(result.summary.changedWithinPolicy).toBe(2);
    expect(result.cases[0].boundaries.start.deltaSeconds).toBe(0.001);
  });
  it("does not pair different bytes under an identical filename", () => {
    const altered = run(); altered.media.sha256 = "c".repeat(64);
    expect(compareVideoRuns(report(run()), report(altered)).cases[0].status).toBe("different-media");
  });
  it("requires both source and transformed media checksums", () => {
    const altered = run(); delete altered.media.sourceSha256;
    expect(compareVideoRuns(report(run()), report(altered)).cases[0].status).toBe("unverified-media-identity");
  });
  it("does not hide failed workflows behind missing timestamps", () => {
    const failed = run(); failed.outcome.workflow.error = "Decode failure";
    expect(compareVideoRuns(report(run()), report(failed)).cases[0].status).toBe("workflow-error");
  });
  it("reports cohort additions and removals", () => {
    const added = run(); added.sourceName = "second.mov";
    const result = compareVideoRuns(report(run()), report(added));
    expect(result.summary.unpairedCases).toBe(2);
    expect(result.cases.map(c => c.status).sort()).toEqual(["added-after", "missing-after"]);
  });
  it("rejects unfinished reports, duplicates, and invalid tolerance", () => {
    expect(() => compareVideoRuns({ runs: [] }, report())).toThrow("unfinished");
    expect(() => compareVideoRuns(report(run(), run()), report(run()))).toThrow("Duplicate");
    for (const tolerance of [-1, Infinity, NaN]) expect(() => compareVideoRuns(report(), report(), tolerance)).toThrow("Tolerance");
  });
  it("does not compare coverage at different pose sampling rates", () => {
    const result = compareVideoRuns(report(run()), { ...report(run()), sampleFps: 15 });
    expect(result.cases[0].tracking.note).toContain("not compared");
    expect(result.cases[0].tracking.coverageDelta).toBeUndefined();
  });
  it("does not invent zero-percent coverage for an unavailable scan", () => {
    const empty = run(); empty.outcome.workflow = { validFrames: 0, requestedFrames: 0 };
    const result = compareVideoRuns(report(run()), report(empty));
    expect(result.cases[0].tracking.after.coverage).toBeNull();
    expect(result.cases[0].tracking.coverageDelta).toBeNull();
  });
});
