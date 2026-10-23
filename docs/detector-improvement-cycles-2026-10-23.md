# Ten detector improvement cycles — October 22–23, 2026

Status: running. The requested priority is Start/Finish detection, followed by
contact/tracking where evidence supports a change. Each cycle tests a concrete
hypothesis, reviews the result with agents, and keeps or rejects the change.
This improves detector code; it does not retrain the pretrained pose model.

## Fixed measurements

The existing private phone and cached public recordings are development data.
New whole athlete/source groups are reserved before predictions are seen. A
later check on those groups is a code evaluation, not a recruited independent
human study. Coarse visual departure windows are not electronic Start labels.
Downloaded media and detailed private reports stay outside Git.

The production baseline is a preserved clean build of `f5d9a14`, whose application
code matches task starting commit `90f645c`. Both use version 0.30.0. Local
installed Chrome 156.0.8078.47 runs timing-only analysis in isolated storage.
The actual workflow runner is [detector-workflow.mjs](../e2e/detector-workflow.mjs).

| Fixed development clip | First useful terminal state | Automatic endpoints |
| --- | ---: | ---: |
| Existing phone `12.24.mov` | 6.244 s, accepted total | 2/2 |
| Edinburgh requested source range 3160–3188 | 14.736 s, review | 0/2 |
| Edinburgh requested source range 4103–4128 | 12.671 s, review | 0/2 |
| Jakarta panning, acquired file without audio | 13.607 s, review | 0/2 |

These are the contemporaneous baseline, not the earlier browser/instrumentation
timings. In particular, the previous 43-second Jakarta observation must not be
used to claim an improvement to this new 13.607-second baseline. Sampling and
browser variance are checked with repeated final comparisons.

Scores remain separate:

- **Coverage proxy:** accepted automatic Start/Finish endpoints / eight fixed
  endpoints × 10. Baseline 2.5/10. This is not accuracy; exact independent error
  and conditional precision remain unavailable without qualifying labels.
- **Relative workflow speed:** baseline 5/10; `clamp(5 + 5 × log2(baseline median /
  candidate median), 0, 10)`. A 2× latency reduction earns 10 on this engineering
  reference. Raw per-clip latencies and accepted/review/error states remain
  visible. A review result is not counted as an accepted total.
- **Known-case guard adherence:** rejection of the evaluated known-invalid cues;
  provisional baseline 10/10. This is not a population false-acceptance rate.
  Existing camera-cut, lane identity, uncertainty, and official-time checks stay.
- **Evidence strength:** initially 5.5/10, separate from software changes.
  Unit-test counts and faster arithmetic do not establish detection accuracy.

## Cycle ledger

| Cycle | Focus | Status / evidence |
| --- | --- | --- |
| 1 | Repeated audio spectral calculations | Exact same-PCM parity on three real files; cumulative production outputs preserved |
| 2 | Repeated upper-Finish scan invariants | Exact full-result parity on 24 actual-pixel configurations; cumulative production outputs preserved |
| 3 | ROI sampling allocation and pixel parity | 18 native ROI pairs and four transparency/resizing controls byte-identical; repeated canvas allocation removed |
| 4 | Start review-cursor evidence | Artifact ranking corrected; exact audio priority and automatic safety independently checked |
| 5 | Upper-Finish cue quality | Independently reviewed conservative confidence cap; original candidate ranking retained |
| 6 | Sampling UI overhead and reserved-source check | Native seeks unchanged; React commits reduced; Start/Finish cancellation restoration passed |
| 7 | Start windows beginning in a previous blue state | Later valid green departure recovered in controls; existing real ROI results identical |
| 8 | Exposure compensation experiment | Rejected after real-pixel counterexample; safeguards retained |
| 9 | Contact timing provenance | Independently reviewed source-time correction; actual replay decisions preserved |
| 10 | Acoustic onset bias and reserved-source evaluation | Point refinement rejected after counterexamples; honest analysis-window metadata retained; final source check pending |

## Cycle 1: audio transform reuse

A single bounded spectral-basis cache avoids repeated Hann-window and
sine/cosine evaluation for identical audio transforms. Input samples, thresholds,
protocol checks and summation order stay unchanged; unusually large transforms
use the original direct calculation. Maximum basis storage is approximately
2 MiB plus a small window, with only one shape retained.

Native Chrome decoded each of three real files once at 8 kHz. Both versions
processed identical first-12-second PCM samples in Node 22. Full clock, hint,
confidence, reason and tone-segment results matched exactly. Analyzer CPU medians
were 284.41→40.40 ms, 217.42→32.01 ms and 218.75→31.53 ms. This is an analyzer-only
reduction, not a claim that the app is seven times faster. Fifty-eight focused
positive/negative/reference tests and type checking passed.

## Cycle 2: invariant upper-scan arithmetic

Frame-wide exposure distances now compute once per frame, and the baseline
distance median once per patch. Thresholds, candidate selection, confidence and
Finish acceptance gates are unchanged. Full discovery objects matched for three
real frame sets × four lane hints × with/without expected-Finish context.

Same-process interleaved helper medians after warm-up were 29.636→25.772 ms,
50.950→44.299 ms and 41.631→34.983 ms (13–16%, only about 4–7 ms per call). These
use the conventional average of the two central samples. Fifty-nine
focused Finish/pipeline tests passed. An earlier all-transitions-rejected shortcut
was rejected because these actual recordings had eligible transitions; it offered
no demonstrated benefit. Faster helper arithmetic is not greater event accuracy.

The clean cumulative Cycle 2 production build returned the same accepted/review
outcomes and two accepted endpoints across the fixed four clips. Terminal times
were 4.876 / 13.223 / 12.201 / 13.164 seconds; median 12.683 seconds versus the
13.139-second baseline. The resulting provisional speed grade is 5.255/10,
coverage 2.5/10, known-case guards 10/10, evidence strength 5.5/10. A single pass
does not establish a repeatable per-change workflow speedup. The full check
passed 972 tests, types, production build and server checks.

## Cycle 3: bounded ROI capture surface

Each video decoder now reuses one private crop canvas, with exact resizing and a
clear before every draw. ImageData remains a fresh snapshot. Weak ownership
allows the surface to be collected with the video; no frame or URL is cached.
Eighteen actual native ROI pairs on two files were byte-identical. Four controls
also preserved transparent frames, resizing and cross-video isolation. Warm
24-readback loops allocated zero new canvases versus 24 previously. Isolated
readback improvement was modest and variable (about 4.2% median paired reduction
in the first run); this earns no separate whole-workflow speed credit.

The reproducible driver is [sampling-performance.mjs](../e2e/sampling-performance.mjs).
Eighteen focused tests passed, and an independent agent found no actionable
defect. Coverage and known-case acceptance behavior are unchanged.

## Cycle 4: rejected Start evidence cannot choose the review event

A rejected camera-cut cue previously dominated an Edinburgh review cursor.
Eligible evidence now determines an alternative review event; switching events
always remains review-only. An original eligible High protocol-audio cluster
retains priority, including when several exact-audio clusters are supplied.
The example cursor moved 5.433→6.467 seconds; neither is a verified true Start.

Fifty-eight focused tests passed. A 20,000-case differential audit found zero
new automatic acceptances, zero lost accepted exact-audio events, and all 5,005
artifact-free inputs unchanged. Sixty-eight artifact-driven switches lost
automatic status intentionally. This improves correction guidance, not measured
endpoint accuracy or automatic coverage.

## Cycle 5: retain uncertain Finish proposals without promoting them

A patch changing to the same appearance as its surroundings can be an object
moving away rather than an electronic light. Such upper proposals now stay Low.
Their score, time, zone and ordering are preserved: rejecting and re-ranking
them had merely exposed a different suspect patch. They return review-only
before a tight crop or agreeing official total can manufacture higher confidence.

All 24 actual-pixel configurations preserved selection and calibration. A real
Edinburgh red/green timer pixel control remains High. Its frames were repeated
to isolate the spatial gate, so this is not continuous-video recall evidence.
Some other patches can still pass localization. A weak chromatic change plus
uniform exposure shift remains a miss in both versions. Seventy-six focused
tests and types passed; independent review found no scoped regression. Coverage
and exact endpoint error have not improved on the fixed development set.

## Cycle 6: reduce sampling-driven screen work

Automatic decoder seeks no longer publish the hidden review cursor on every
frame. The source-guarded restoration callback synchronizes the actual cursor and
paused-frame readiness after success, cancellation or failure. Native seeks,
pixels, detector progress and manual review remain active.

On phone/Jakarta, production React commit counts fell 484→168 and 520→147.
Native time/seek events stayed exactly 314/374; raw-time display mutations fell
314→0 and 374→1. These instrumented counts establish reduced screen work, not a
standalone latency claim. Start and Finish cancellation both restored 2.500s,
retained accepted markers, blocked replacement and settled without stale writes.
The clean cumulative Cycle 7 check passed 996 tests, types, build and server checks.

The cumulative Cycle 5 production pass returned 4.620 / 14.140 / 13.004 / 13.364
seconds, median 13.184 versus baseline 13.139 seconds (provisional speed grade
4.975/10). Coverage remained two of eight. This replaces the earlier favorable
single-pass speed estimate as the latest observation; repeated final comparisons
are needed before claiming an app-wide latency gain.

The previously reserved H06 whole athlete/source group was released. Both
baseline and cumulative Cycle 5 accepted Start at 2.070s, 15–30 ms early against
the two-agent recorded-acoustic bracket 2.085–2.100s. This is not an electronic
trigger error measurement. Finish was unobservable to the reviewers and unset
in the app. Both workflows stopped during the final lower-Finish seek: container
duration 13.328254s, cursor 13.270s, native frame 13.200s with 0.033333s duration.
The stale-frame guard correctly refused those pixels. This tail-range failure
remains unresolved; the group becomes development after this inspection.

## Cycle 7: an incomplete initial blue run cannot hide a later Start

The departure helper formerly stopped after the first durable blue run even
when the window began blue and had no preceding green baseline. It now considers
later run starts until the earliest fully verified green departure. Existing
chromatic, persistence, reset and camera-cut checks remain. Eighty-two focused
tests passed. All 2,456 prior detections in 4,000 seeded controls stayed exact;
1,544 constructed initial-blue sequences recovered. These are controlled helper
cases, not additional real attempts or population recall.

Two native ROI windows from the existing phone (121 and 31 samples) returned
identical original/candidate results. Independent review found no scoped defect.
No observed real-video coverage gain is credited.

## Cycle 8: reject unsafe exposure compensation

Replacing subtraction of RGB-distance magnitudes with a vector residual
recovered weak synthetic changes under exposure shifts. Four real timer-pixel
spatial controls also survived. However, whole-frame RGB change in panning
footage represents scene composition as well as exposure. On perturbed actual
Jakarta pixels the variant changed a preferred Low 4.2s cue to a different High
4.4s patch. Seven of 24 actual-pixel configurations changed cursor, zone or
confidence. This was a coarse-helper regression, not demonstrated final false
acceptance. An initial fixture-coordinate error was corrected and retained in
the local evidence. Independent review supported rejecting the variant; no
runtime change or performance/accuracy gain is credited for this cycle.

## Cycle 9: contact calculations use the clock of their pixels

Contact deduplication already recognized native frames, but dwell, speed and
onset still used later seek cursors. A private working copy now uses sanitized
source PTS consistently, including attempt boundaries. Saved input and original
cursor provenance remain intact. Missing or invalid PTS keeps the legacy fallback.

Sixty-three focused tests and types passed; an independent 105-test cross-check
also passed. On one actual cached phone attempt with 62 pose samples, replaying
20 hold-target queries preserved every detection/confidence decision. An existing
Hold 14 estimate moved 18.797→18.791s. These are 20 queries on one attempt, not 20
independent attempts. An initial assumption of a 20ms Hold 10 correction was
retracted after inspecting that exact sample: its PTS and cursor are both 15.000s.
No newly detected contact or independently verified contact accuracy is claimed.

## Cycle 10: reject an unsupported audio point estimate

Ninety-six generated exact-protocol waveforms exposed a 5–17ms early leading
window timestamp, averaging 12.917ms before known PCM insertion. A proposed
local-energy refiner reduced this constructed set's mean absolute error to
7.563ms and abstained on slow attacks. Independent agents then found two
counterexamples: an unrelated leading pulse could receive a false resolved-onset
label, and a quiet same-pitch lead followed by a loud step could move a previously
1ms-early clock to 10ms late. Fourteen of 160 additional quiet-lead controls
worsened insertion error by over 3ms. These are PCM insertion controls, not
electronic timing measurements.

The timing refinement was rejected rather than tuned to those cases. Original
clocks, pitch qualification, confidence, sequence and fallback behavior remain.
High-protocol diagnostics now expose their actual analysis-window support
(20ms at 8kHz), hop (10ms) and `isEventAccuracyBound: false`. The rejected helper
is absent from the runtime. The prototype's favorable error reduction is not a
shipped improvement. Current-analysis exports retain the window provenance;
the existing color-only fused observation-interval contract stays conservative.

## Additional restoration review

An agent found that readiness was published just before resuming prior playback.
It now publishes after the playback request settles, including denial, guarded
against source replacement. Tests cover playing-origin success, work failure and
play denial. The actual H06 failure path also restored a paused, non-seeking
0.000s cursor and matching display. The underlying tail sampling failure remains.

## Public source provenance

H06 comes from [NEW JR AMERICAN RECORD 6.22 - NOAH BRATSCHI](https://www.youtube.com/watch?v=KxhPIrlUJfs)
(MD Climbing, 2019-07-31). The local file SHA256 is
`ae2260a80ba4de363bdb53cfedbf36b14ae778ced2427e96906bc63431292f94`.
The frozen pre-prediction reference SHA256 is
`c669867550600165cd3bbb97d782c8a0198ed14a39d624051fdfd386efe699ec`.

H11 comes from [IFSC Europe Continental Cup Speed - Innsbruck 2022](https://www.youtube.com/watch?v=ob8BTtV1uY8)
(Austria Climbing, 2022-06-21), a separate event/athlete group. Its continuous
11-second live-ascent derivative excludes later replay and interview. SHA256 is
`41b1a38a80570b893b9dfcabee9566217b18536f4384de20890ef5071c5e42cf`;
the frozen two-agent reference SHA256 is
`261b65f83bfef556c9708ce4c3de56a881fe563bda343fea2a250a5d873d53b0`.
Recorded-cue brackets combine conservatively to 2.65–2.80s, apparent left-lane pad
contact to 8.08–8.24s. Source speed, acoustic propagation, source A/V alignment and
electronic trigger timing are uncalibrated. These are rough source observations,
not human independent validation or precise electronic labels. Media stays out
of Git. H11 remains reserved until the final candidate is frozen.

Local detailed evidence currently lives under ignored `test-results/detector-ten/`,
`test-results/detection-cycles/`, and `test-results/finish-cycles/`.
