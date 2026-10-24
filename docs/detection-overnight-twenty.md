# Overnight detection: twenty checkpoints

User request: twenty detection-focused implementation, testing and independent
review checkpoints, with multiple agents and feedback used in subsequent work.
Started October 23, 2026 (America/Chicago). User clarified this is a nine-hour
sustained work window, not a fifteen-minute run. Work through October 24 at
08:35 America/Chicago (13:35 UTC), then finish or safely checkpoint verification.
Distribute twenty substantive checkpoints across the window, deepen experiments
between checkpoints, and reserve final checkpoint 20 for the end. Automation:
`climbiq-20-detection-checkpoints` (same-chat heartbeat every fifteen minutes;
that is a wake-up cadence, not the work duration; pause after final reporting).

Workspace: the attached `climbiq-training-workflow/ClimbIQ` managed worktree.
Branch: `codex/detection-overnight-twenty`. Baseline: `9d5d8e9`.
The original user checkout and its existing edits must remain untouched.

The machine-readable [ledger](../benchmarks/detection-overnight-twenty.json)
records actual completed checkpoints, exact evidence and honest scoped grades.
An intended experiment is not a completed check. Preserve rejected hypotheses
and missing references. Do not turn successful tests into accuracy scores.

Priorities are guided athlete identity and lane-relative Finish localization,
then unresolved audio onset/rate behavior. Existing acceptance safeguards stay
in place. Start, movement, sensor transition and pad contact remain separate
events. Private/downloaded media and intermediate pixels/PCM remain ignored.
Source-level holdouts require prediction-blind qualification before predictions.

## Checkpoint queue

1. Freeze baseline, source registry, evaluation rules and ownership.
2. Diagnose guided athlete acquisition on native source frames.
3. Challenge athlete identity with bystanders, two lanes and partial bodies.
4. Implement and verify the smallest justified athlete-selection repair.
5. Recheck native athlete/body-audit behavior and retained failure modes.
6. Reproduce Finish search geometry against independently observed source cues.
7. Test lane-relative or explicitly selected Finish-region localization.
8. Diagnose Finish transition onset with original source timestamps.
9. Implement and verify a justified Finish repair without weakening identity.
10. Challenge Finish with camera motion, other lanes, cuts and non-event color changes.
11. Qualify new public source material with blind observations before predictions.
12. Run source-level baseline/candidate comparisons on qualifying new material.
13. Refine or reject proposals using observed cross-source failures.
14. Trace unresolved audio sample-rate/onset disagreement.
15. Test a bounded audio timing repair or record why it is rejected.
16. Run cross-source and authored false-protocol/quiet-onset controls.
17. Run the cumulative native application detection matrix.
18. Obtain independent code, cancellation/stale-result and evidence review.
19. Run required production checks and resolve material regressions.
20. Publish measured results, final independent grades, CI and deployment verification.

Experiments may be refined before observing their results; record amendments
and reasons in the ledger. A checkpoint can conclude that a proposed repair is
unsafe or that a source is unqualifiable. That is not a detection success.

## Progress

Baseline automatic coverage is 4/12 endpoints and 1/6 complete pairs on six
previously exposed phone recordings. The prior public P07 clip also remains
development data. The preceding ten-round report graded code readiness 8.0/10
and generalizable detection evidence 4.7/10; these are subjective rubrics, not
accuracy. A broad accuracy score needs independently referenced new attempts.

Checkpoint 1 registration is underway. Root owns integration, browser scheduling,
this log and delivery. Separate agents own athlete logic, Finish logic, and the
independent ledger. Serialize native browser inference to avoid contaminating
latency or model results. No paid model calls or new runtime dependencies are
authorized merely by this plan.

### Initial active batch — still in progress

The evaluator has independently recorded checkpoints 1–9 and 11; the other
checkpoints remain open. This is not completion of the nine-hour assignment.
The final grade and checkpoint 20 remain reserved until the work-window end.

Two actual athlete/movement defects were repaired locally: an initial singleton
pose could bypass the selected body region, and motion candidates were truncated
to six before semantic selection. The latter dropped 20 later reliable candidates
in the guided development example. Its paired native movement result changes
8.357 Low to 8.757 Medium, and the separate launch audit changes false to true.
The scene audit still rejects automatic Start. Blind posthoc source observations
support inspecting that later movement; they do not turn this into held-out data.

Finish experiments now include an explicit manually selected indicator region,
separate from a physical pad and an automatically discovered Finish zone. The
guided action only navigates review and preserves accepted timing. Two production
Chromium viewport tests pass on the initial V2 compiled artifact. A new original
CC0 codec fixture localizes the selected 7.000-second light and ignores an earlier
other-lane light. Raw footage and experimental model assets remain ignored.

The current V4 Finish proposal uses observable color-state support and a connected
faint-onset check. Its conditional P07 tracked-prefix estimate changes 25.692 to
25.859 seconds, within the frozen matching-light reference. Full native P07 still
fails, including a fixed manually selected region during camera panning. Expanded
authored controls retain three dim-target losses, a pre-existing interrupted-noise
false early result, and a newly reproduced pre-existing yellow-obstruction
counterexample. Do not describe this method as fully brightness-invariant.

The V4 cumulative check passes typecheck, build, coaching smoke and 1,207 unit
tests (five pre-existing expected failures). Four additional async lifecycle tests
then pass, covering pre-cancellation, cancellation during a detector call, source
replacement, retry, and rejection of pad-as-indicator input. These test additions
do not establish new field accuracy.

The first eight-case V4 native matrix has seven completed workflows and one
30-second file-input timeout on phone 9076 before analysis. Its original failure
is retained. An unchanged isolated rerun of 9076 passes. Completed source clocks
match the historical accepted clocks exactly: still 4/12 phone endpoints, one
complete pair, and no P07 endpoints. Never relabel the initial matrix all green.

Two separately frozen blind subagent worksheets qualify visible lamp and apparent
pad-contact brackets on a new research clip, with unknown source speed, event
semantics and session novelty. Default and manually selected left-athlete modes
are preregistered separately. The first baseline guided run failed because the
test driver searched for a button hidden in closed controls; its failure is
retained, and the driver now opens those controls explicitly. No detector rule
was changed for that retry. Baseline/candidate comparisons are underway.

The private evidence directory is `test-results/detection-overnight-twenty/`.
Frozen `v4-build-artifacts-frozen.json` records compiled byte hashes and a complete
source snapshot before native runs; this is a modified experimental build, not
a clean final-commit claim. V2 UI output was recovered without alteration from
the reporter's nested relative directory as `guided-ui-report-v2-recovered.json`.

The completed athlete and Finish implementation agents have handed off frozen
modules. Current agents are `evaluator_twenty`, `source_expansion_twenty` and
`person_detector_twenty`. Source curation is screening newly acquired public
training material before any predictions. Person-first detection is a separate
research-only experiment with official EfficientDet-Lite0 assets kept ignored;
no model, dependency or automatic identity policy has been added to the app.

Root owns the native browser queue until the baseline/candidate research-source
runs finish, then the person-detector agent should receive it. Root-managed Vite
5173 and production preview 5189 were started for the batch; verify availability
on a later wake instead of assuming either survived. Keep the user-facing 5190
context separate. Preserve failed runs and use fresh output filenames for retries.

Next useful work: finish/review those actual comparisons; test the person-first
hypothesis across the frozen six-source image set; obtain event-specific blind
references on genuinely qualifying new training clips; investigate the retained
yellow/noise/dim-target Finish cases and audio sample-rate/onset failures. Deeper
iterations belong within these substantive checkpoints rather than inflating the
checkpoint count. Do not push unreviewed experimental policies just to meet a score.

### Incremental delivery and next batch

The selected-athlete constraint and motion-candidate selection repair are ready
for a focused incremental delivery. Finish-policy and manual-indicator interface
changes remain local experiments while their additional limitations are reviewed.
The nine-hour assignment remains active; this delivery is not checkpoint 20.

The new research clip completed both versions in default and manually selected
left-athlete modes. All four produce an unaccepted Medium audio suggestion at
2.160 seconds; none matches the observed lamp transition. No endpoint was accepted.
The original guided baseline driver failure is retained separately from its retry.
The hosted baseline build was checked before and after those comparisons.

Both person-detector research probes are complete and rejected as a default
replacement. Full-frame person-first has 5/32 wall-centered proposal opportunities;
full plus four fixed detector tiles has 25/32, compared with 24/32 from existing
fixed pose tiles. The scale proposal has six gains and five losses, at about
500.6 ms per frame versus 221.5 ms for fixed pose tiles on this local experiment.
Those are IMAGE-mode diagnostics, not phone VIDEO throughput or athlete identity.
It recovers the problematic four-frame body boxes, but unknown feet in the first
three prevent whole-body qualification. No new model or dependency ships.

Source curation acquired 23 public videos and retained three unavailable leads.
None was certified as a new fixed-camera endpoint timing reference; pan, montage,
cropped cues and source-speed uncertainties are retained. Four native-audio windows
were then prepared without application predictions. One is exact decoded silence;
the others require independent raw-audio observation. Two code-unexposed observer
agents are qualifying them before any new-source audio predictions.

The frozen audio-mechanism plan investigates quantized band peaks versus the
interpolated ordinary spectral estimator and the retained early resampled marker.
No audio runtime edit has been made. Finish's yellow-obstruction counterexample
also remains an explicit next-batch challenge. Root must inspect active agents and
finish their current work on the next heartbeat rather than duplicating it.
