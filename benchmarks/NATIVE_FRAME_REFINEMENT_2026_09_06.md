# Native-frame Start and Finish refinement

Baseline: 0.28.10 (`b77ac30`). Candidate: 0.28.11.
This is a sampling and rejection-policy improvement, not a measured estimate of
general event-timing accuracy. Existing benchmark expectations were not changed.

## Reproduced problems

The old refinement grid rounded seek positions to milliseconds. In a generated
30 fps video, 72 requested observations reached only 48 distinct source frames.
In a generated 10 fps video, they reached only 24. Counting repeated images as
independent confirmation let a single-frame blue glitch establish an early
Start. A separate 60 fps fixture exposed the inverse problem: two distinct
frames could satisfy a frame-count threshold without enough elapsed blue time.

The new bounded walker uses native timestamps and frame durations where
available. Short calibrated Start refinement requires distinct blue frames and
elapsed blue support; a return to green over multiple observations disconnects
an earlier departure from a later confirmation. Dense Finish refinement uses
the same walker, including the first short flash in its connected sequence.
Coarse discovery and long/generic Start scans are unchanged.

Missing native timing from the beginning retains an explicit cursor fallback.
Losing timing after a native scan begins, stalled decoding, cancellation, or a
bounded-budget failure cannot silently produce a completed dense verification.
Observation intervals describe the sampling, not the physical timer's latency.

## Regressions found during development

An early candidate accepted Start on two edited public clips where a nearby
candidate had failed the full-frame continuity check. That failure now vetoes
automatic acceptance across the same 0.38-second fusion neighborhood. The two
checksummed clips were added to the development failure registry, not to an
independently labeled accuracy dataset.

Another candidate shifted the darkened IMG_9199 Start to 6.942 seconds by
averaging an isolated earlier visual event with two later agreeing cues. A
unique-majority check on native blue-confirmation times now excludes that
outlier from both the clock and downstream Finish lane selection. Blue
confirmation selects consistent evidence; it is not substituted for Start.
The final scoped result on this copy is 7.033 seconds. This is an output
regression correction, not proof of its physical launch time.

Applying a chromatic-departure guard globally changed lane selection and broke
tracking/Hold 10 previews on working originals. That experiment was rejected:
the existing recovery-only guard remains scoped, and exact protocol audio
bypasses the visual-clock majority check. Choosing a plausible total while
tracking the wrong lane is not an acceptable improvement.

The final 36-copy comparison also exposed an over-broad confirmation veto on
compact IMG_9199: all three departure clocks agreed, but later blue visibility
varied. The check was narrowed to actual departure disagreements. Excluding an
outlier now requires separation in both departure and confirmation, and an
agreed departure cannot be vetoed merely by later blue visibility. Regression
tests cover both cases.

## Reference results and limits

- The original 12.24.mov still gives Start 9.400, Finish 21.655, and total
  **12.255 seconds**, 15 ms above the user's 12.240-second total. That total does
  not independently validate either raw endpoint.
- Original IMG_9199 gives Start 7.121, Finish 17.472, total 10.351 seconds, with
  tracking and Hold 10 review previews retained. The 9 ms Start shift from
  7.130 reflects source-frame sampling, not independently established accuracy.
- Original IMG_8903 still has no accepted Finish. Its low-fps copy newly gives
  Start 4.290 / Finish 15.667. Darkened IMG_9076 newly gives 2.900 / 14.300.
  Developer inspection puts the athlete near the upper target at those Finish
  frames, but neither pair is an independently annotated contact label.
- Other unresolved recordings and edited broadcasts remain review cases.
  Several transformed clips still lack accepted timing or usable tracking.
  Additional copies are robustness cases, not additional independent climbs.

The test suite generates five small encoded fixtures at 10, 30, and 60 fps and
checks 65 phase/sensitivity combinations in Chrome. The dimming/brightening
fixtures explicitly exercise the chromatic recovery mode; they do not prove
that every standard-mode exposure change is rejected. Synthetic lamp pixels
have known event frames but do not establish real-video or pad-contact accuracy.

## Verification record

- `npm run check`: 647 unit tests across 63 files, typecheck, and production build
  pass. The existing large-entry-chunk warning remains; no dependency was added.
- Production dependency audit: zero reported vulnerabilities.
- A full 36-copy sweep ran in three 12-case partitions, with zero workflow
  errors and zero violations of the runner's existing timing-drift policy.
  Pairing checksummed media against the older full sweep at a stricter 10 ms
  comparison threshold exposed the compact-copy availability loss described
  above; a clean runner exit alone was not treated as sufficient validation.
- Cancellation was exercised during Start, detail recovery, upper-target
  search, Finish, and pose analysis. Previously accepted timing and evidence
  survive a cancelled rerun; invalid and rapid video replacement tests pass.
  Cancellation took about 0.4–0.6 seconds outside pose; the current pose call
  took about four seconds to settle before cancellation completed.
- Finish review passed marked-area coordinates, source-frame navigation,
  explicit acceptance provenance, save/reload, dataset export/import, video
  replacement, and automatic target review without accepting Finish.

The last fusion adjustment is separately rechecked on all six originals,
eight public clips, the affected compact/silent copies, the dark-copy outlier,
and the no-VideoFrame fallback. Those follow-up runs are distinct from the
36-copy sweep, rather than silently replacing entries in its report.

The affected-copy follow-up restores compact IMG_9199 to Start 7.033 / Finish
17.467 with 29 valid pose samples, leaves silent 12.24 review-only under the
existing body-audit policy, and retains dark IMG_9199 at 7.033 / 17.467. The
fallback replay passes both working-original workflow checks; without native
VideoFrame timing, 12.24 remains 12.283 seconds, not the native path's 12.255.

## Cross-platform readiness follow-up (0.28.12)

The first Linux CI runs exposed a seek/readback race that did not reproduce in
the local Windows synthetic suite: the before/after calibration samples could
both read green, although the ensuing native scan correctly read blue at the
event. A separate run briefly fell back to cursor sampling at one search phase.
No expected event time or fixture assertion was relaxed to hide these failures.

A bounded readiness check now waits when readable native metadata still refers
to a distant earlier frame after a seek. Native objects are closed on every
path; unavailable support/duration retains the existing fallback. The first
strict candidate passed Linux CI but stopped on a VFR boundary in IMG_9199:
cursor 17.4701, source PTS 17.436667, reported duration 0.033333. The source
walker already handles small gaps between reported duration and the next PTS;
the readiness check therefore allows a 5 ms boundary margin for that walker to
resolve. This margin is not a timing-error claim or a change to accepted event
timestamps. A permanently stale decoded frame still fails within 200 ms.

The preview-branch check catches such platform differences before merging to
main. The application continues to process private clips locally.

## Local research not promoted

Widening/recalibrating a lower-light crop did not give consistent improvements.
A local-only OCR experiment on a visible timer produced empty or inconsistent
partial digits under LED glare. Neither experiment changes application timing.
No footage was uploaded for OCR, and no OCR package was added to the app.

Private media, diagnostic frames, and full local reports remain ignored. The
public CI test uses generated footage only. Independent Start, Hold 10, and
Finish labels across more cameras and timing systems are still needed before
making a general accuracy claim.
