import { describe, it, expect } from "vitest";
import { validatePublicWorkflowArtifact } from "./public-workflow-artifact.mjs";
const fixture = () => {
  const run = { clipId: "clip-a", sourceSha256: "a".repeat(64), startedAt: "2026-10-23T00:00:00Z", browser: "native-test", outcomeIndex: 0,
    build: { commitSha: "b".repeat(40), workingTreeDirty: false }, events: { start: { status: "automatic", rawTime: 2.07 }, finish: { status: "review", rawTime: null } } };
  const artifact = { schemaVersion: 1, startedAt: run.startedAt, browser: run.browser, build: structuredClone(run.build),
    outcomes: [{ id: run.clipId, sourceSha256: run.sourceSha256, accepted: [{ markerId: "startSignal", acceptedRawTime: 2.07, acceptanceMode: "automatic" },
      { markerId: "finishPad", acceptedRawTime: null, acceptanceMode: "unset" }] }] };
  return { run, artifact };
};
describe("original public workflow snapshot", () => {
  it("retains automatic versus review markers from the actual artifact", () => {
    const { run, artifact } = fixture(); expect(() => validatePublicWorkflowArtifact(run, artifact)).not.toThrow();
  });
  it.each([
    ["removed false acceptance", ({ run }) => { run.events.start.status = "review"; }],
    ["corrected time", ({ run }) => { run.events.start.rawTime += .1; }],
    ["promoted review", ({ run }) => { run.events.finish.status = "automatic"; run.events.finish.rawTime = 8; }],
    ["manual acceptance", ({ artifact }) => { artifact.outcomes[0].accepted[0].acceptanceMode = "frame-review"; }],
    ["wrong source", ({ run }) => { run.sourceSha256 = "c".repeat(64); }],
    ["wrong build", ({ run }) => { run.build.commitSha = "d".repeat(40); }],
    ["wrong browser", ({ run }) => { run.browser = "another-browser"; }],
    ["wrong start", ({ run }) => { run.startedAt = "2026-10-24T00:00:00Z"; }],
    ["wrong outcome", ({ run }) => { run.outcomeIndex = 2; }],
    ["duplicate markers", ({ artifact }) => { artifact.outcomes[0].accepted.push(artifact.outcomes[0].accepted[0]); }],
  ])("rejects%s", (_name, mutate) => { const f = fixture(); mutate(f); expect(() => validatePublicWorkflowArtifact(f.run, f.artifact)).toThrow(); });
});
