import { parseMarkerTime } from "./video-robustness.mjs";

/** Compare identical test media, not historical human-correctness flags. */
export function compareVideoRuns(before, after, toleranceSeconds = 0.1) {
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) throw new Error("Tolerance must be finite and non-negative.");
  for (const [label, report] of [["Before", before], ["After", after]]) {
    if (!report?.finishedAt || !Array.isArray(report.runs)) throw new Error(`${label} report is unfinished or malformed.`);
  }
  const index = report => {
    const entries = new Map();
    for (const run of report.runs) {
      if (!run?.sourceName || !run?.variationId) throw new Error("A run is missing its source/variation identity.");
      const key = JSON.stringify([run.sourceName, run.variationId]);
      if (entries.has(key)) throw new Error("Duplicate source/variation runs cannot be paired unambiguously.");
      entries.set(key, run);
    }
    return entries;
  };
  const oldRuns = index(before), newRuns = index(after);
  const keys = [...new Set([...oldRuns.keys(), ...newRuns.keys()])].sort();
  const cases = keys.map(key => {
    const old = oldRuns.get(key), next = newRuns.get(key);
    const [sourceName, variationId] = JSON.parse(key);
    const base = { sourceName, variationId };
    if (!old || !next) return { ...base, status: old ? "missing-after" : "added-after" };
    if (!validHash(old.media?.sha256) || !validHash(next.media?.sha256) ||
        !validHash(old.media?.sourceSha256) || !validHash(next.media?.sourceSha256)) {
      return { ...base, status: "unverified-media-identity" };
    }
    if (old.media.sha256 !== next.media.sha256 || old.media.sourceSha256 !== next.media.sourceSha256) {
      return { ...base, status: "different-media" };
    }
    if (old.error || next.error || old.outcome?.workflow?.error || next.outcome?.workflow?.error || !old.outcome || !next.outcome) {
      return { ...base, status: "workflow-error", beforeError: old.error ?? old.outcome?.workflow?.error ?? null,
        afterError: next.error ?? next.outcome?.workflow?.error ?? null };
    }
    const boundaries = Object.fromEntries(["start", "finish"].map(boundary => {
      const from = parseMarkerTime(old.outcome[boundary]?.rawTime), to = parseMarkerTime(next.outcome[boundary]?.rawTime);
      const deltaSeconds = from !== null && to !== null ? round(to - from) : null;
      const status = from === null ? to === null ? "remains-unaccepted" : "new-unverified-acceptance"
        : to === null ? "availability-loss"
          : Math.abs(deltaSeconds) > toleranceSeconds + 1e-9 ? "output-timing-drift"
            : Math.abs(deltaSeconds) > 1e-9 ? "changed-within-policy" : "unchanged";
      return [boundary, { status, beforeRawTime: from, afterRawTime: to, deltaSeconds }];
    }));
    const comparableTracking = before.fullWorkflow === true && after.fullWorkflow === true &&
      (before.sampleFps ?? 5) === (after.sampleFps ?? 5);
    const previousTracking = tracking(old.outcome), nextTracking = tracking(next.outcome);
    return { ...base, status: "paired", beforeVersion: old.app?.version ?? null, afterVersion: next.app?.version ?? null,
      boundaries, tracking: comparableTracking ? { before: previousTracking, after: nextTracking,
        coverageDelta: previousTracking?.coverage != null && nextTracking?.coverage != null
          ? round(nextTracking.coverage - previousTracking.coverage) : null,
        note: "Coverage is tracking availability, not spatial or contact accuracy." }
        : { note: "Tracking not compared: workflow modes or pose sampling rates differ." } };
  });
  const paired = cases.filter(item => item.status === "paired");
  const boundaryResults = paired.flatMap(item => Object.values(item.boundaries));
  return {
    schemaVersion: 1, interpretation: "Paired output regression on checksummed identical media. No independently labeled accuracy or correctness improvement is inferred.",
    toleranceSeconds, beforeFinishedAt: before.finishedAt, afterFinishedAt: after.finishedAt,
    summary: { pairedCases: paired.length, unpairedCases: cases.length - paired.length,
      availabilityLosses: boundaryResults.filter(b => b.status === "availability-loss").length,
      newUnverifiedAcceptances: boundaryResults.filter(b => b.status === "new-unverified-acceptance").length,
      timingDrifts: boundaryResults.filter(b => b.status === "output-timing-drift").length,
      changedWithinPolicy: boundaryResults.filter(b => b.status === "changed-within-policy").length,
      accuracy: null },
    cases,
  };
}

function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function round(value) { return Math.round(value * 1e6) / 1e6; }
function tracking(outcome) {
  const workflow = outcome?.workflow;
  if (!workflow) return null;
  const requested = workflow.requestedFrames, valid = workflow.validFrames;
  if (!Number.isInteger(requested) || !Number.isInteger(valid) || requested < 0 || valid < 0 || valid > requested) return null;
  return { validFrames: valid, requestedFrames: requested, coverage: requested > 0 ? round(valid / requested) : null,
    hold10TargetSource: workflow.secondPass?.targetSource ?? null,
    hold10EvidenceKind: workflow.secondPass?.kind ?? null };
}
