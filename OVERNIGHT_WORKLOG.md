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
