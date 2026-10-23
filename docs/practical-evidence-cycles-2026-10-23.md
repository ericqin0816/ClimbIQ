# Ten practicality and detection-evidence cycles — October 23, 2026

This is a second set of ten review/improvement cycles, following the earlier
[detector engineering cycles](detector-improvement-cycles-2026-10-23.md).
The useful demonstrated improvements are native video review, recovery from a
partly undecodable tail, comparison safeguards, and replay reliability.
Automatic detection has not earned a 9/10 rating. Four fresh public attempts
produce no automatically accepted endpoints in the default workflow.

All ten scored review/improvement cycles are complete. No model weights were
trained, and no automatic-accuracy gain is claimed from these changes.

## How the scores work

The independent evaluation agent uses the same five components throughout,
each worth two points. Product practicality covers clear purpose, first useful
result, a defensible training decision, review/identity, and continuity.
Detection-evidence strength covers traceability, observable endpoints, match to
the supported capture conditions, independent labeling precision, and source/
athlete diversity. These are judgment scores, not measured accuracy percentages.
Additional skeptical agents review the implementation and interpretation
independently; their grades are reported separately rather than averaged.

These cycles include browser trials, source qualification, artifact audits and
targeted repairs. They are not ten independent field studies. Two AI agents
inspect source evidence independently before predictions; they are not recruited
human reviewers. Downloaded footage and original detailed artifacts stay out of
Git. Public availability does not establish redistribution permission.

## Scores, findings, and feedback used in the next cycle

| Cycle | Practicality /10 | Evidence /10 | Finding and next action |
| --- | ---: | ---: | --- |
| 1 | 7.2 | 5.5 | Baseline public/local workflows exposed a decode-tail stop and awkward phone review. An observed fallback used 74 taps; this was not a minimum interaction count. Add reachable precise navigation. |
| 2 | 7.4 | 5.5 | Native Jump to time takes three navigation actions on both tested phone heights, with 44-pixel targets and invalid-input checks. Next, make manual Finish begin after accepted Start without presenting its cursor as a detection. |
| 3 | 7.5 | 5.5 | H06 now completes into explicit partial Finish review rather than aborting. It still has one automatic Start, no Finish, and no total; observed terminal latency rises from 11.743 to 16.468 seconds. Preserve the unobserved tail and carry it into review/export. |
| 4 | 7.6 | 5.5 | Native Start → Finish → save completes in 13 supplied task actions on 320×568 and 320×740 viewports. Manual navigation has no invented prediction/confidence. Next, audit original automatic artifacts against independent source observations. |
| 5 | 7.6 | 5.6 | Original artifacts, hashes, whole-group exposure checks and conservative observer unions make the evidence auditable. No new accuracy is established. Next, qualify fresh recordings before prediction. |
| 6 | 7.6 | 5.6 | Two fresh Jan training recordings are independently screened. Recorded Start protocol is unresolved and joint first-contact Finish references remain unobservable. Keep them unresolved; exercise the complete practical workflow with stricter native-frame assertions. |
| 7 | 7.3 | 5.6 | A pair trial requested Finish 15.2 seconds but saved the initial 16.167-second cursor. Its initial harness pass was invalidated. Fix actions during pending native seeks and retain the failure. |
| 8 | 7.5 | 5.6 | Pending Jump now preserves typed input/focus and cannot silently discard a seek. Both phone heights pass; a native 2 fps control saves 0.5-second observation intervals. Initial real replay still pauses, so continuity remains limited. |
| 9 | 7.7 | 5.9 | Four fresh default attempts yield Start review 4/4 and Finish not run 4/4: automatic coverage 0/8. P07 supports explicit manual recovery within frozen observation brackets. Add context/clock review before performance claims and investigate the real replay interruption. |
| 10 | 7.8 | 5.9 | Paused replay correction and truthful endpoint completion pass native regressions. The real pair completes 3/3 after 2/3 before; a 1.531-pixel phone action-container overlap is repaired without weakening its assertion. All 46 local production workflows pass. Next, gather supported fixed-phone and human field evidence. |

Separate closing reviews retain their own criteria:

| Reviewer / scope | Practicality /10 | Evidence /10 |
| --- | ---: | ---: |
| Fixed-rubric evaluator, canonical ledger above | 7.8 | 5.9 |
| Independent skeptical product/evidence reviewer | 7.7 | 5.7 |
| Independent experience/workflow reviewer | 8.0 | 6.0 |

The engineering reviewer separately rates scoped code/reliability **9.0/10**.
That grade does not substitute for product usefulness or detection evidence.
No reviewer establishes human training benefit from a supplied-cursor script.

The canonical cycle numbers follow the ledger, not every exploratory filename.
For example, the retained `cycle04-tail-candidate.json` artifact belongs to
canonical cycle 3. Failed probes and superseded audits remain locally preserved.

## What the actual videos show

The [public evidence summary](../benchmarks/practical-evidence-2026-10-23.json)
contains source hashes, original artifact hashes, build/browser identities,
frozen reference uncertainty and primary/secondary run distinctions. It is a
derived summary, not a redistributed media bundle or a fully replayable public
study. The audit procedure is documented in [public-video-evidence.md](public-video-evidence.md).

All four fresh primary runs use clean commit `874e604b5268c9f00a63fbe468993c85f4c560e0`,
Chrome 156.0.8078.47, timing-only analysis, and the default opening search window
0–12 seconds. These are panning public videos with unknown source-speed and
audio/video calibration, not a cohort of supported fixed full-wall phone captures.

| Original attempt representative | Frozen source interpretation | Original default outcome | Observed terminal time |
| --- | --- | --- | ---: |
| [P01: Jan training](https://www.youtube.com/watch?v=IV6A8nruvK4) | Start protocol unresolved; joint first physical pad contact unobservable | Start review; Finish not run | 13.248 s |
| [P02: Jan training](https://www.youtube.com/watch?v=16a3Qm7QJ7U) | Same source/climber group as P01; unresolved Start and joint Finish | Start review; Finish not run | 20.180 s |
| [P05: Stan Kokorin record upload](https://www.youtube.com/watch?v=31RVli_2b4I) | Start protocol disputed; roof beam/blur obscures first pad contact | Start review; Finish not run | 12.299 s |
| [P07: SCS race](https://www.youtube.com/watch?v=1EpzcLV0NtM) | Right red-jersey athlete remains spatially identifiable; visible lane-light and apparent contact can be bracketed | Start review; Finish not run | 11.512 s |

The denominator is four distinct attempts from three source groups,
with two endpoint opportunities each. The known Jan recordings are grouped
conservatively; group counts do not certify named athlete identity or athlete
disjointness across the historical corpus. No Start was accepted, so Finish was not
run; this is not eight independent detector failures. Zero automatic acceptances
cannot establish timing accuracy or a conditional false-acceptance rate.

P07's visible cue occurs after the default opening window. A predeclared
secondary diagnostic run using the public 17–21-second search controls still
ends in Start review (11.049 seconds; cursor 20.654 seconds). This does not replace
the primary result, add an attempt, or demonstrate automatic improvement. All
these source/climber groups are development data for subsequent tuning.

Two independent preprediction AI observers supplied overlapping P07 brackets.
Their wider union is retained:

- Right lower lane lamp red → green: **18.585233–18.651967 seconds**.
- Apparent first right pad contact: **25.725700–25.892533 seconds**.
- Separate upper indicator green → red: **25.825800–25.925900 seconds**.

The indicator, apparent contact, recorded acoustic cue and electronic timing
trigger are different physical events. The recorded final acoustic protocol
remains unresolved; named athlete identity, source speed, audio/video alignment,
and electronic clock synchronization are unverified. No endpoint is inferred
from the displayed race total. One original Jan worksheet lacked an embedded
review timestamp; its wrapper explicitly records a conservative attested
reviewed-by bound, retaining the original bytes/hash rather than inventing an
exact observation time.

On both phone heights, the actual manual P07 route accepts native frame points
18.6186 and 25.8258 seconds, saves rounded markers 18.619 and 25.826 seconds,
and preserves a lane/source-clock limitation note. Both points fall within the
matching observational brackets. The numeric 0.033367-second source interval is
frame spacing, not physical-event uncertainty or timing accuracy. The 13 core
scripted actions exclude diagnostic checks and note entry; supplied event
navigation does not measure a human's search/correction time. Hold 10 stays unset.

## Concrete changes retained

- **Native review:** reachable precise navigation, guarded pending seeks,
  preserved input/focus, correct Start-to-Finish navigation, and accepted native
  frame intervals saved numerically. A manual cursor is not labeled Suggested
  or given detection confidence.
- **Decode-tail recovery:** strict source/readiness checks stay in place. Only a
  bounded container-tail failure can recover an independently re-seeked exposed
  native interval. It retains the unseen tail, caps confidence, and requires
  review; it cannot invent a Finish from stale pixels or an official total.
- **Comparison and coaching:** recorded differences remain visible, while
  gained/lost/faster claims require explicit review of climber, route, clocks
  and physical events. Marker/context changes reset that review. Same-attempt
  lineage, mixed synthetic/personal sources, low confidence, unreviewed Hold 10
  and coarse observation intervals retain their existing gates. User review is
  not independent verification of unknown public source clocks.
- **Evidence audit:** original workflow snapshots and SHA-256 hashes prevent
  manual corrections replacing original automatic predictions. Whole connected
  source/athlete groups must be frozen before their earliest supplied prediction.
  Missing endpoints stay in denominators. Unavailable current analysis is
  unknown, not fabricated negative evidence.
- **Replay:** drift correction and phase boundaries use one paused pair owner,
  strict seeks, captured media/source identity, cancellation checks, and resume
  only unfinished sides. True current underflow still requires explicit replay.
  Finished is published only after successful owned endpoint preparation.

## Closing verification

The existing development phone recording retains automatic Start 9.400 and
Finish 21.655 seconds. The two Edinburgh excerpts and no-audio Jakarta recording
remain review-only: **2/8 automatic development endpoints**, unchanged. A clean
`656fd401951665b39531910559a4495e914b851c` rerun has no page errors or content
security violations. Individual terminal times are 4.971, 12.975, 12.314 and
13.197 seconds; one run per clip is not a new performance estimate or accuracy
study.

The pre-fix real Emma pair completes only 2/3 uninterrupted diagnostic replays.
In the failure, active drift correction seeks both native players forward while
they are playing, causes a decode wait, and invokes the buffering pause. A new
native-lag regression fails against the old build with an active seek and no
recovery. The clean `f531d8b` after-fix pair completes **3/3 uninterrupted native
replays**, stops at both saved endpoints, and has no media/page errors, buffered
alerts or time assignments while either player is active. None of those three
runs naturally needs a mid-replay drift correction, so that branch is exercised
separately by a controlled native-lag regression; it does not prove a natural
network stall was recovered.

On the same clean build, H06 completes explicit partial Finish review in 18.132
seconds, retaining one automatic Start, no Finish or total, and the unobserved
13.270-second cursor. Its exported native pixels are observed only through
13.233333 seconds, with unknown final video-track boundary. H11 remains Start
review in 8.081 seconds. These development runs have no page errors or content
security violations and do not add independent attempts or automatic coverage.

The full local check at `656fd40` passes 1,093 tests across 104 files, type
checking, production build and compiled coaching runtime smoke checks. The
subsequent endpoint-status change is typechecked and built cleanly at
`f531d8b7e4a0eac2b75ed41a97724ef224339ec9`. Its local Chromium desktop/phone
suite passes 45/46: all comparison checks pass, while the short-phone review
action container overlaps bottom navigation by 1.531 pixels. That layout
failure is preserved and its assertion is retained for the repair. Reducing only
the short-phone action wrapper's vertical padding from four to two pixels saves
four pixels, while preserving 44-pixel touch targets, font sizes and the strict
geometry assertion. Clean `8fe669bd87131523b27c524d9ed11ffc9b972d5a` then passes
**46/46 local production workflows**: 23 desktop and 23 phone, no skips,
unexpected failures or flaky cases. Both 320×568 and 320×740 review checks pass.

The earlier complete runtime passes all 46 hosted Chromium desktop/phone
workflows, all 46 macOS WebKit desktop/phone workflows, and the verification job
in [CI run 39978095132](https://github.com/ericqin0816/ClimbIQ/actions/runs/39978095132).
The subsequent geometry build also passes **46/46 Chromium** and **46/46 macOS
WebKit** workflows plus the verification job in
[CI run 39979862781](https://github.com/ericqin0816/ClimbIQ/actions/runs/39979862781).
Production dependency audit reports zero entries. WebKit phone viewport coverage
does not replace testing on an actual iPhone.
The first branch CI run exposed two stale Finish-button locators and a WebKit
phone endpoint failure; those failures are retained, not counted as passes.

## What still limits the grades

No independent human study, actual iPhone test, calibrated electronic timing
validation, measured human correction time, observed training decision or
voluntary next-session return has been completed. The new automatic results
remain weak. Loosening acceptance guards or reporting agent grades as accuracy
would not resolve those gaps.

The next evidence-bearing work is the existing
[independent study](independent-study.md): 30–50 distinct real attempts across
phones, climbers, lanes and gyms, two blinded human labels, whole sessions or
climbers held out, and separate reporting of endpoint uncertainty, false
acceptances, automatic coverage, human correction time and the decision made.
Prefer supported fixed full-wall recordings with observable cues and permission
to retain them. Keep a fresh group untouched until the candidate is frozen.
