const EVENTS = ["start", "hold10", "finish"];
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const date = value => nonempty(value) && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const canonicalHash = value => typeof value === "string" ? value.toLowerCase() : value;
const median = values => quantile(values, .5);
function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function errorSummary(errors) {
  return { count: errors.length, signedMedianSeconds: median(errors), absoluteMedianSeconds: median(errors.map(Math.abs)), absoluteP95Seconds: quantile(errors.map(Math.abs), .95) };
}
function proportion(numerator, denominator) {
  if (!denominator) return { numerator, denominator, fraction: null, wilson95: null };
  const z = 1.959963984540054, z2 = z * z, p = numerator / denominator, scale = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / scale;
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * denominator)) / denominator) / scale;
  return { numerator, denominator, fraction: p, wilson95: [Math.max(0, center - half), Math.min(1, center + half)] };
}

/** RFC4180-style quoting, including commas/newlines in annotation methods. */
export function parseLabelWorksheet(text) {
  const records = []; let row = [], cell = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      assert(!cell && !closed, "Unexpected quote in label worksheet."); quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (c !== ",") {
        if (row.some(nonempty)) records.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      assert(!closed, "Unexpected characters after a quoted label field."); cell += c;
    }
  }
  assert(!quoted, "Unclosed quoted label field.");
  if (cell || row.length) { row.push(cell); if (row.some(nonempty)) records.push(row); }
  if (!records.length) return [];
  const headers = records.shift();
  assert(headers.every(nonempty) && new Set(headers).size === headers.length, "Label worksheet has empty or duplicate headers.");
  return records.map((values, index) => {
    assert(values.length === headers.length, `Label row ${index + 2} has the wrong column count.`);
    const result = Object.fromEntries(headers.map((header, i) => [header, values[i]]));
    for (const key of ["labelReview.rawTime", "lastBeforeRawTime", "firstAfterRawTime", "officialTotalSeconds"]) {
      const numericText = result[key]?.trim();
      if (numericText) {
        const value = Number(numericText); assert(finite(value), `Invalid ${key} in label row ${index + 2}.`); result[key] = value;
      } else result[key] = null;
    }
    if (result["labelReview.independentOfDetector"] !== undefined) {
      assert(["true", "false"].includes(result["labelReview.independentOfDetector"]), `Missing independence declaration in label row ${index + 2}.`);
      result["labelReview.independentOfDetector"] = result["labelReview.independentOfDetector"] === "true";
    }
    return result;
  });
}

function validReview(row) {
  return ["confirmed", "disputed"].includes(row["labelReview.status"]) && row["labelReview.independentOfDetector"] === true &&
    nonempty(row["labelReview.reviewerId"]) && nonempty(row["labelReview.method"]) && date(row["labelReview.reviewedAt"]) &&
    finite(row["labelReview.rawTime"]) && nonempty(row.evidenceSource);
}

function referenceFor(rows, event) {
  const eventRows = rows.filter(row => row.event === event);
  const originalRows = eventRows.filter(row => row.reviewRole === "reviewer");
  assert(originalRows.length <= 2, `Expected exactly two original reviewers for ${rows[0]?.clipId}/${event}; preserve additional reviews outside this scoring worksheet.`);
  const reviewers = eventRows.filter(row => row.reviewRole === "reviewer" && validReview(row));
  const adjudications = eventRows.filter(row => row.reviewRole === "adjudicator" && validReview(row) && row["labelReview.status"] === "confirmed");
  assert(adjudications.length <= 1, `Multiple confirmed adjudications for ${rows[0]?.clipId}/${event}.`);
  const adjudication = adjudications[0];
  const tokens = adjudication?.adjudicationReference?.split(/[;|]/).map(value => value.trim()) ?? [];
  const references = new Set(tokens);
  if (adjudication) assert(tokens.length === 2 && references.size === 2 && tokens.every(id => originalRows.some(row => row.labelId === id)),
    `Confirmed adjudication for ${rows[0]?.clipId}/${event} must reference exactly two existing original label IDs from this clip/event.`);
  const originals = reviewers.filter(row => references.has(row.labelId));
  const differentPeople = new Set(originals.map(row => row["labelReview.reviewerId"])).size >= 2;
  if (adjudication && originals.length === 2) {
    assert(originals.every(row => Date.parse(row["labelReview.reviewedAt"]) <= Date.parse(adjudication["labelReview.reviewedAt"])),
      `Adjudication for ${rows[0]?.clipId}/${event} predates an original review.`);
    const bracketed = originals.every(row => finite(row.lastBeforeRawTime) && finite(row.firstAfterRawTime));
    const bracketsDisjoint = bracketed && (originals[0].firstAfterRawTime < originals[1].lastBeforeRawTime ||
      originals[1].firstAfterRawTime < originals[0].lastBeforeRawTime);
    assert(!bracketsDisjoint || nonempty(adjudication.notes),
      `Adjudication for ${rows[0]?.clipId}/${event} requires a documented resolution of nonoverlapping observation brackets.`);
  }
  const comparable = reviewers.length === 2 && reviewers[0].evidenceSource === reviewers[1].evidenceSource;
  const agreement = comparable ? Math.abs(reviewers[0]["labelReview.rawTime"] - reviewers[1]["labelReview.rawTime"]) : null;
  const definitionMatches = originals.every(row => row.evidenceSource === adjudication?.evidenceSource);
  // A documented resolution can change the event definition, but never silently.
  const resolved = definitionMatches || nonempty(adjudication?.notes);
  return {
    time: adjudication && originals.length === 2 && differentPeople && resolved ? adjudication["labelReview.rawTime"] : null,
    evidenceSource: adjudication?.evidenceSource,
    agreement,
    definitionDisagreement: reviewers.length === 2 && !comparable,
    statuses: Object.fromEntries(["confirmed", "disputed", "unobservable", "pending"].map(status => [status, eventRows.filter(row => row["labelReview.status"] === status).length])),
  };
}

export function evaluateValidationStudy(study, labels) {
  assert(Array.isArray(labels), "Labels must be parsed worksheet rows.");
  assert(study?.version === 1 && nonempty(study.studyId), "Study version 1 and a studyId are required.");
  const protocol = study.protocol;
  assert(protocol && ["captureSessionId", "climberAlias"].includes(protocol.splitUnit), "Freeze a whole-session or whole-climber split.");
  assert(/^[a-f0-9]{7,40}$/i.test(protocol.appCommit) && date(protocol.frozenAt), "Record the frozen app commit and protocol date.");
  assert(finite(protocol.endpointToleranceSeconds) && protocol.endpointToleranceSeconds > 0, "Predeclare a positive endpoint tolerance.");
  assert(Array.isArray(study.clips) && Array.isArray(study.predictions) && Array.isArray(study.observations), "Study clips, predictions, and observations must be arrays.");
  const clips = new Map(), runs = new Map(), labelIds = new Set(), groups = new Map(), attempts = new Set(), reviewerRows = new Set(), originalHashes = new Set();
  for (const clip of study.clips) {
    assert(nonempty(clip.clipId) && !clips.has(clip.clipId), "Duplicate or missing clip ID.");
    assert(nonempty(clip.attemptId) && hash(clip.sourceSha256) && finite(clip.durationSeconds) && clip.durationSeconds > 0, `Invalid recording identity for ${clip.clipId}.`);
    assert(["development", "held-out"].includes(clip.datasetSplit) && ["fixed-phone", "rejection"].includes(clip.cohort), `Invalid split or cohort for ${clip.clipId}. Synthetic examples belong outside the field study.`);
    for (const field of ["captureSessionId", "climberAlias", "gymAlias", "capturePhoneModel", "lane"]) assert(nonempty(clip[field]), `Missing ${field} for ${clip.clipId}.`);
    assert(clip.consentConfirmed === true, `Recording permission is not confirmed for ${clip.clipId}.`);
    assert(nonempty(clip.primaryRunId), `Predeclare the primary run ID for ${clip.clipId}; do not choose the best rerun.`);
    for (const field of new Set(["captureSessionId", protocol.splitUnit])) {
      const key = `${field}:${clip[field]}`;
      assert(!groups.has(key) || groups.get(key) === clip.datasetSplit, `Split leakage in ${key}.`); groups.set(key, clip.datasetSplit);
    }
    if (!clip.parentClipId) {
      assert(!attempts.has(clip.attemptId) && !originalHashes.has(canonicalHash(clip.sourceSha256)), `Repeated independent attempt/file ${clip.attemptId}; identify derivatives with parentClipId.`);
      attempts.add(clip.attemptId); originalHashes.add(canonicalHash(clip.sourceSha256));
    }
    clips.set(clip.clipId, clip);
  }
  for (const clip of study.clips.filter(clip => clip.parentClipId)) {
    const parent = clips.get(clip.parentClipId);
    assert(parent && !parent.parentClipId && parent.attemptId === clip.attemptId && parent.datasetSplit === clip.datasetSplit, `Invalid parent or split for derivative ${clip.clipId}.`);
  }
  for (const run of study.predictions) {
    const clip = clips.get(run.clipId);
    assert(nonempty(run.runId) && !runs.has(run.runId) && clip, "Duplicate run ID or unknown prediction clip.");
    assert(canonicalHash(run.sourceSha256) === canonicalHash(clip.sourceSha256) && run.appCommit === protocol.appCommit, `Run ${run.runId} does not match the original hash or locked build.`);
    assert(date(run.startedAt) && Date.parse(run.startedAt) >= Date.parse(protocol.frozenAt), `Run ${run.runId} predates the frozen protocol.`);
    assert(run.events && typeof run.events === "object", `Missing immutable automatic predictions for ${run.runId}.`);
    for (const event of EVENTS) {
      const prediction = run.events[event];
      assert(prediction && ["accepted", "review", "missing", "failed"].includes(prediction.status), `Missing status for ${run.runId}/${event}.`);
      assert(prediction.status !== "accepted" || finite(prediction.rawTime) && prediction.rawTime <= clip.durationSeconds, `Invalid accepted time for ${run.runId}/${event}.`);
    }
    runs.set(run.runId, run);
  }
  for (const row of labels) {
    const clip = clips.get(row.clipId);
    assert(nonempty(row.labelId) && !labelIds.has(row.labelId), "Every original label and adjudication needs a unique labelId."); labelIds.add(row.labelId);
    assert(clip && row.studyId === study.studyId && canonicalHash(row.sourceSha256) === canonicalHash(clip.sourceSha256), `Label ${row.labelId} does not match the study/recording hash.`);
    assert([...EVENTS, "firstMovement", "padRelease", "officialTotal"].includes(row.event), `Unknown label event ${row.event}.`);
    assert(["reviewer", "adjudicator"].includes(row.reviewRole) && ["pending", "confirmed", "disputed", "unobservable"].includes(row["labelReview.status"]), `Invalid role/status for label ${row.labelId}.`);
    if (row.reviewRole === "reviewer") {
      const key = JSON.stringify([row.clipId, row.event, row["labelReview.reviewerId"]]);
      assert(!reviewerRows.has(key), `Multiple original rows by the same reviewer for ${row.clipId}/${row.event}. Keep revisions outside the scoring worksheet.`); reviewerRows.add(key);
    }
    if (finite(row["labelReview.rawTime"])) assert(row["labelReview.rawTime"] <= clip.durationSeconds, `Label ${row.labelId} is outside the recording.`);
    if (finite(row.lastBeforeRawTime) && finite(row.firstAfterRawTime)) assert(row.lastBeforeRawTime <= row.firstAfterRawTime && row.firstAfterRawTime <= clip.durationSeconds &&
      (!finite(row["labelReview.rawTime"]) || row["labelReview.rawTime"] >= row.lastBeforeRawTime && row["labelReview.rawTime"] <= row.firstAfterRawTime), `Invalid observation bracket for label ${row.labelId}.`);
  }
  for (const clip of study.clips) assert(!runs.has(clip.primaryRunId) || runs.get(clip.primaryRunId).clipId === clip.clipId, `Primary run belongs to another clip: ${clip.clipId}.`);
  const referencesByClip = new Map(study.clips.map(clip => [clip.clipId,
    Object.fromEntries(EVENTS.map(event => [event, referenceFor(labels.filter(row => row.clipId === clip.clipId), event)]))]));
  const originals = study.clips.filter(clip => !clip.parentClipId);
  const heldOut = originals.filter(clip => clip.datasetSplit === "held-out" && clip.cohort === "fixed-phone");
  const output = {};
  for (const event of EVENTS) {
    const errors = [], agreements = [], statuses = { confirmed: 0, disputed: 0, unobservable: 0, pending: 0 };
    let accepted = 0, verified = 0, falseAcceptances = 0, confirmedReferences = 0, needsReview = 0, missing = 0, failed = 0, notRun = 0, definitionDisagreements = 0, mismatchedDefinitions = 0;
    for (const clip of heldOut) {
      const run = runs.get(clip.primaryRunId);
      assert(!run || run.clipId === clip.clipId, `Primary run belongs to another clip: ${clip.clipId}.`);
      const prediction = run?.events[event];
      const reference = referencesByClip.get(clip.clipId)[event];
      for (const status of Object.keys(statuses)) statuses[status] += reference.statuses[status];
      if (reference.time !== null) confirmedReferences++;
      if (reference.agreement !== null) agreements.push(reference.agreement);
      if (reference.definitionDisagreement) definitionDisagreements++;
      if (!prediction) notRun++;
      else if (prediction.status === "review") needsReview++;
      else if (prediction.status === "missing") missing++;
      else if (prediction.status === "failed") failed++;
      else {
        accepted++;
        if (reference.time !== null && nonempty(prediction.evidenceSource) && prediction.evidenceSource === reference.evidenceSource) {
          const error = prediction.rawTime - reference.time; errors.push(error); verified++;
          if (Math.abs(error) > protocol.endpointToleranceSeconds + 1e-9) falseAcceptances++;
        } else if (reference.time !== null) mismatchedDefinitions++;
      }
    }
    output[event] = { confirmedReferences, labelRowsByStatus: statuses, automaticCoverage: proportion(accepted, heldOut.length),
      verifiedAutomaticError: errorSummary(errors), falseAcceptances: proportion(falseAcceptances, verified),
      automaticallyAcceptedWithoutComparableReference: accepted - verified, mismatchedDefinitions,
      needsReview, missing, failed, notRun,
      preAdjudicationAgreement: { comparablePairs: agreements.length, medianAbsoluteDifferenceSeconds: median(agreements), p95AbsoluteDifferenceSeconds: quantile(agreements, .95), definitionDisagreements } };
  }
  const firstUse = new Map();
  for (const observation of study.observations) {
    assert(nonempty(observation.participantAlias) && nonempty(observation.captureSessionId), "Workflow observations require participant and session aliases.");
    assert(["first-use", "follow-up"].includes(observation.taskRole) && date(observation.observedAt), "Workflow observations require taskRole (first-use/follow-up) and an observedAt date.");
    assert(observation.correctionSeconds == null || finite(observation.correctionSeconds), "Correction seconds must be measured, nonnegative, or null.");
    for (const field of ["completedImportReviewSave", "assistanceRequired", "voluntaryReturn"]) assert(observation[field] == null || typeof observation[field] === "boolean", `Observation ${field} must be true, false, or null.`);
    if (observation.taskRole === "first-use") {
      assert(!firstUse.has(observation.participantAlias), "Only one first-use observation is allowed per participant.");
      assert(observation.voluntaryReturn == null, "A first-use session cannot establish a voluntary return.");
      firstUse.set(observation.participantAlias, observation);
    }
  }
  for (const observation of study.observations.filter(row => row.taskRole === "follow-up")) {
    const baseline = firstUse.get(observation.participantAlias);
    assert(baseline && baseline.captureSessionId !== observation.captureSessionId && Date.parse(observation.observedAt) > Date.parse(baseline.observedAt),
      "Follow-up observations require this participant's first-use record and a distinct, later training session.");
  }
  const corrections = study.observations.map(row => row.correctionSeconds).filter(finite);
  const participants = new Set(study.observations.map(row => row.participantAlias));
  const returned = new Set(study.observations.filter(row => row.voluntaryReturn === true).map(row => row.participantAlias));
  const returnObserved = new Set(study.observations.filter(row => typeof row.voluntaryReturn === "boolean").map(row => row.participantAlias));
  const completionObserved = [...firstUse.values()].filter(row => typeof row.completedImportReviewSave === "boolean" && typeof row.assistanceRequired === "boolean");
  const phones = new Set(originals.map(row => row.capturePhoneModel)), gyms = new Set(originals.map(row => row.gymAlias));
  const enoughEndpoints = output.start.confirmedReferences >= 20 && output.finish.confirmedReferences >= 20;
  return {
    studyId: study.studyId, appCommit: protocol.appCommit, endpointToleranceSeconds: protocol.endpointToleranceSeconds,
    status: originals.length === 0 ? "awaiting-data" : enoughEndpoints ? "report-available" : "insufficient-evidence",
    counts: { independentAttempts: originals.length, heldOutSupportedAttempts: heldOut.length, developmentAttempts: originals.filter(clip => clip.datasetSplit === "development").length,
      derivativesExcluded: study.clips.length - originals.length, climbers: new Set(originals.map(row => row.climberAlias)).size, sessions: new Set(originals.map(row => row.captureSessionId)).size, phones: phones.size, gyms: gyms.size,
      byCondition: originals.map(clip => ({ clipId: clip.clipId, split: clip.datasetSplit, cohort: clip.cohort, phone: clip.capturePhoneModel, gym: clip.gymAlias, lane: clip.lane })) },
    endpoints: output,
    rejectionCohort: { attempts: originals.filter(clip => clip.datasetSplit === "held-out" && clip.cohort === "rejection").length,
      acceptedEndpoints: originals.filter(clip => clip.datasetSplit === "held-out" && clip.cohort === "rejection").reduce((n, clip) => n + EVENTS.filter(event => runs.get(clip.primaryRunId)?.events[event]?.status === "accepted").length, 0) },
    workflow: { participants: participants.size, observations: study.observations.length, correctionSeconds: { measured: corrections.length, unmeasured: study.observations.length - corrections.length, median: median(corrections), p95: quantile(corrections, .95) },
      unassistedCompletion: proportion(completionObserved.filter(row => row.completedImportReviewSave && !row.assistanceRequired).length, completionObserved.length),
      unassistedCompletionLowerBound: proportion(completionObserved.filter(row => row.completedImportReviewSave && !row.assistanceRequired).length, participants.size),
      completionOutcomeUnmeasuredParticipants: participants.size - completionObserved.length,
      voluntaryReturn: proportion(returned.size, returnObserved.size), followUpNotObservedParticipants: participants.size - returnObserved.size,
      trainingDecisionsRecorded: study.observations.filter(row => nonempty(row.trainingDecision)).length },
    readiness: { targetAttemptCountMet: originals.length >= 30, atLeastThreePhones: phones.size >= 3, atLeastTwoGyms: gyms.size >= 2,
      endpointAutomaticCoverageTargetMet: output.start.automaticCoverage.fraction !== null && output.start.automaticCoverage.fraction >= .5 && output.finish.automaticCoverage.fraction >= .5,
      allAutomaticEndpointsVerified: output.start.automaticallyAcceptedWithoutComparableReference === 0 && output.finish.automaticallyAcceptedWithoutComparableReference === 0,
      preliminaryEndpointLabelCountMet: enoughEndpoints, zeroKnownHeldOutEndpointFalseAcceptances: enoughEndpoints ? output.start.falseAcceptances.numerator === 0 && output.finish.falseAcceptances.numerator === 0 : null },
    limitations: ["Independence and blinding are reviewer declarations, not something this script can prove.", "Wilson intervals describe individual attempts and do not adjust for clustering by climber, session, or gym.", "Unverified automatic acceptances are not counted as correct. Error describes verified automatic acceptances only; coverage includes every eligible held-out original, including missing runs.", "Predeclare primary run IDs; repeated runs and transformed copies do not add independent attempts.", "Authored synthetic references and historical detector cursors are not independent field-study labels.", "This report does not establish native iPhone readiness or replace observing real climbers."] };
}
