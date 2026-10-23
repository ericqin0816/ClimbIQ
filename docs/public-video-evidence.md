# Audit public recording observations

This audit keeps public-video observations separate from the recruited
[independent beta study](independent-study.md). Its observers are AI agents.
It cannot establish human correction time, voluntary return, training benefit,
electronic timing accuracy, or a population false-acceptance rate.

Freeze the protocol, comparison tolerance, whole source/climber groups and one
primary run per recording before predictions. Two agents independently inspect
original source frames/audio without predictions or each other's observations.
Preserve both records and their hashes. Missing or ambiguous events stay
unobservable or disputed. Never derive endpoints from a displayed total.

For an observable event, both observers must name the same physical event and
lane, and supply overlapping source-time brackets. The report uses their wider
envelope, never an invented midpoint. A recorded start tone's acoustic arrival,
a lane light response, visible pad contact and an electronic trigger are
different events. An observation bracket is not a calibrated accuracy bound.

Keep downloaded footage, source extraction logs, worksheets and original browser
artifacts outside Git. Public availability alone does not establish permission
to redistribute footage. Derivatives retain the original attempt and source
group; replay angles and reruns do not add independent attempts. Once a source
or athlete group has informed a change, subsequent runs are development data.

Run the real import/analysis/export workflow with `e2e/detector-workflow.mjs`,
using a clean identified build. Preserve its unmodified report. The harness's
`passed` field means capture completed; inspect the detector's terminal status
to distinguish review, missing/not-run endpoints and an analysis failure.

An audit JSON has `schemaVersion: 1`, `observerType: "ai-agents"`, an `auditId`,
ISO `frozenAt`, positive `toleranceSeconds`, and `clips`/`runs` arrays. Each clip
declares `id`, `attemptId`, `sourceGroupId`, `athleteGroupIds`, `sourceSha256`,
`durationSeconds`, stable HTTPS `sourceUrl`, `sourceSpeedStatus` (`normal`,
`slow-motion`, or `unknown`), `clockDefinition`, `cohort` (`fixed-phone`,
`broadcast`, `panning`, or `unknown`), `split` (`development` or `held-out`) and
`primaryRunId`. A derivative also declares `parentClipId`. Held-out clips must
declare `previouslyExposedToPredictions: false`; the tool validates declarations
and supplied records, rather than attesting that blinding actually occurred.
Preserve file derivation separately with `derivation.kind` (`full-source-acquisition`,
`trim`, or `unknown`) and `description`. A trim requires `parentSha256` and
`requestedParentRangeSeconds`; retain whether speed/frame-rate conversion was
requested in its description. An attempt may be represented by a trimmed file
without turning that file into a new climb. `originals` counts distinct attempt
representatives; `derivatives` counts additional versions whose `parentClipId`
points to a representative in this audit. These are not original-file counts.

`references.start` and `references.finish` each contain `status` (`observable`,
`unobservable`, or `disputed`), `reason`, ISO `frozenAt`, and exactly two `reviews`.
Each original review contains `reviewerId`, `reviewedAt`, `method`,
`sourceSha256`, `independentOfPredictions: true`, and its own `status`.
Observable reviews additionally contain `bracket: [lastBefore, firstAfter]`,
`eventDefinition`, and `laneId`. Use `global` only for a genuinely global cue.
An unobservable or disputed original cannot qualify an observable reference.
References must precede every supplied prediction in their connected source
and athlete group, including derivatives and nonprimary runs.

Each run contains `id`, `clipId`, `sourceSha256`, ISO `startedAt`, the exact
`build` and `browser` from the original workflow report, `automaticSnapshot:
true`, `artifactFile` (relative to the audit JSON), its SHA-256 as
`evidenceFileSha256`, and zero-based `outcomeIndex`. Its `events.start` and
`events.finish` declare original `status` (`automatic`, `review`, `missing`, or
`failed`), `rawTime` (seconds or null), and the inspected `eventDefinition` and
`laneId` if known. Unknown scope remains unknown. The CLI verifies automatic
acceptances and timestamps against the hashed artifact; edited or reviewed
markers cannot substitute for original automatic predictions.
`review`, `missing` and `failed` remain operator classifications of the workflow;
the artifact adapter verifies automatic times and the absence of an accepted
automatic endpoint, rather than attesting those nonautomatic classifications.

```sh
node scripts/evaluate-public-video-evidence.mjs --study private/audit.json --output private/new-report.json
```

Output creation is exclusive and refuses existing filenames, including aliases
of inputs. Missing primary runs remain in denominators. The report separates
cohorts/splits, automatic coverage, review/missing/failed events, unverified
acceptances, source groups and derivatives. Only matching observable events and
lanes receive signed difference intervals and distance from the observation
envelope. Tolerance results distinguish wholly within, certainly outside and
indeterminate. Compatibility with a bracket is not an exact accuracy result.
The report always identifies itself as agent-observed public-video evidence
with `independentHumanStudy: false`.
