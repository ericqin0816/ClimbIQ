# Start-to-Finish lane evidence handoff

User authorized this follow-up after the completed two-hour pass. The old
continuation automation remains paused; this is a separate implementation task.
Baseline: retained detector 0.28.6, commit 78ed284 (includes final testing log).
Preserve the user's 208 added stylesheet lines and keep media outside Git.

## Reproduced dependency

Audio High confidence currently determines the discovery window, discovery
sampling phase, candidate scoring hint, refinement bounds, motion-search window,
fusion clock and downstream lane ranking. Changing confidence therefore changes
which pixels and frames are examined, not only whether a timestamp is accepted.
The previous confidence experiment lost a Finish, lost a compact-copy Start,
changed another Start by 67 ms, and gained two unverified low-FPS boundaries on
IMG_9076 derivatives.

## Implementation under test

- A protocol-shaped audio candidate has an explicit `searchHintTime`. It can
  guide visual/motion search without supplying an automatic clock vote. The
  detector's existing confidence remains the only audio vote during foundation
  verification; stricter confidence eligibility is a separate subsequent test.
- A dedicated lane association module retains visual cue times, calibration,
  stable patch IDs and eligibility. Association uses a compatible search hint or
  the supporting visual event, not a newly weighted audio-confidence clock.
- Excluded artifacts and unrelated events stay in the diagnostic ledger but
  cannot become Finish candidates. The existing proximity deduplication remains.
- Finish preserves the selected record's visual cue time rather than replacing
  it with the fused clock. No Finish acceptance threshold is relaxed.
- Debug/dataset exports include the current-analysis lane ledger and active
  light ID, explicitly not ground truth. Patch IDs identify regions of the image,
  not independently recognized athlete identities. The ledger is transient
  analysis evidence, not a promise of restoring it from legacy saved sessions.

## Verification gates

1. Foundation: 573 unit tests, typecheck and build pass. Six-source full browser
   replay plus control/compact/low-FPS IMG_9076 replay in progress.
2. Reapply only the stronger audio-confidence checks; keep search guidance and
   lane evidence separate. Check the exact previously failing variants before
   any broad replay or publishing.
3. Verify original sources, eight public rejection-safety cases, cancellation,
   and the complete 36-case transformed-source matrix. Investigate new accepted
   boundaries, lost finishes and timing drift; do not force unverified cursors
   to historical target values.
4. Push only verified changes and confirm the deployed version.

Foundation reports: `test-results/lanes-foundation-six-0.28.8.json` and
`test-results/lanes-foundation-9076-0.28.8.json` (ignored local artifacts).

## Observations so far

- Foundation preserved accepted boundaries on all six originals and all three
  targeted IMG_9076 derivatives. The control copy still found Finish at 14.300 s.
- With stronger preparation-tone eligibility restored, the exact same patch IDs,
  cue times and compatible search hint survive audio High→Medium on the three
  problem derivatives. No new automatic low-FPS start/finish was accepted.
- The control/compact copies instead require Start review: their weak audio no
  longer defines an authoritative clock. This is a loss of automatic availability,
  not a claim that the old or proposed time is independently known correct.
  Finish is not automatically measured until Start is accepted. This differs from
  silently losing lane evidence or promoting a later reset as a new finish.
- All six originals and eight public rejection-safety cases pass full workflows
  with the stronger rule. Original accepted starts and finishes are unchanged;
  IMG_9077's unverified review suggestion is 5.317 s. The Hunt audio candidate
  is Medium instead of High and remains unaccepted by the full application.
- A fresh 36-case matrix is running against the original 0.28.6 source-matched
  baseline. Report: `test-results/video-robustness-2026-09-06T02-35-42-137Z.json`.
- Unit suite: 576 tests pass; typecheck/build pass. Added browser checks for lane
  ledger export, preflight cancellation restoration and source-replacement cleanup.
  An explicit user body lane constrains eligible automatic handoff patches;
  global start-cue fusion and physical lane identity remain separate concepts.

## Finish entry-point hardening

`prepareFinishLaneCandidates` is shared by automatic continuation and the manual
Finish retry. It preserves the observed patch time and falls back to its learned
calibration when no replacement calibration is supplied. An explicitly supplied
empty calibration remains empty. A user-selected body lane filters the primary
patch as well as fallbacks; changing lanes cannot bypass the filter by retaining
an old primary light. The existing three-patch budget and proximity deduplication
are unchanged. Six unit tests cover these contracts; the expanded full suite is
582 tests across 58 files, passing with typecheck and build before integration.

The guided Finish browser test additionally draws a deliberately unrelated body
region and checks that a subsequent Finish retry refuses the stale lane light
without changing a previously frame-reviewed timestamp. This is routing safety,
not a manually labeled athlete or finish-pad location.

## Completed paired stress matrix

The 36-case matrix finished with zero workflow errors. Compared against retained
0.28.6 on checksummed identical media, using a stricter 10 ms output-drift gate:

- 36 paired cases, zero unpaired cases.
- Zero accepted-time drifts and zero new unverified automatic acceptances.
- Three automatic-boundary availability losses across two IMG_9076 copies:
  control-720 Start 2.850 s / Finish 14.300 s now require Start review;
  compact-360 Start 2.850 s now requires review (its Finish was already withheld).
- No other accepted boundary changed. The original IMG_9076 already required
  review; these transformed copies no longer gain an audio-authoritative Start.
- The matrix's 19 investigation flags reflect source-relative availability and
  unlabeled evidence; they are not 19 newly introduced regressions or accuracy
  failures. These are six independent recordings, not 36 independent climbs.

Decision: retain the stricter confidence rule alongside the stable search hint
and lane handoff. The deliberate reduction in automatic availability on weak
copies is preferable to promoting uncertain audio. No timing offset or threshold
was adjusted to force the user's total. Native-frame 12.24 remains 12.255 s,
15 ms above the user's total-only reference; start/finish labels remain unknown.

The final shared Finish helper was connected after the matrix (default candidate
ordering is equivalent). Original-source replay, guided Finish/manual-lane tests,
and typecheck/unit/build are rerun after that integration.

## Final implementation verification

- Final original-six full-workflow replay passed:
  `test-results/lanes-final-six-0.28.8.json`. Accepted source boundaries are
  unchanged. All eight public rejection-safety workflows passed in
  `test-results/lanes-strict-full-cohort-0.28.8.json`; none is claimed as an
  accurately timed public race.
- 582/582 tests across 58 files, typecheck and production build pass after
  connecting the Finish helper. The existing >500 kB entry-chunk advisory remains.
- Expanded guided Finish browser workflow passed, including manual body-lane
  exclusion, desktop/mobile layout checks, pad geometry, explicit acceptance,
  cancellation, save/reload and dataset round-trip. Its first harness attempt
  redundantly tried to close an already auto-closed review; removing that test
  action resolved the harness failure without changing application behavior.
- Full cancellation/replacement test passed with the new lane-ledger assertions.
- Agent-browser completed the 12.24 full analysis without browser exceptions;
  desktop/mobile Finish review screenshots were inspected. The test session was
  closed. Unrelated stylesheet changes remain excluded from this release.
