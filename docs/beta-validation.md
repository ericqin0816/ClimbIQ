# First iPhone beta: evaluation plan

**Status: proposed study, no new observations collected.** This document and the empty [label worksheet](../benchmarks/beta-label-template.csv) are preparation. They do not establish timing accuracy, device performance, or user demand. The existing [benchmark](../REAL_VIDEO_BENCHMARK.md) explicitly distinguishes regression observations from independent labels.

## People, recordings, and schedule

Recruit 10–20 speed climbers and two coaches for three training sessions over roughly two weeks. Give each tester an alias such as `tester-001`; keep contact details and the mapping to real names outside this repository. Ask permission to use each person's recordings for the evaluation, and agree who may view them. Store original videos privately, outside Git.

Collect 30–50 different, unedited attempts from at least three recording phones, two gyms if available, both lanes, several climbers, and different camera distances, angles, and lighting. Include MOV/HEVC and MP4 recordings, normal and slow-motion capture, audible and obscured start cues, partial occlusions, and distant finishes. Record missing combinations; do not claim coverage of a condition you did not test. Keep a fixed-phone cohort separate from broadcasts, pans, cropped walls, and deliberately corrupted files used for rejection tests.

1. **Preparation:** freeze an app commit/build, define the label rules below, choose the baseline iPhones, and assign clip/reviewer aliases. Record each original's SHA-256. A resized, trimmed, or recompressed copy retains a parent clip ID and counts as the same climb, not another independent sample.
2. **Session 1:** let each tester import, analyze, review, save, and compare an attempt without coaching them through the interface. Record where help was required and whether they understood which results needed review. Collect recordings for annotation.
3. **Independent review:** two people annotate every event separately before seeing detector predictions, app cursors, or each other's labels. Ideally neither reviewer wrote the detector. Preserve their original worksheets before discussing disagreements.
4. **Sessions 2–3:** observe whether testers choose to use the app again, test persistence/sharing and interruptions, and ask what decision they made from the comparison. Record actual repeat use separately from stated enthusiasm.
5. **Decision:** run the locked build against independently labeled clips, inspect false acceptances and device failures, and compare the results with the proposed gates below. If the detector is tuned on a recording, mark it development data and obtain new held-out clips for the next evaluation.

Assign whole recording sessions or climbers to development versus held-out groups before annotation; do not split alternate exports of the same climb across groups. A practical starting split is about one third development and two thirds held out. Report the actual counts and the clustering by climber/gym. A small recruited sample is an early usability study, not a population estimate.

## Label events and keep their sources separate

Use the original video's presentation timestamps in seconds from its beginning. For variable-frame-rate or slow-motion recordings, use decoded source timestamps and record playback/timebase handling; `frame number / advertised fps` is not automatically a correct clock. Record a source frame index when available plus the last frame before and first frame showing the event. Those brackets describe observation resolution, not a proven timing-error bound.

| Worksheet event | What reviewers establish | Keep separate |
| --- | --- | --- |
| `start` | The race start signal: identify its audio onset or lane-specific light transition and record the evidence source. If audio and video disagree, retain both observations and document any measured synchronization offset. | First athlete movement or pad release is not the start signal. Do not infer a start from the app's predicted total. |
| `firstMovement` | First visible purposeful movement of the selected climber, with a stated body-region rule. If visible, annotate first pad release separately as `padRelease`. | Pixel motion and visible pad release do not establish an official electronic reaction time. |
| `hold10` | First visible hand contact with positively identified Hold 10. Record the hold-identification evidence and relevant hand. | A COM halfway crossing, hand height, nearby hold, or pose landmark is not proof of contact. Mark occluded or uncertain contact unobservable/disputed. |
| `finish` | A lane-specific finish timing cue or visible finish-pad contact; explicitly name which physical event was observable. | Pad contact, light response, and timing-display stop can have different delays. Do not mix those event definitions in one accuracy statistic without separately established alignment. |
| `officialTotal` | A time from a lane/attempt-matched official timing display or published result, with a source reference. | Put elapsed time in `officialTotalSeconds`, leaving `labelReview.rawTime` blank. A user-reported total is its own reference class, not an official result. |

An official total can check elapsed time. It cannot independently label both video endpoints. Do not create a finish label by adding the official total to a predicted start, or a start label by subtracting it from a predicted finish. Report total-time disagreement separately from Start and Finish error. A close total can conceal two similarly shifted endpoints.

## Use the worksheet and existing provenance schema

The CSV is intentionally **header only**. Add one row per clip, event, and reviewer. Use pseudonymous IDs (`clip-001`, `reviewer-01`) and no names or private file paths. `reviewRole` is `reviewer` or `adjudicator`. Keep blanks for missing values; never enter zero to mean unknown. Enter literal `true`/`false` for booleans, decimal seconds for numeric fields, and ISO 8601 dates. Record `status` as `pending`, `unobservable`, `disputed`, or `confirmed`; only confirm when the evidence supports the defined event.

The fields prefixed `labelReview.` map to the nested object expected by [scripts/lib/label-provenance.mjs](../scripts/lib/label-provenance.mjs). Its minimum qualifying fields are:

- `status = confirmed` and `independentOfDetector = true`;
- a non-empty `reviewerId` and description of the annotation `method`;
- a parseable `reviewedAt` date;
- a finite, nonnegative `rawTime` on the original recording's timebase.

That minimum validator does not enforce two-reviewer agreement or prove a label correct. This study adds those requirements. Keep both blinded rows, compare their event definitions and frame brackets, then create a separate adjudication row referencing the two originals. If they disagree by a source frame or more, disagree on the cue/hold, or have nonoverlapping brackets, inspect the original together. Record the resolution and its evidence. Do not average ambiguous event times into a seemingly precise confirmed label. Leave unresolved cases disputed or unobservable and report their counts.

After adjudication, attach the confirmed label to the corresponding `start.labelReview`, `finish.labelReview`, or `hold10.labelReview` in an evaluation result. The detector's `rawTime`, `status`, `source`, and confidence remain separate from `labelReview`; do not overwrite predictions with reference labels. Preserve reviewer rows and adjudication references in the private study records. Match `sourceSha256` before comparing outputs, so a label cannot silently move to an edited copy.

The CSV is a collection worksheet, **not an importer**. The existing `npm run benchmark:summary` reads the checked-in `benchmarks/real-video-results.json`, not this CSV, and currently scores Start/Finish using a 0.100 s policy. It does not score Hold 10 agreement, ingest this proposed cohort, or calculate device latency. Convert and review any future dataset deliberately; do not replace the historical regression records with unreviewed worksheet rows. The browser timing runner can replay private clips using the setup in [CONTRIBUTING.md](../CONTRIBUTING.md#testing-with-recordings), but native device runs need their own records.

## Record each device run

Keep a run log keyed by `runId`, `clipId`, `sourceSha256`, app commit/version/build, device model, iOS version, and analysis settings. Test a recent iPhone and an older supported one. Distinguish first launch/cold model load from repeated runs. For comparable timings, use the same original clip and settings.

| Run-log field | How to record it |
| --- | --- |
| Import and analysis latency | Seconds from selecting the file to usable preview, then from Run full analysis to results or a useful review/error state. Record missing iCloud downloads separately. |
| Memory | Peak process memory in MB from Xcode Instruments or another stated device measurement. Leave unmeasured values blank; a responsive screen is not a memory measurement. |
| Heat and battery | Device thermal state when instrumented, user-reported warmth separately, battery percentage before/after, duration, and whether plugged in. Do not call touch impressions a measured temperature. |
| Interruption | Event type and analysis stage: cancel, screen lock, switch app, incoming interruption, or force-close. Record elapsed time, recovery behavior, partial/stale output, and whether another video can be loaded. |
| Persistence | Save/rename/duplicate/delete outcome, library count before/after reopening, exported backup ID, and result of an app update without uninstalling. Record a reported save error separately from a successful save. |
| Sharing | Export type, Share / Save to Files / cancellation, readable file result, successful reimport, and duplicate handling. Avoid recording recipients' personal details. |
| Usability | Task completion, assistance needed, time spent correcting markers, result interpretation, and whether the tester voluntarily returned next session. |

Run 20 save/reopen/export/reimport cycles across the baseline devices, including a multi-attempt library. Include low-storage or injected write failure where feasible: an unsuccessful save must not erase the previous library or display success. The web library uses IndexedDB; the native library uses private Filesystem snapshots with staging and readback. Exported summaries do not contain original videos. Keep their backups separately.

Test cancellation and switching apps during both timing and pose stages; confirm the next run belongs to the current video and no interrupted result is presented as complete. Start once in airplane mode after installing the bundled app and run pose analysis to check packaged model/WASM loading. Test invalid media and denied/cancelled picker access. Use the fuller [iPhone handoff checklist](ios-beta.md#real-iphone-verification-before-inviting-testers) for platform coverage.

## Report coverage and correctness separately

Report clip counts, confirmed/disputed/unobservable labels, automatic acceptance, review requests, missing events, and failures by device and recording condition. For confirmed labels with matching event definitions, report absolute and signed error, median and 95th percentile, and the exact denominator for each event. Show Start, Hold 10, Finish, and official-total comparisons separately. Measure Hold 10 reviewer agreement before adjudication, including hold identity disagreements.

Count every automatically accepted endpoint outside the predeclared tolerance as a false acceptance. Do not remove those clips from the denominator after seeing the result. An automatically accepted event without a qualifying label stays unverified. Zero labeled false acceptances on a small set is not proof of zero error. Provide sample counts and an uncertainty interval where applicable, and disclose the limited number of independent climbers/gyms. Review and abstention rates must remain visible so rejecting everything cannot look accurate.

## Proposed gates for expanding the beta

These are **initial team targets, not measured results or accuracy promises**. Agree on them before the held-out runs; document any later change instead of moving the threshold silently.

| Area | Proposed gate |
| --- | --- |
| Data readiness | Collect 30–50 unique attempts with two independent reviews per observable event. Retain at least 20 confirmed held-out Start and Finish labels each before making even a preliminary numerical endpoint claim; otherwise report insufficient evidence. Hold 10 claims require their own confirmed denominator. |
| Timing safety | No known false automatic Start/Finish acceptances on the held-out set at the existing 0.100 s comparison policy; all failures investigated before expansion. Report automatic coverage alongside this gate, with an initial usability target of at least 50% for each endpoint on supported fixed-phone clips. This threshold is a study decision, not an established event-error bound. |
| Hold 10 | Every displayed contact split has an explicitly accepted, correctly identified contact marker. No height-only estimate or disputed hold identity is silently promoted. Report accuracy and review burden only where independent contact labels exist. |
| Workflow reliability | No crash, wrong-video result, silent lost saved attempt, or false save-success message in the scripted baseline-device runs. All 20 persistence/share cycles succeed, including reopen and a backup restore; cancelled share is a valid non-error outcome. |
| Responsiveness | Visible analysis-start feedback within 1 s and cancellation acknowledged within 2 s while foregrounded. For local clips up to 30 s at 1080p, initial target: 95th-percentile full-analysis latency at most 120 s on the named baseline phone. Publish actual per-device measurements and review the target with testers. |
| Resource use | No OS memory termination or observed serious/critical thermal state during the repeated-run protocol. Report peak memory and heat measurements; missing instrumentation is unmeasured, not a pass. Investigate sustained slowdown even when there is no crash. |
| User value | At least 80% of observed participants complete import → review → save without live help after onboarding, and at least 60% voluntarily use the app at a later training session. Always publish the participant counts; these are exploratory retention/usability targets. |

If a gate fails, keep the beta small, describe the unsupported conditions, fix the failure, and rerun the affected checks on fresh held-out examples where accuracy is concerned. Do not expand into general climbing to compensate for an unresolved speed-climbing workflow.
