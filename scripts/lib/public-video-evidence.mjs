const ENDPOINTS = ["start", "finish"];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === "string" && value.trim().length > 0;
const time = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = value => text(value) && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bracket = (value, duration) => Array.isArray(value) && value.length === 2 && value.every(time) && value[0] <= value[1] && value[1] <= duration;
const count = () => ({ originals: 0, automatic: 0, review: 0, missing: 0, failed: 0, comparable: 0, unverifiedAutomatic: 0,
  certainlyOutsideTolerance: 0, whollyWithinTolerance: 0, toleranceIndeterminate: 0 });

function referenceFor(reference, clip, runStartedAt) {
  if (!reference) return { status: "missing" };
  assert(["observable", "unobservable", "disputed"].includes(reference.status), "Invalid reference status.");
  assert(text(reference.reason), "Reference needs an observation reason, including unobservable events.");
  assert(date(reference.frozenAt), "Reference freeze date is required.");
  if (runStartedAt) assert(Date.parse(reference.frozenAt) < Date.parse(runStartedAt), "Reference must be frozen before predictions.");
  assert(Array.isArray(reference.reviews) && reference.reviews.length === 2, "Preserve exactly two independent agent observations.");
  assert(new Set(reference.reviews.map(review => review.reviewerId)).size === 2, "Two different observers are required.");
  for (const review of reference.reviews) {
    assert(text(review.reviewerId) && text(review.method) && review.independentOfPredictions === true, "Missing independent observation provenance.");
    assert(review.sourceSha256 === clip.sourceSha256, "Reference source hash mismatch.");
    assert(date(review.reviewedAt) && Date.parse(review.reviewedAt) <= Date.parse(reference.frozenAt), "Reference freeze predates an observation.");
    assert(["observable", "unobservable", "disputed"].includes(review.status), "Invalid observer status.");
    if (review.status === "observable") {
      assert(bracket(review.bracket, clip.durationSeconds), "Invalid source-time observation bracket.");
      assert(text(review.eventDefinition) && text(review.laneId), "Observation needs a physical event and lane.");
    }
  }
  const provenance = { frozenAt: reference.frozenAt, reason: reference.reason, reviews: reference.reviews };
  if (reference.status !== "observable") return { status: reference.status, ...provenance };
  const [a, b] = reference.reviews;
  assert(a.status === "observable" && b.status === "observable", "An unobservable/disputed original cannot qualify a reference.");
  assert(a.eventDefinition === b.eventDefinition && a.laneId === b.laneId, "Observers must agree on physical event and lane.");
  assert(Math.max(a.bracket[0], b.bracket[0]) <= Math.min(a.bracket[1], b.bracket[1]), "Nonoverlapping observations remain disputed.");
  // The wider envelope preserves both observations; no invented exact midpoint.
  return { status: "observable", ...provenance, envelopeMethod: "union-of-overlapping-observer-brackets", eventDefinition: a.eventDefinition, laneId: a.laneId,
    bracket: [Math.min(a.bracket[0], b.bracket[0]), Math.max(a.bracket[1], b.bracket[1])] };
}

/** Public recording observations are separate from the recruited human beta study. */
export function evaluatePublicVideoEvidence(study) {
  assert(study?.schemaVersion === 1 && study.observerType === "ai-agents", "This audit is explicitly scoped to AI-agent observations.");
  assert(text(study.auditId) && date(study.frozenAt), "Audit identity and protocol freeze are required.");
  assert(time(study.toleranceSeconds) && study.toleranceSeconds > 0, "Predeclare a positive comparison tolerance.");
  assert(Array.isArray(study.clips) && Array.isArray(study.runs), "Clips and runs must be arrays.");
  const clips = new Map(), attempts = new Set(), hashes = new Set(), groups = new Map(), runs = new Map(), primaryIds = new Set();
  for (const clip of study.clips) {
    assert(text(clip.id) && !clips.has(clip.id), "Duplicate or missing clip ID.");
    assert(text(clip.attemptId) && text(clip.sourceGroupId) && hash(clip.sourceSha256), "Missing source/attempt identity.");
    assert(time(clip.durationSeconds) && clip.durationSeconds > 0, "Invalid clip duration.");
    assert(["fixed-phone", "broadcast", "panning", "unknown"].includes(clip.cohort), "Declare recording condition.");
    assert(["development", "held-out"].includes(clip.split), "Declare development/held-out split.");
    assert(/^https:\/\//.test(clip.sourceUrl ?? ""), "A public source URL is required.");
    assert(text(clip.primaryRunId), "Predeclare one primary run per recording.");
    assert(!primaryIds.has(clip.primaryRunId), "Primary run IDs must be unique."); primaryIds.add(clip.primaryRunId);
    assert(["normal", "slow-motion", "unknown"].includes(clip.sourceSpeedStatus) && text(clip.clockDefinition), "Record source speed status and local clock definition.");
    if (clip.derivation) {
      assert(["full-source-acquisition", "trim", "unknown"].includes(clip.derivation.kind) && text(clip.derivation.description), "Invalid source derivation.");
      if (clip.derivation.kind === "trim") assert(hash(clip.derivation.parentSha256) && bracket(clip.derivation.requestedParentRangeSeconds, Infinity), "Trim needs its parent hash and requested source interval.");
    }
    assert(Array.isArray(clip.athleteGroupIds) && clip.athleteGroupIds.every(text), "Declare known athlete groups; use an empty array when unknown.");
    assert(clip.split !== "held-out" || clip.previouslyExposedToPredictions === false, "Previously exposed sources cannot remain held out.");
    assert(!hashes.has(clip.sourceSha256), "Duplicate source bytes cannot establish distinct attempts.");
    hashes.add(clip.sourceSha256);
    if (!clip.parentClipId) { assert(!attempts.has(clip.attemptId), "Duplicate original attempt."); attempts.add(clip.attemptId); }
    for (const group of ["source:" + clip.sourceGroupId, ...(clip.athleteGroupIds ?? []).map(id => "athlete:" + id)]) {
      assert(!groups.has(group) || groups.get(group) === clip.split, "Source/athlete group split leakage."); groups.set(group, clip.split);
    }
    clips.set(clip.id, clip);
  }
  for (const clip of clips.values()) if (clip.parentClipId) {
    const parent = clips.get(clip.parentClipId);
    assert(parent && !parent.parentClipId && parent.attemptId === clip.attemptId && parent.split === clip.split && parent.sourceGroupId === clip.sourceGroupId,
      "Derivatives must retain original attempt, source group and split.");
  }
  for (const run of study.runs) {
    assert(text(run.id) && !runs.has(run.id), "Duplicate or missing run ID.");
    const clip = clips.get(run.clipId);
    assert(clip && run.sourceSha256 === clip.sourceSha256, "Run source hash mismatch.");
    assert(date(run.startedAt) && Date.parse(run.startedAt) > Date.parse(study.frozenAt), "Run must follow protocol freeze.");
    assert(/^[a-f0-9]{40}$/.test(run.build?.commitSha ?? "") && run.build.workingTreeDirty === false, "A clean identified build is required.");
    assert(text(run.browser) && text(run.evidenceFileSha256), "Preserve browser identity and original run-artifact hash.");
    assert(hash(run.evidenceFileSha256), "Invalid original run-artifact hash.");
    assert(run.automaticSnapshot === true, "Corrected markers cannot replace original predictions.");
    for (const event of ENDPOINTS) {
      const prediction = run.events?.[event];
      assert(prediction && ["automatic", "review", "missing", "failed"].includes(prediction.status), "Invalid original endpoint status.");
      assert(prediction.rawTime === null || (time(prediction.rawTime) && prediction.rawTime <= clip.durationSeconds), "Prediction is outside recording.");
      assert(prediction.status !== "automatic" || prediction.rawTime !== null, "Automatic endpoint requires a timestamp.");
    }
    runs.set(run.id, run);
  }
  // Source and athlete memberships connect entire groups, including derivatives
  // and nonprimary runs. A later primary cannot repair an already unblinded label.
  const parents = new Map([...clips.keys()].map(id => [id, id]));
  const find = id => { const parent = parents.get(id); if (parent === id) return id; const root = find(parent); parents.set(id, root); return root; };
  const groupOwners = new Map();
  for (const clip of clips.values()) for (const group of ["source:" + clip.sourceGroupId, ...clip.athleteGroupIds.map(id => "athlete:" + id)]) {
    const owner = groupOwners.get(group);
    if (owner) parents.set(find(clip.id), find(owner)); else groupOwners.set(group, clip.id);
  }
  const earliestRuns = new Map();
  for (const run of runs.values()) {
    const group = find(run.clipId), earliest = earliestRuns.get(group);
    if (!earliest || Date.parse(run.startedAt) < Date.parse(earliest)) earliestRuns.set(group, run.startedAt);
  }
  const byCohort = {}, endpoints = { start: count(), finish: count() }, rows = [];
  for (const clip of clips.values()) {
    const run = runs.get(clip.primaryRunId);
    assert(!run || run.clipId === clip.id, "Primary run belongs to another recording.");
    for (const event of ENDPOINTS) {
      const reference = referenceFor(clip.references?.[event], clip, earliestRuns.get(find(clip.id)));
      if (clip.parentClipId) continue; // Derivatives never increase accuracy/coverage denominators.
      const prediction = run?.events[event] ?? { status: "missing", rawTime: null };
      const row = { clipId: clip.id, attemptId: clip.attemptId, sourceSha256: clip.sourceSha256, sourceUrl: clip.sourceUrl,
        sourceGroupId: clip.sourceGroupId, athleteGroupIds: clip.athleteGroupIds, sourceSpeedStatus: clip.sourceSpeedStatus, clockDefinition: clip.clockDefinition,
        derivation: clip.derivation ?? { kind: "unknown", description: "Source derivation not supplied; no original-file claim established." },
        primaryRunId: clip.primaryRunId, run: run ? { id: run.id, startedAt: run.startedAt, build: run.build, browser: run.browser, evidenceFileSha256: run.evidenceFileSha256 } : null,
        event, cohort: clip.cohort, split: clip.split, prediction, reference, comparison: null };
      const matching = reference.status === "observable" && prediction.eventDefinition === reference.eventDefinition && prediction.laneId === reference.laneId;
      if (prediction.status === "automatic" && matching) {
        const [lo, hi] = reference.bracket, p = prediction.rawTime;
        const minimumAbsoluteDistanceSeconds = Math.max(lo - p, p - hi, 0);
        const maximumAbsoluteDistanceSeconds = Math.max(Math.abs(p - lo), Math.abs(p - hi));
        row.comparison = { signedDistanceRangeSeconds: [p - hi, p - lo], minimumAbsoluteDistanceSeconds, maximumAbsoluteDistanceSeconds,
          toleranceResult: minimumAbsoluteDistanceSeconds > study.toleranceSeconds + 1e-9 ? "certainly-outside" :
            maximumAbsoluteDistanceSeconds <= study.toleranceSeconds + 1e-9 ? "wholly-within" : "indeterminate" };
      }
      const key = `${clip.split}/${clip.cohort}`;
      byCohort[key] ??= { start: count(), finish: count() };
      for (const counts of [endpoints[event], byCohort[key][event]]) {
        counts.originals++; counts[prediction.status]++;
        if (row.comparison) {
          counts.comparable++;
          counts[{ "certainly-outside": "certainlyOutsideTolerance", "wholly-within": "whollyWithinTolerance", indeterminate: "toleranceIndeterminate" }[row.comparison.toleranceResult]]++;
        } else if (prediction.status === "automatic") counts.unverifiedAutomatic++;
      }
      rows.push(row);
    }
  }
  return { schemaVersion: 1, auditId: study.auditId, dataKind: "agent-observed-public-video-evidence", independentHumanStudy: false,
    observerType: "ai-agents", status: "observational-only",
    limitations: ["AI-agent observations do not satisfy the independent human beta study.", "Brackets express observation resolution, not calibrated physical/electronic timing accuracy.",
      "Public broadcasts/pans do not establish supported fixed-phone accuracy.", "Missing primary runs remain in denominators; derivatives and reruns do not add attempts.",
      "Review/missing/failed endpoints have no automatic timing-error score; no user correction time or training benefit is inferred."],
    toleranceSeconds: study.toleranceSeconds, originals: attempts.size, derivatives: study.clips.length - attempts.size,
    sourceGroups: new Set(study.clips.map(clip => clip.sourceGroupId)).size, endpoints, byCohort, rows };
}
