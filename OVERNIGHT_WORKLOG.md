# ClimbIQ overnight improvement run — September 5, 2026

## Scope and safeguards

The active goal requests at least seven hours of work. Check the goal's measured
working time before marking it complete; a scheduled wake-up or elapsed night is
not evidence of seven hours of work. An hourly, eight-run thread heartbeat is a
continuation safeguard. Pause it once the goal is complete.

Preserve the existing, unrelated `src/styles.css` edits. Do not commit private
videos, extracted private frames, or their original location metadata. Fetch
before pushing verified checkpoints because the user also works from a Mac.

## Baseline

- Starting commit: `624b6e9`, release 0.22.0.
- Previous verified suite: 367 tests; five private-video full workflows.
- Browser baseline: page loads, upload and library controls render, no browser
  errors detected. Screenshot is local-only in `test-results/overnight-baseline.png`.
- Existing real-video labels are a small regression set, not a representative
  estimate of accuracy. Derived video variations are not new independent climbs.
- Hold 10 height-passage evidence remains review-only and is not contact timing.

## Work queue

1. Build reproducible, privacy-preserving video-variation tests: compression,
   size, exposure, frame rate, missing audio, and known lead-in trimming.
2. Measure accepted/review/missing boundaries and timing shifts against original
   observations. Distinguish wrong acceptance from conservative review fallback.
3. Diagnose and fix evidence-backed start/finish regressions; retain scene-cut,
   athlete identity, and ambiguous-lane safeguards.
4. Investigate why actual Hold 10 registration fails on the current recordings.
   Do not relabel a height crossing as a hold touch or simply lower support gates.
5. Expand complete upload/analyze/review/save/import/reload/cancel/retry coverage.
6. Simplify workflow friction found during testing; verify desktop/mobile views.
7. Record measured changes, remaining limitations, and verified Git checkpoints.

## Checkpoints

- Initial inspection: clean except user-owned styles; local FFmpeg available in
  the ignored tools directory. No application dependency installation needed.
- First robustness matrix: six copies each of two climbs. The clear-view clip
  retained both accepted boundaries within the 0.100 s regression policy, but
  its compressed start shifted -0.080 s. Five altered angled copies fell back
  to start review; the darkened angled copy falsely accepted Finish at 9.290 s,
  five seconds before the existing reviewed 14.290 s reference.
- Diagnosed false Finish: red-dominant obstruction pixels (83,32,5) satisfy a
  green-minus-blue check. Added a normalized red-share gate relative to learned
  and stable source colors, plus review downgrade when dense refinement fails.
  First targeted replay no longer accepts that false finish. All five original
  full workflows still pass, including save/duplicate/reload/cancel/retry.
- Current checks: 381 tests across 39 files, typecheck/build passed. This includes
  four research-only grid tests; the alternate geometry is NOT the app default.
- Route research: official 2022 attachment-grid coordinates, still linked by
  World Climbing on the inspection date, increase 9199 support from 8 to 14
  holds and locate a left-hand candidate near 11.499 s. Attachment bolts are not
  contact centers. Need visual numbering checks and more recordings before
  enabling the reference. Browser import cache must be bypassed for experiments
  after Vite hot updates (`?research=<timestamp>`).
- Local research state in browser session `climbiq-overnight`:
  `window.__climbiqRouteResearch` retains 9199 frames/calibration/results;
  `window.__darkSaved` and `window.__darkFinish` retain the pre-fix dark failure.
  Currently loaded video is the dark 8903 copy. These globals are temporary.
- Full post-patch twelve-copy replay: zero wrong accepted boundaries, zero
  workflow errors; five start availability losses remain. Dark 8903's upper
  review suggestion is still wrong (18.290 s versus reviewed 14.290 s), so the
  safety fix is NOT a claim that angled finish detection is now accurate.
  The report now records review-candidate errors separately from auto-acceptance.
- Shared Drive checked through its public folder page after the connector
  reported disconnected: it still contains only the same five recordings.

## First-hour follow-through

- Checkpoint `5436846` (0.22.1) pushed; GitHub CI succeeded. It contains the
  false-finish guard and reproducible robustness tooling, not the route work.
- The other three originals were tested with six variations each. Two 9076
  copies newly accept Start at 2.850 s; control also accepts Finish at 14.300 s.
  These lack independent labels and MUST be investigated, not scored correct.
  Silent 9076 exposed a timing-runner timeout because a review-level finish
  proceeded into expensive pose analysis. Timing-only runs now stop at the
  completed timing stage; targeted replay finished without workflow error.
- Further geometry experiments found a 19-hold projective fit at the existing
  absolute 0.18 displacement cap, median residual 0.00184, while the tighter
  0.10/0.16 searches only found 14/16 with larger residuals. New recovery requires
  16 direct matches, direct 9/10/11, median <=0.008, RMS <=0.012, and an athlete
  anchor within 0.08. No threshold was lowered to accept sparse evidence.
- Current implementation recovers visible Hold 10 on 9199 and disambiguates
  hands using observed neighboring holds. Matched geometry never changes COM
  calibration or accepted start/finish. Full workflow finds a left-hand review
  candidate at 11.440 s, with 26/26 samples and three clear close-ups.
- A compact saved session omits hips; a seed based on hips before saving but COM
  after reload could change the crop. Both now prefer the persisted image COM
  seed. The route is reidentified after reattaching a saved recording, and the
  runner checks that the target does not degrade to an unregistered template.
- Full five-original workflow passed with registration changes and visible Save
  Session. Dedicated 9199 review tests passed: manual test acceptance yields
  4.310 + 6.040 = 10.350 s, Start edits clear stale evidence/splits, and unsaved
  review does not mutate the saved library. This is NOT a ground-truth label.
- Save Session is visible outside management, status is accessible, empty
  management actions are disabled, generated session names follow replacement
  files, and marker drafts clear/remount so old text cannot leak to another video.
- Review acceptance now requires a paused, decoded frame and reads video time
  directly. CDP test interactions require `userGesture: true` to exercise real
  playback; otherwise browser autoplay policy correctly refuses synthetic play.
- Current release-in-progress: 0.23.0. Last full suite before final doc changes:
  395 tests; two additional naming tests added since. Desktop/mobile screenshots
  checked locally. Research browser globals were cleared during reload; never
  serialize raw ImageData arrays into sessionStorage (too large). Saved compact
  sessions remain available in the isolated `climbiq-overnight` browser profile.

## Next investigations after the second checkpoint

1. Replay full original and transformed 9199 workflows at 5/10/15 fps; preserve
   honest contact/height/inconclusive distinctions and capture numerical results.
2. Inspect 9076's newly accepted 2.850/14.300 s boundaries in actual frames/audio.
3. Improve the dark angled upper finish review (18.290 s versus 14.290 s).
4. Diagnose start availability losses without simply weakening safety gates.
5. Profile unnecessary PNG encoding in pixel-only frame capture and cancellation
   responsiveness; investigate route-aided calibration only with strong evidence.
6. Continue broader robustness and cross-device workflow tests. At this point
   only about one hour of the requested seven-hour work goal has elapsed.

## Second-hour testing and current work

- Checkpoint `ba2a468` (0.23.0) pushed; GitHub CI succeeded and the live complete
  9199 workflow passed. It contains route registration and save/review usability.
- Same 9199 source at 5/10/15 pose fps retained 42/52, 87/104, 133/156 usable
  frames. Registered Hold 10 review cursors were 11.440, 11.415, 11.439 s.
  These are within-recording consistency checks, not independent accuracy labels.
- New uncommitted browser frame observer distinguishes decoded media PTS from
  the seek cursor. Native 9199 review accepted 11.437 instead of cursor 11.440;
  older-browser fallback accepted 11.440 and saved an explicit fallback note.
  Browser-native frames can arrive before `seeked`; pending presentation is
  retained until the seek settles. Nine unit tests cover cleanup, races, source
  replacement, missing API, and malformed metadata.
- Pixel-only capture avoids encoding an unused PNG. Five paired 1080x1920
  measurements gave median 8.9 ms vs 61.9 ms with PNG, with exactly equal RGBA
  arrays. This is a capture microbenchmark, not an end-to-end speedup claim.
- Full test suite passed 409 tests/41 files before current calibration work.
  Real keyboard input fixed a synthetic focus/blur runner race. Native frame
  readiness also requires atomic ready-check/click in the test driver.
- Production full transformed 9199 workflows showed real tracking losses:
  control, dark and trim copies retained timing but no usable COM. New reports
  distinguish tracking/target availability losses from save/reload errors.
  The failure is a saturated ceiling fringe accepted as an upper timing marker,
  followed by the wrong lane. Two-group spatial validation and group-center
  balancing are being tested, NOT yet released. Original tracking rises to
  44/52, but contact/reload dependencies need verification before pushing.
- A correctly registered Hold 10 may project 0.053 m beyond an approximate
  side edge. Current experiment permits contact review only within a 5% lane-
  width margin, with directly observed Holds 9/10/11. Manual calibration remains
  strict, COM geometry never changes, and no contact is auto-accepted. New tests
  verify the cap, missing-neighbor refusal and calibration immutability.
- Actual current work duration is about 2 hours 15 minutes, NOT seven hours.
  Next: finish full original/transformed regression checks; investigate 9076's
  unverified acceptance and 8903's wrong dark upper-finish review; cancellation,
  comparison, export/import and broader public-video checks remain worthwhile.

## Label audit and 0.24.0 checkpoint preparation

- Full 30-variation batch completed with zero workflow errors. Reassessment
  under explicit label provenance gives zero source-consistency timing drifts,
  zero independently labeled boundaries, and 17 unverified accepted boundaries.
  Do NOT call this zero false accepts or 100% accuracy. Numerical capture and
  tracking results are in `benchmarks/overnight-robustness-results.json`.
- Critical discovery: original 8903's old 14.290 s “correct” finish is a red
  scoreboard-digit change. Direct helper inspection selected x=0.600–0.628,
  y=0.050–0.066, RGB (180,162,145) to (220,64,63). The athlete is still climbing
  at that time. Label is disputed; no replacement exact label has been invented.
- Hue-direction validation rejects that clock change, but the next-best upper
  color candidate was also unverified. Uncorroborated upper color changes now
  have no primary finish timestamp; they remain explicitly unverified candidates.
  Physical top reach is labeled as motion review, not pad-contact measurement.
- A related safety flaw let any returned review cursor bound automatic COM.
  Automatic COM now requires an accepted finish or official total. The brief
  new 47-frame 8903 result was cut at a disputed cursor and MUST NOT be described
  as improved complete-climb tracking. That path now pauses for finish review.
- Legacy correctness flags/manual times have no independent-review provenance.
  Accuracy and Wilson intervals are now unavailable until confirmed labelReview
  records supply reviewer ID, method, date, raw time and independence. Old output
  times remain regression observations; label status cannot silently turn them
  into ground truth. College/demo precision claims were withdrawn accordingly.
- Upload smoke test no longer hardcodes `12.24.mov` or Windows-only paths.
  Instant scrolling avoids a smooth-scroll hit-test race. Keeping normal browser
  GPU support is necessary for this Chrome installation's HEVC/MOV decoding.
  Arbitrary-name MOV upload and same-file retry now pass.
- Version 0.24.0 candidate: 421 unit tests/42 files, typecheck/build passed.
  Full five-original workflow passed before the final uncorroborated-upper guard;
  focused original 8903/9199 replay is now running. Start/Finish acceptance on
  9199 remains 7.130/17.480, with 44–45/52 COM and 19 route matches. Contact scan
  can be inconclusive; native-frame review or explicit cursor fallback is saved.
- Wall-marker correction restores control/trim 9199 COM from 0 to 44/45 frames.
  Darkened 9199 still refuses calibration; compact/low-fps/silent copies retain
  some COM but may lack a continuous Hold 10 candidate. These remain open issues.
- Around 2 hours 50 minutes of the seven-hour goal have elapsed. Continue toward
  the actual target (~08:04 America/Chicago); do not mark this checkpoint as the
  full seven-hour completion.

- Final public replay caught a real review-cursor regression: 1745 changed from
  1.017 to 0.250 s with continuous native frame callbacks enabled. Production
  still gave 1.017, and disabling the callback API locally restored it. Native
  frame observation is now mounted ONLY during manual review and suspended
  during every analysis task. Focused public/private replay is checking this
  isolation before the checkpoint can be pushed. No public start was accepted.
- Desktop/mobile review screens checked at 1280x900 and 390x844: no horizontal
  overflow or browser runtime errors. However the review panel is separated
  from the video by close-ups, and scrolling can hide the video (which also
  suppresses native presentation callbacks). Improving this review layout is
  a concrete next step after the checkpoint.
- Callback isolation passed the focused 1745/9199 replay: the public cursor is
  restored to 1.017 s, remains unaccepted, and 9199 retains its complete workflow.
  The other five public crops passed in the preceding full replay. Final
  no-frame-callback 9199 test also passed with an explicit saved fallback note.
  Final checkpoint checks: 421 tests/42 files, typecheck and production build.

## After 0.24.0 (`d0e51d5`) — ongoing work

- Checkpoint pushed; GitHub verification passed. Live 8903/9199 full workflows
  passed, but a mixed sequence still changed the unverified public 1745 cursor
  to 0.250 s. Callback isolation was not the full cause: disabling the API in a
  mixed full sequence also reproduces it. Timing-only sequences and two repeated
  public save/reload workflows retain 1.017 s. Do not claim the low-level
  sampling/review interaction is fully diagnosed.
- Both competing public cursors are artifacts: 1.017 is a camera cut; 0.250 is
  a lower-screen graphic patch (y=0.959–0.981). The 5.330 audio proposal is also
  unverified. The public cohort now asserts safe refusal and records changed
  cursors, rather than pinning an explicitly unverified cut as an exact label.
- A pre-fusion artifact re-ranking experiment moved private 9075's review cursor
  from 8.450 to 7.230 s and was rejected. Current approach retains inspectable
  ranking but removes cut/overlay cues from automatic clock-establishing votes.
  Unit tests cover correlated cut votes, broad lower-screen bands, and manual/
  portrait exclusions. Full replay is checking this revised policy.
- New TimestampReviewPanel and scoped CSS keep the actual video and acceptance
  controls together. At 390x844 the player and all acceptance controls fit on
  screen; at 1280x900 they sit side by side. Detailed timing explanation is
  collapsed while fallback provenance remains visible. Step buttons pause;
  pause synchronizes the actual cursor; each new video gets a fresh element.
  Four component rendering tests pass. Native frame time remains best-effort:
  if a callback is unavailable, the explicit cursor fallback is retained.

- Review-close now cancels queued animation-frame seeks, including Return to
  suggestion immediately followed by Close. Full 9199 workflow verifies this,
  new-upload cursor reset, saved frame provenance, phase arithmetic, and that
  unsaved edits do not change the saved library. All passed on 0.25.0 locally.
- Accepted marker metadata now distinguishes automatic, manual-entry and
  frame-review. Dataset JSON no longer marks every automatic result as
  `userAccepted`; legacy metadata stays unknown and every operational acceptance
  explicitly says it is not a ground-truth label. Save/reload and actual Copy
  JSON export tests exercise these modes (clipboard is mocked, not overwritten).
- Checkpoint checks passed at 433 tests/44 files, typecheck/build. One additional
  fusion test now guards against an excluded artifact shifting a valid light's
  accepted timestamp through cluster averaging; broad replay follows this fix.
- Dark-frame calibration diagnosis: on 9199, proposed wall support is 0.850
  versus the 0.860 requirement. At unchanged control geometry it drops from
  154/160 to 130/160 accepted surface samples; many rejected points are at the
  right edge, where direct inspection shows room/structure outside the wall.
  Therefore merely lowering the darkness/surface threshold would risk accepting
  incorrect geometry. No such threshold change has been made.
- Final mixed 0.25.0 full-workflow replay passed all five original recordings and
  six public crops. Private timing observations stayed consistent; all public
  Starts remained unaccepted. 9199 retained 44/52 COM, 19 registered holds, and
  passed the new review-cancellation and export-acceptance checks. This is
  regression/workflow evidence, not a labeled accuracy result.

## 0.25.1 safety correction — still working toward seven hours

- 0.25.0 (`29c16ef`) pushed, GitHub verification passed, and live 9199 full
  review/save/export flow passed with native frame time 11.470 s (workflow
  acceptance only, not a contact label).
- Final 30-copy 0.25.0 batch: zero workflow errors and zero drift from accepted
  original timing observations. However a new paired-report comparator exposed
  an additional unverified accepted Finish on silent 9076 at 29.717 s. This
  shows why matching old source observations alone is an insufficient check.
- Direct inspection: an upper light resets at 29.717 while a foreground person
  enters the upper image. The motion fallback reports a false top reach at
  30.317, accidentally corroborating the reset. Earlier footage already shows
  a stopped timer. Neither late event is a credible finish boundary.
- Fix: nearby upper motion can support a review cursor but cannot promote an
  upper indicator to automatic acceptance. Only agreement with an entered
  official total can promote that fallback to High. The lower verified sensor
  path remains unchanged. Exact observed failure times have a policy unit test.
- New real-browser interruption test passed cancellation during Start, Finish,
  and pose stages; cursor restored to 2.500 s, accepted markers preserved,
  active-run replacement blocked, rapid replacement and invalid-file recovery
  passed. The test uses a fresh isolated browser profile and no user library.

## Source-frame review work (0.26.0 candidate)

- Stopped-timer prototype found a plausible 15.890 s display-freeze cue in
  original 8903, but failed compression/darkness stress checks: red holds could
  imitate changing digits, giving 8.490 or 12.490 s proposals. The prototype
  is NOT in the app; it is retained only in ignored local research files.
- W3C WebCodecs specifies that `new VideoFrame(video)` inherits the current
  playback frame's timestamp when no timestamp override is supplied:
  https://www.w3.org/TR/webcodecs/#dom-videoframe-videoframe-image-init
  This gives synchronous paused/offscreen frame timing without waiting on
  compositor callbacks. Every temporary frame is closed immediately.
- Actual 9199 checks: cursor 11.501 maps to source PTS 11.470; 7.130 maps to
  7.101667; 17.480 maps to 17.471667. These identify displayed source frames,
  not independently labeled physical events. Detector output is unchanged.
- Native source-frame duration now supports Previous/Next Frame controls and
  is shown in review details/saved notes. Unsupported browsers retain explicit
  approximate stepping and cursor acceptance; the full no-API workflow passed.
- Real browser frame audit: original HEVC/MOV, synthetic 15-fps H.264 and
  variable-frame-rate H.264 passed 18 seeks each, repeated-pixel hashes and
  adjacent-frame round trips. The 15-fps clip correctly gives the same source
  frame at cursor 0.150 and 0.180 (PTS 0.133333, duration 0.066667).
- Five-original full workflows passed with native snapshots enabled only while
  idle/reviewing. All original accepted timing observations stayed consistent.
  Mixed public 1745 can still select either unverified artifact cursor (0.250
  or 1.017); neither is accepted. The underlying ranking sensitivity is open.
- Frame-plan generation now refuses nonfinite/unrepresentable ranges and
  oversized allocations instead of risking an infinite main-thread loop.
- All five original recordings subsequently passed 18 native-frame audit seeks
  and Previous/Next Frame round trips each. Together with the two synthetic
  frame-rate clips, that is 126 successful seek/pixel checks. Unit checks:
  458 tests in 46 files, plus typecheck/build. Live 0.25.1 also reproduced the
  corrected refusal of the silent 9076 reset; Finish remains unaccepted.

## Sample provenance and import checks (0.27.0 candidate)

- 0.26.0 (`cb81d58`) pushed. The completed 30-copy replay has zero workflow
  errors and zero source timing drifts. Paired comparison against 0.25.0 has
  one acceptance loss: the intentionally blocked silent-9076 reset at 29.717 s.
  No other accepted boundary changed. Accuracy remains unavailable.
- Native frame PTS/duration now travel with pose samples and survive compact
  save/load. Export audits distinguish requested sampling positions from unique
  source images. Hold 10 cannot manufacture dwell by counting several seeks
  into the same decoded frame as independent observations.
- Confirmed import bugs: null coordinates became zero via Number(null), and
  the truthy string "false" made a pose frame valid. New failing tests reproduced
  both; strict numeric/boolean validation now passes them without changing
  ordinary numeric session data.
- The original 9199 full 15-fps workflow passes at 129/156 usable COM samples.
  All 156 have native timing metadata and unique source frames. Source intervals
  range from 0.033333 to 0.035 s; maximum cursor/source offset is about 0.028667 s.
  That is a frame-selection observation, not a measured detection error. Saved
  metadata survives reload and clears from exports after a stale Start edit.
- Known false-finish fingerprints now bind to exact media checksums and fail
  when the old bad acceptance recurs. A runner bug could hide a safety failure
  behind an empty ordinary-assertion list; failure propagation now covers both.
- Current checks: 478 tests/48 files, typecheck/build passed. High-density
  control/compact/15-fps-media comparisons and final failure replays are ongoing.
- High-density 9199 variations completed: control 129/156 usable COM, compact
  87/157, and 15-fps media 113/157. All sampled frames retained native timing;
  this run had no repeated source frames. The duplicate-dwell guard is proven
  by an explicit synthetic regression, not by claiming these clips duplicated.
- Both checksummed known-failure clips passed full workflows and their specific
  guard assertions. The test harness now also refuses to treat application
  exceptions or unreadable status/marker UI as successful abstention.
- Exploratory stereo audit found no large global channel cancellation in 8903,
  9075 or 9076 (mix/individual energy ratios about 0.724/0.952/0.923). On 9076,
  one individual channel proposes 2.860 s at High while the mix gives 2.790 s
  at Medium. This is unverified diagnostic evidence; no channel-picking change
  has been shipped or described as improved accuracy.

## Final release verification

- 0.27.0 (`6ee5bf8`) pushed and GitHub verification passed. The complete final
  30-copy run (`video-robustness-2026-09-05T12-12-45-711Z.json`) has zero workflow
  errors, zero source timing drifts, and both known-failure guards held. All
  available 9199 pose results preserved native sample timing through exports.
- Browser shutdown now requests graceful close before using the test's own
  process handle as a bounded fallback. Two orphaned utility workers from this
  run were terminated after checking their exact test profiles and dead parents.
  No user browser session or files were removed.
- Frame-step tests now check three timeline positions, including the synthetic
  15-to-30-fps transition. They pass round trips, but additional hidden-player
  probes exposed decode-history-dependent frame duration/seek behavior. UI help
  now explicitly says browser-decoded stepping may not enumerate every encoded
  frame. Native PTS is a reported decoded-image timestamp, not a promise that a
  requested seek reached every possible source frame.
- 0.27.1 candidate passes 483 unit tests/49 files, typecheck and build. This
  checkpoint adds browser-test shutdown and clarifies frame-step limitations;
  detection and contact-policy code remain the same as the final 0.27.0 batch.
- Final cancellation testing found another actual bug: a cancelled preflight
  rerun cleared the prior accepted Finish while claiming old results were kept.
  Before a replacement Start commits, cancellation/errors now restore the prior
  timing, lane calibration, COM and review context. After commitment, completed
  stages remain available. The original failing marker test now passes, and a
  stronger full-unsaved-analysis test preserves COM text and all three Hold 10
  previews too. The test selector was corrected to the actual labelled section
  before that stronger replay; no application behavior was mocked to pass it.
- Full production 0.27.0 replay passed all five originals and six public crops,
  including native sample-metadata preservation and stale-export clearing.

## Completed seven-hour run

- Goal accounting exceeded seven hours (25,800 seconds at the completion
  checkpoint), with implementation, real-browser experiments and verification.
- Release 0.27.1 (`52451e0`) is pushed to main, GitHub verification is green,
  and production serves `index-Dyb9ZWt9.js`. The final production 9199 full
  workflow passed analysis, review, save/reload, comparison and stale-evidence
  clearing. All 52 pose samples retained native frame timing; 45 were usable
  COM samples. These counts are tracking coverage, not positional accuracy.
- Production rerun cancellation preserved the previous accepted timestamps,
  unsaved COM text and all three Hold 10 previews. Rapid video replacement and
  invalid-file rejection passed too. Current unit suite: 483 tests in 49 files,
  with typecheck and build passing.
- The final 30-copy batch has zero workflow errors and no accepted-time drift
  under its regression policy; 15 cases still need investigation. No independent
  event labels were created. Difficult dark/angled clips can still require
  manual review, and broadcast cuts are not a validated timing input.
- Existing user edits in `src/styles.css` remain untouched and uncommitted.
  Private recordings and frame previews remain outside Git. The next accuracy
  milestone is independently reviewed start, finish and Hold 10 contact labels,
  followed by evaluation on additional unseen climbs.
