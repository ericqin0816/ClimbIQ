# ClimbIQ detection work haul

The work window was October 24, 2026, 04:35–13:35 UTC (nine hours). All twenty
engineering checkpoints are complete. The closing audit finished after the
reserved deadline, at 13:39:55 UTC; no new detector experiments started after
13:35. The
[machine-readable ledger](../benchmarks/detection-overnight-twenty.json) preserves
each checkpoint's score, scope, failed controls and feedback.

The last functional runtime change is `343c546`; the hosted product uses that
tested build. Final reporting changes only documentation and the ledger. The
released work improves athlete selection,
recorded-cue review and cancellation. Automatic coverage on a fresh run of the
six existing phone recordings is 4/12 endpoints, with one complete pair. Timing
correctness remains unverified for that whole-app cohort.

## Released changes

- `6513a40` keeps guided athlete selection attached to the chosen region and
  fixes motion-candidate selection that could discard a later usable candidate.
- `f3f11fb` refreshes the affected Undici lock entry. The current production
  dependency audit reports zero vulnerabilities.
- The manual audio review path finds a bounded recorded cue and moves the review
  cursor. It preserves automatic candidates and accepted timing. Explicit manual
  acceptance records that the suggestion was unverified.
- Manual review remains available after analysis and after accepting Start.
  Cancellation also works while its analysis module is still loading.
- `343c546` lets automatic audio analysis stop waiting for a file read or decoder
  result when cancelled. An older cancelled result cannot replace a newer run or
  recording. Both audio paths use the same abort mechanism; detection calculations
  and acceptance thresholds stay unchanged.

## What the current measurements show

| Measure | Result | Limits |
| --- | --- | --- |
| Fresh original-phone workflows | 6/6 completed | Existing development clips, desktop Chrome, timing-only scope |
| Automatically accepted endpoints | 4/12: three Starts, one Finish | Acceptance coverage, not verified accuracy |
| Complete automatic pairs | 1/6 | Eight endpoint slots still need review or remain unavailable |
| Analysis time | Median 12.35 s; range 4.93–18.49 s | Desktop run only; no speed-improvement or iPhone claim |
| Prior primary acoustic component check | 2/3 matching recorded-cue references | Development references; recorded sound is distinct from official electronic Start |
| Explicit secondary audio navigation | 1/1 exposed reference, 10.450 s | Unaccepted navigation suggestion; signed interval [-0.04,+0.04] s |
| P07 Finish recovery | 0/1 | The observed failure remains in the denominator |
| Gray-to-green lamp recovery | 0/1 | Generic lamp component; Finish/Start/lane role is unknown |

The fresh acceptance counts agree with the historical 4/12 and 1/6 observations.
That agreement is descriptive. Different recorded settings and browser context
prevent a strict paired accuracy or performance comparison. The fresh exports do
not contain `analysisScope`; the protocol instead binds the actual timing-only
control, button state and 0–12 s settings before running analysis.

The extra raw Finish screen is incomplete. The packet contains six coded source
files, 869 native frames and 58 contact sheets. Both frozen partial AI worksheets
cover A–E; F remains unreviewed. Actual
viewed files, prior raw-source exposure and deadline overruns are retained.
This screen supplies no timing references or accuracy credit. Sampled frames
can miss brief events, so an unresolved sample cannot establish event absence.

## Experiments kept out of the release

Finish tracking and color changes remain unreliable under occlusion, camera
motion, exposure changes and nearby objects. Color-only alternatives could switch
to a different physical object. Improving a synthetic color score did not justify
shipping those policies.

Peak-relative audio gates reduced short-pulse suggestions but discarded valid
amplitude-modulated cues. A later floor also discarded faint cues. Those gates
remain rejected. The manual suggestion still needs the user to inspect the
recording; it is not automatic timing evidence.

Graph reuse reduced work in some cases but failed its early-return regression
limit. A second version preserved outputs but added more API and lifetime machinery
than the measured benefit justified; its timing did not run.

An integer-phase resampler prototype reduced one simulated 48 kHz whole-file
case by 80.9%, but three other controls breached their fixed regression limits.
It remains unshipped. Its smaller successor stopped when two byte-identical
baseline copies differed by 11.15 ms / 8.39%. The candidate comparison therefore
never ran. Those results do not establish an adopted speed improvement.

## Verification and qualifications

The release passes 1,215 unit tests, with five expected failures, across 113 files.
Both main CI browser jobs pass 72 workflows. The first branch Chromium run failed
two unchanged comparison playback cases at guarded frame-readiness checks. The
exact failed job passed on one bounded retry without changing code, assertions or
timing limits. The original failures remain recorded; their underlying readiness
variance is unresolved.

Independent local verification passes 18 review/cancellation workflows and a
four-case ownership challenge. The public site passes five software workflows.
These reuse existing authored fixtures and one public recording; they are not
additional independent climbs. All eight source hashes and 43 public asset hashes
match the clean tested build before and after verification.

The build is packaged under Node 22. The tested production artifact was promoted
after the automatic Git deployment finished, avoiding an observed deployment race.
The original checkout's pre-existing styles and progress document remain unchanged.
Private footage, decoded pixels, PCM and experimental weights remain outside Git.

One early athlete-test runner no longer has a recoverable source snapshot. Its
historical hash stays recorded as a provenance gap. Other source snapshots, Git
blobs and newline-normalization contracts were independently checked; the gap is
not silently replaced with current bytes.

## Final assessment

| Agent assessment | Grade | Scope |
| --- | --- | --- |
| Focused reviewed code | 9.0/10 | Weighted 8.96 for the reviewed audio/review/cancellation changes |
| Independent broader code/UI integration | 8.6/10 | Includes resource costs, integration complexity and guarded replay variance |
| Narrow manual workflow practicality | 7.6/10 | Reachability and user control are strong; supported breadth and device validation remain limited |
| Focused delivery | 9.0/10 | Exact tested runtime, CI and public software workflows |
| Generalizable detection evidence | 4.0/10 | Development sources and limited physical references; no held-out human study |
| Field detection accuracy | Not estimated | No qualifying independent field cohort |

The goal of 9+ in every area was not met. The grades use separate scopes and are
not averaged or converted into accuracy percentages. The release receives no
new automatic-accuracy improvement credit; population accuracy change is unknown.
Full-file audio decoding, synchronous DSP cancellation granularity, unverified
native-background behavior and actual iPhone testing remain concerns.

The heartbeat was paused at the end of the window, and the temporary system-awake
helper released its request. The complete chronological working log remains
archived byte-for-byte outside Git; the ledger retains rejected experiments,
partial reviews and provenance qualifications.

The next accuracy step is the planned 30–50 original-attempt study, with two human
reviewers labeling independently before predictions and whole climbers or sessions
held out. It must report endpoint error, false acceptance, automatic coverage and
correction time separately. Actual iPhone latency, memory, interruption behavior
and repeat use by climbers remain unmeasured.
