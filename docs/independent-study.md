# Collect and report the independent beta study

Status: prepared protocol and reporting tools; **no new participant recordings,
independent labels, correction times, training decisions, or return visits have
been collected by this implementation**. The practice animations and unit-test
rows are synthetic workflow fixtures. They must never enter the field study.

Use the recruiting, blinding, event definitions, and device protocol in
[beta-validation.md](beta-validation.md). Collect 30–50 distinct attempts across
at least three phones, several climbers, both lanes, and two gyms when possible.
Keep the original recordings, consent records, reviewer identity mapping, and
study files privately outside Git. `.local-npm/studies/` is ignored for local use.

1. Freeze an app commit and protocol date before detector runs. Predeclare the
   endpoint tolerance (initial policy: 0.100 s) and one primary run ID per clip.
2. Assign entire climbers or recording sessions to development or held-out data.
   Every version of an attempt stays in the same split. With a climber split,
   all recordings by that climber stay together as well. Never tune on held-out
   data and continue calling it held out.
3. Give two reviewers clean original recordings and separate copies of the
   [label worksheet](../benchmarks/beta-label-template.csv). Hide predictions,
   app cursors, and the other reviewer's labels. Preserve both original sheets.
4. Give each row a unique `labelId`, for example `clip-001-start-reviewer-01`.
   Both reviewers declare independence and record the physical event definition
   in `evidenceSource`. Use consistent values, such as `lane-start-light`,
   `lane-finish-light`, `finish-pad-contact`, and `hold10-hand-contact`.
   A pad contact and a finish-light response are different definitions.
5. Resolve disagreements using the original recording. Add a separate confirmed
   adjudicator row with `adjudicationReference` containing exactly two original
   label IDs separated by `;`. Record a resolution in `notes` if the reviewers
   used different event definitions. Do not average ambiguous times. Unresolved
   events remain disputed or unobservable; the report counts them.
   The adjudication date cannot predate either qualifying original review.
   When both reviewers supplied observation brackets and those brackets do not
   overlap, a confirmed adjudication also requires a documented resolution.
   An unobservable original remains unqualified; an adjudication cannot turn it
   into a two-reviewer timing reference.
6. Replay the locked build, preserve its **original automatic** endpoint statuses
   and predictions, then observe import → review → save → compare. Record actual
   correction seconds, assistance, the participant's training decision, and
   voluntary use at the next session. A correction must not overwrite the
   prediction being evaluated. Unmeasured values are `null`, never zero.

Copy [study-template.json](../benchmarks/study-template.json) into your private
study directory. Replace both protocol placeholders. Populate its arrays with
the following shapes. These are schema examples, not collected results:

```json
{
  "clipId": "clip-001",
  "attemptId": "attempt-001",
  "parentClipId": null,
  "sourceSha256": "64 lowercase hexadecimal characters from the original",
  "durationSeconds": 24.0,
  "datasetSplit": "held-out",
  "cohort": "fixed-phone",
  "captureSessionId": "session-001",
  "climberAlias": "climber-001",
  "gymAlias": "gym-001",
  "capturePhoneModel": "record the actual model",
  "lane": "left",
  "consentConfirmed": true,
  "primaryRunId": "run-001"
}
```

An original has no `parentClipId`. Recompressed/trimmed copies use the original's
clip ID as parent and retain its attempt ID and split. They are reported as
derivatives, never extra independent climbs. Broadcasts and unsupported
conditions use `cohort: "rejection"` and are reported outside supported-phone
accuracy and coverage. Add condition details to private records; report actual
coverage rather than extrapolating to missing combinations.

Each `predictions` entry has `runId`, `clipId`, `sourceSha256`, `appCommit`,
`startedAt` (ISO date), and `events` with `start`, `hold10`, and `finish`. Each
event has `status` (`accepted`, `review`, `missing`, or `failed`), `rawTime`
(seconds, or `null` when absent), and `evidenceSource`. `accepted` means the
unmodified automatic acceptance, not a marker accepted after human correction.
The physical event must match the adjudicated definition before its error is
scored. Missing runs remain in the coverage denominator. Reruns cannot replace
the predeclared primary run after viewing their errors.

The app and its emitted `build-info.json` expose the package version, full Git
commit, and a source-modified flag. Freeze a clean commit for the study: modified
or unknown source identity cannot establish a reproducible locked build. Dataset
and library exports carry `exportBuild`, the current exporter. A saved session's
optional `analysisBuild` records the build that last accepted a detector Start;
it is preserved on import and may accompany later manual marker edits. It does
not claim that every saved value was produced by that build. Legacy imports and
authored practice references leave analysis provenance unknown. Retain the
original run log and unmodified predictions; do not substitute an exporter's
identity for the build that produced an older analysis. The reporting command
checks the IDs declared in the manifest; it cannot attest which executable ran.

Each `observations` entry has `participantAlias`, `captureSessionId`, `taskRole`
(`first-use` or `follow-up`), `observedAt` (ISO date),
`correctionSeconds`, `completedImportReviewSave`, `assistanceRequired`,
`trainingDecision`, and `voluntaryReturn`. Use booleans or `null` for unknown
outcomes. Correction seconds include only time actually measured. Record return
observations at a later session; enthusiasm or intent is not a return visit.
Each participant has exactly one first-use record. A follow-up requires that
record, a different session ID, and a later date. Leave `voluntaryReturn` null
on first use. Initial unassisted completion counts each participant once and
uses only measured first-use task outcomes; repeated successful tasks cannot
inflate it. Unknown first-use outcomes remain visible as unmeasured. A separate,
explicitly named lower bound includes all enrolled participants. Return
rates use participants with an observed follow-up outcome and separately show
those with no follow-up observation.

Run:

```sh
npm run study:evaluate -- --study .local-npm/studies/study.json --labels .local-npm/studies/labels.csv --output .local-npm/studies/report.json
```

The command rejects split leakage, duplicate attempts/runs/labels, mismatched
recording hashes or builds, unconfirmed recording permission, malformed CSV,
impossible accepted times, and ambiguous adjudication records. Header-only
worksheets remain empty. A prepared empty study reports `awaiting-data`; fewer
than 20 qualifying held-out Start and Finish references reports
`insufficient-evidence`. Neither status is a passing accuracy result.

The JSON keeps separate fields for:

- signed and absolute endpoint error, with median, p95, and exact verified
  automatic-acceptance counts;
- false acceptances beyond the frozen tolerance, with verified-acceptance
  denominator and a Wilson interval;
- automatic coverage over **all supported held-out originals**, including
  missing runs, plus review, missing, failed, and unverified accepted events;
- two-reviewer disagreement before adjudication and label-status counts;
- correction time, unassisted completion, decisions recorded, and participant
  return counts, with unknown measurements kept outside those denominators;
- distinct attempts, derivatives, sessions, climbers, phones, gyms, and lanes.

Wilson intervals do not account for clustering. Report that limitation with
these small samples. Error on accepted events does not measure rejected-event
accuracy. Report total-time agreement with official results separately, using
the existing benchmark provenance tools; this new endpoint report does not
infer either endpoint from a reported total. No numerical claim is justified
until real independent data and actual device measurements exist.
