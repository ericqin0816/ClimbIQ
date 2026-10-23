# Ten detection refinement rounds — October 23, 2026

This third set of ten agent-assisted rounds strengthened Start verification,
paused athlete-specific analysis when lane cues disagree, and made the recovery
path work with a direct action and keyboard controls. General endpoint accuracy
and a processing-speed improvement remain unestablished. These are ten distinct
review/test decisions, not ten independent field studies or model-weight training.

Baseline: `3db861ee97902b2ccee279750d5cbbe479d9a2c7`.
The fresh-source predictor was frozen at `b65414e`; final native UI verification
used clean `8102b51`. Subsequent changes clarify interface copy, publish this
report, and correct timing assumptions in delivery tests. The [machine-readable summary](../benchmarks/detection-refinement-2026-10-23.json)
retains build identities, source hashes, artifact hashes, rubrics, and denominators.
Raw reports and private/downloaded footage remain outside Git.

## Per-round scores and feedback

The two numerical columns use the same fixed product-practicality and
evidence-strength rubrics throughout. Each has five components worth two points.
Product components cover purpose, first useful result, defensible training
decision, review/identity, and continuity. Evidence components cover traceability,
observable endpoints, target capture, independent label precision, and diversity.
These judgments are not timing-accuracy percentages. Retained scores indicate a
rejected approach or no new evidence, rather than a new successful video batch.

| Round | Test and decision | Practicality /10 | Evidence /10 | Feedback carried forward |
| --- | --- | ---: | ---: | --- |
| 1 | Freeze six existing phone recordings: 5/12 automatic endpoints, two complete automatic totals. | 7.8 | 5.9 | Preserve accepted outputs, abstentions, source clocks, and latency before editing. |
| 2 | Qualify six encoding/exposure/scale conditions of one attempt: 11/12 endpoints. Darkening loses Finish. | 7.8 | 5.9 | Investigate cue identity and clock mapping; copies do not add independent attempts. |
| 3 | Require chromatic support throughout Start verification. An intermediate candidate adds an invalid 8.835 s shoe cue: 6/12 phone endpoints. | 7.3 | 5.9 | Reject the apparent coverage gain and inspect the preceding color state. |
| 4 | Reject denser Finish parity: no new real candidate across 36 configurations, but three new High proposals on a constructed flat cut. | 7.3 | 5.9 | Preserve Finish gates; candidate count alone cannot justify release. |
| 5 | Reject both quantization proposals against registered development criteria. Neither is released or advanced to the evaluation split. | 7.3 | 5.9 | Keep the known quantization limitations explicit instead of tuning to this corpus. |
| 6 | Require observed before-like frames. Remove the intermediate shoe acceptance: phone coverage returns to 5/12, conditions remain 11/12. | 7.6 | 5.9 | RGB history still cannot certify that a cue is stationary timing hardware. |
| 7 | Check the full lane-candidate pool before Finish selection. Ambiguous lanes keep shared Start and pause Finish/movement/tracking: phones 4/12, conditions 6/12. | 7.7 | 5.9 | Resolve athlete intent explicitly, and bind evidence to its source. |
| 8 | Pass ten actual native workflow stages, including selected-left full analysis and clearing populated movement/Finish/COM after reselection. | 7.8 | 5.9 | Make climber selection easier to reach, and preserve first-test source evaluation. |
| 9 | Two fresh public clips in one reserved event/uploader group: default 0/4 automatic endpoints; separate guided development runs also 0/4. | 7.7 | 6.0 | Keep original failures; no compatible endpoint error can be scored. |
| 10 | Pass nine actual native shortcut/keyboard/lifecycle stages. Reproduce and fix the manual-Finish action remaining on Select climber; all 52 Chromium production workflows pass. | 8.0 | 6.0 | Measure independent human timing labels, correction effort, and training decisions next. |

## What changed in detection

Start verification now uses chromatic evidence for both the confirming run and
the departure from the preceding state. It also requires that preceding frames
actually support the calibrated before state. The existing numeric chromatic
thresholds were retained. Among 90 resolved constructed exposure/faint-color
controls, timely localization improves from 32 to 90. The full 96-case set also
contains two abstentions and four known quantization failures. A separate
entering-blue-object control remains an expected failure. All 80 selected
no-event/red/exposure/single-frame
controls reject, which does not establish a general foreground-object rejection
rate or real-climber accuracy.

The deployed baseline already rejected the shoe cue. The new shoe acceptance
appeared only in the intermediate round 3 experiment and was removed before
shipping. This is a caught regression, not a newly fixed deployed failure.
IMG_9199's automatic Start changes from 7.121 to 7.068 s, with its diffuse floor
cue still unverified. Historical accepted timestamps are regression anchors,
not ground truth.

Finish selection now checks incompatible athlete regions across the full
candidate pool before the existing scan budget is applied. Scores and a shared
clock cannot choose between conflicting lanes. Lane evidence is bound to the
current recording, accepted Start, and selected body region. Replacing or
deleting the athlete selection clears dependent annotations and tracking while
preserving the shared Start and attempt identity. Reopened automatic regions
require fresh discovery before a new automatic Finish.

This deliberately reduces unattended complete totals from two to one among the
six development recordings. Explicit left-climber selection on the existing
12.24 recording restores an operational Start of 9.400 s, Finish of 21.655 s,
and total of 12.255 s. These clocks are not independently labeled endpoint truth.

## Actual recovery and source ownership

Round 8's full selected-left run yields first movement at 9.567 s and 62 requested
COM frames, with 32 usable. Tracking remains **Needs review** and Hold 10 is unset.
Changing to the right selection clears actual populated movement, Finish, and
COM. It preserves source bytes and attempt identity. Nonempty real Hold 10 and
first-hold clearing were not demonstrated; seeded policy tests cover those fields.

Round 10 checks the direct **Select climber** action on the actual recording.
It captures native PTS 9.380 s with duration 0.033333 s at the 9.400 s cursor,
and the captured pixels match the paused video. Real Tab navigation enters four
edges and Enter applies the region. Reselection, deletion, save/reload, explicit
reattachment, and stale-evidence rejection pass without page or CSP errors.
This timing-only run does not repeat round 8's full motion evidence.

The selected timing run takes 7.962 s in automation; round 8's timing/full runs
take 8.979/23.098 s. These are scripted analysis durations, not human correction
times. Two earlier harness failures remain recorded: CSP correctly blocked a
blob fetch, and a locator omitted a collapsed control. The successful runner
uses native source observations and preserves the production CSP.

## Fresh public-video results and reference limits

The source clips are [n01](https://www.youtube.com/watch?v=RZjqLg426RQ) and
[n02](https://www.youtube.com/watch?v=BFATGS7y3Cs). Both belong to one conservative
2013 Imst event/uploader group, rather than two independent source groups or
certified distinct athletes. Public availability does not grant redistribution
rights; no downloaded footage is committed.

Separate AI-agent observation worksheets and the joint protocol were frozen
before predictions. Observers shared broad, unannotated extraction windows but
did not see each other's labels before freezing their own. They resolve only
n01's apparent screen-right first hand/pad contact, within 35.10–35.30 s. This is
not a light reversal or an electronic trigger. Matching Start truth is unresolved
in both clips; n02's first Finish is off frame.

The original default 0–12 s search runs accepted **0/4 endpoints**. Both Starts
need review and neither Finish ran. After retaining these primaries, the entire
group became development data. Separately predeclared guided windows, 23–27 s
for n01 and 4–8 s for n02, also accepted **0/4**. Later races cannot replace the
primary denominator. These are observed workflow failures on these recordings,
not a population false-negative estimate. Compatible endpoint error and candidate
localization are **N/A**, not zero. The predictor did not change after these runs.

## Performance and robustness limits

The six-phone median first terminal state is 12,038.683 ms at baseline,
13,656.605 ms in round 3, 12,632.779 ms in round 6, and 12,165.477 ms in round 7.
The separate six-condition, one-attempt medians are 9,631.229, 11,703.195,
12,078.583, and 3,349.110 ms. Round 7 skips ambiguous Finish work. A faster
review terminal after doing less work does not demonstrate higher detector
throughput. These single passes do not establish a repeated processing gain.

The robustness copies do not add climbs. Strict whole-container clock
qualification failed before predictions because the last AAC packet differs by
one 44.1 kHz sample. A prospectively frozen replacement qualifies only the
unchanged interior 0–24 s: video PTS, audio packet times/payloads, and decoded
PCM match. It makes no claim of full-container equality.

## Independent closing review

A separate reviewer froze its own rubric before seeing earlier numerical grades.
It assesses convincing intended-use evidence at 10, strong usability with
material unverified behavior around 8, and constrained promise around 6.
Its scores are preserved separately from the ten-round rubric and are not averaged.

| Area | Before final fixes | Final /10 | Remaining limitation |
| --- | ---: | ---: | --- |
| Product practicality | 7.0 | 7.2 | Human correction effort, training decisions, and return use are unmeasured. |
| UI/workflow | 7.5 | 7.8 | Actual recovery is verified, but setup remains involved and has no recruited-user study. |
| Project/code quality | 7.8 | 7.8 | Strong tests and ownership checks; substantial state coordination remains in App.tsx. |
| Detection-evidence strength | 4.5 | 4.5 | No calibrated independent endpoint accuracy or representative false-acceptance estimate. |

The reviewer verified the manual-Finish failing-before/passing-after regression,
native frame/keyboard evidence, and final local checks. It found no remaining
blocking defect in the reviewed changes. That finding is bounded by the tested
paths and available evidence.

## Verification and next evaluation

At clean `8102b51`, typecheck, build, coaching-server compilation/smoke checks,
and 1,131 tests pass across 107 files, with five explicitly expected failures
retaining known detector limitations. All 52 Chromium desktop/phone production
workflows pass. The original dual-lane fixture is CC0 geometric animation/audio;
it tests workflow, not field accuracy. The exact pushed commit is checked by
[GitHub CI](https://github.com/ericqin0816/ClimbIQ/actions/workflows/ci.yml), including
Chromium and macOS WebKit media workflows. Phone viewports are not actual iPhones.

The first pushed commit, `f182abd`, passed verification and all 52 Chromium CI
workflows. Its macOS suite passed 49 and failed three. Both new recovery failures
asserted the final action after 12 seconds while the trace still showed analysis
running. The test now waits for bounded analysis completion before requiring the
same exact lane-review result and remaining checks. The replay failure observed
a legitimate owned synchronization pause between remote assertions; its test
now checks stale-promise settlement directly and separately requires real
playback progress and background pausing. These follow-ups change tests, not
runtime detector or replay gates. The [initial failed CI run](https://github.com/ericqin0816/ClimbIQ/actions/runs/40011894861)
and its downloaded traces are retained. Targeted Chromium checks pass four
recovery cases and six repeated stale-replay cases; the closing commit receives
the full CI suite again. The original native reports and fresh-source denominators remain
unchanged.

The next useful detection work needs 30–50 supported, distinct attempts with two
prediction-blind human reviewers, whole-session/climber holdouts, and matching
physical event/lane definitions. Report endpoint error, false acceptance,
automatic coverage, correction time, and return use separately. There is still
no recruited human study, calibrated electronic timing accuracy, population
false-acceptance rate, actual iPhone field validation, or demonstrated training
benefit. The [independent-study workflow](independent-study.md) provides the
collection and adjudication process.

## Follow-up: recorded-beep localization recovery

The ten-round results above are archived unchanged. After the reported detection
regression, a separate targeted investigation found that arithmetic stereo
mixing obscures the final countdown tone in `IMG_9075`. Both original channels
pass the existing strict countdown detector at 8.590 and 8.620 seconds, while
the mix produces a Medium review candidate at 7.230 seconds. The measured
cancellation is local to the final-tone frequency band; the entire recording
is not phase-inverted.

The recovery retains the mixed detector and all its numeric thresholds. It
applies only when an inconclusive stereo mix has two complete High original-channel
protocols with compatible pitches and observed supports. It keeps the earliest
original clock and one audio evidence item. The export retains both observations
and the original mixed result. Nominal feature windows and their envelope are
explicitly not event-accuracy bounds. High audio also cannot promote a weak
color patch into a verified light region or Finish sensor.

Two prediction-blind AI observers independently inspected the decoded source
audio before seeing either predictions or each other's labels. Their frozen
onset brackets have union 8.580–8.625 seconds. The new 8.590-second review cursor
has signed disagreement −35 to +10 ms with that bracket; the old 7.230-second
cursor has disagreement −1395 to −1350 ms. The investigator already knew the
candidate clocks and selected this development recording. These observations
are not recruited human labels, electronic timing accuracy, calibrated A/V
alignment, or an unbiased held-out evaluation.

Fresh native whole-app runs on clean builds `f86f5ae` and `320733c` preserve all
six source hashes and every accepted timestamp: **4/12 endpoints and 1/6 complete
pairs before and after**, with no page or policy errors. The recorded-beep
localization improves, but the app still requires review on this source. There
is no verified athlete region, so fallback body motion cannot authorize Start;
the scene-continuity check also rejects the proposed timestamp. Its displayed
reason masks the separate body-audit failure. Neither gate was weakened to
increase acceptance counts. The exact scene comparison frames remain
unadjudicated, so a foreground obstruction is not treated as proven continuity.

The regression suite includes a new original CC0 encoded stereo fixture whose
final tone cancels in the mix. Native Chromium recovers one audio item at an
original channel clock and leaves Finish unset. All 54 Chromium desktop/phone
production workflows pass, along with typecheck, build, coaching smoke checks,
and 1,147 unit tests across 108 files; five known expected failures remain.
macOS WebKit receives the same native-codec test in GitHub CI. Phone viewports
are not actual iPhone validation. The detailed
[recovery summary](../benchmarks/stereo-start-recovery-2026-10-23.json) preserves
the unchanged automatic denominator, source hashes, reference intervals,
reviewer assessments and raw sidecar evidence hashes. Private footage and PCM
remain outside Git. No model weights were trained and no general accuracy or
processing-speed improvement is established by these development runs.

## Ten further detection experiments

The [detection expansion ledger](../benchmarks/detection-expansion-2026-10-23.json)
records ten additional experiments, their frozen criteria, failures, scores and
evidence hashes. These use six existing phone recordings and one previously
inspected public YouTube source, P07. Crops, frames, generated controls and audio
transformations are correlated diagnostics, not new independent attempts. Two
additional World Climbing broadcasts were identified as research prospects;
neither was qualified or tested as a fresh holdout.

| Round | Experiment | Observed result | Scoped score |
| --- | --- | --- | --- |
| 1 | Whole-frame pose model | No correct wall-figure proposal in four inspected frames; two proposals had torso centers outside the image. | 0/4 center proposals |
| 2 | Cropped pose and fixed-grid search | Fixed grid placed centers on the wall figure in 4/4 frames and abstained on the two-climber control. This did not establish accurate anatomy. | 10/10 for center agreement on four known frames |
| 3 | Adjacent-frame scene matching | Accepted three generated dissolves incorrectly. Rejected for production. | No endpoint score |
| 4 | Persistent original background features | Rejected generated cuts/dissolves but could not qualify the phone recording. Offline ORB/SIFT also showed that shared background cannot prove continuous capture. | No endpoint score |
| 5 | Native launch audit and HEAVY model | Derived body region failed launch verification. HEAVY lost early-frame eligibility and increased model size and runtime. Neither recovery shipped. | 0/1 launch qualification |
| 6 | Audio gain and noise | Five gain conditions localized the recorded cue; three noise conditions did not. | 6.25/10, 5/8 correlated conditions |
| 7 | Channel balance and resampling | Found an out-of-band spectral shoulder being labeled as a beep. The spectral fix improves complete registered localization from 4/8 to 5/8; reserved conditions improve 1/4 to 2/4. | 5.0 → 6.25/10 registered; 2.5 → 5.0/10 reserved |
| 8 | Native upper-Finish detector | No candidate on P07 despite explicitly supplied Start and lane. Actual indicator geometry falls outside discovery bounds. | 0/1 conditional localization |
| 9 | Known sensor and temporal isolation | Full planned tracking window failed quality checks. A secondary verified-prefix test proposed 25.692 s, before the matching indicator interval 25.8258–25.9259 s. | 0/1 primary; secondary timing also failed |
| 10 | Clean cumulative native and stress checks | Original six phones retain 4/12 accepted endpoints and one complete pair. P07 default and guided runs accept neither endpoint. | Coverage unchanged; no broad accuracy score |

The shipped audio change searches for actual local spectral maxima, including
neighbors outside the restricted frequency band. A stronger frequency outside
that band can no longer supply its sloping shoulder as the selected peak. It
does not change confidence thresholds, countdown rules, timing tolerances or
stereo clock policy. On the referenceable recording, channel gains 0.5 and the
reserved 0.67 condition improve from an early High-confidence 8.410-second
marker to 8.590 seconds, within the frozen recorded-cue bracket 8.580–8.625.
Resampled conditions move to 8.500 seconds: their signed interval of −125 to
−80 ms straddles the 100 ms comparison policy, so they receive no success
credit. The five such rate conditions remain unresolved. Noise robustness also
remains limited. A 50 Hz spectral-bin boundary can still lose an off-grid tone;
the targeted tests do not establish field recall.

The cumulative stress check contains 109 derived or authored conditions, not
109 climbs. Its five labeled negative controls and one positive control pass;
an ambiguous two-protocol case remains explicitly unscored. Eight quiet-attack
controls preserve their clocks, and an earlier genuine mixed-audio countdown
cannot be replaced merely because both individual channels prefer a later one.
Two new spectral tests failed before the change and pass afterward.

The other runtime changes reject off-image torso centers while retaining visible
torso centers with peripheral limbs outside the image, and retain the separate
body-audit result in current-analysis exports. Scene checks, Finish discovery
bounds, launch thresholds and model weights remain unchanged. No experimental
pose recovery, HEAVY model, OpenCV dependency or scene override ships.

At clean runtime commit `c0ce888`, all eight native app runs finish without page
or policy errors. All accepted clocks in the six phone recordings are preserved;
the P07 default and guided runs are two correlated runs of the same public recording.
Typecheck, build, coaching smoke checks and 1,168 unit tests across 109 files
pass, with five pre-existing expected failures. These results do not establish
a representative false-acceptance rate, electronic timing accuracy, actual
iPhone performance, human correction effort or generalization to fresh climbs.

The closing independent review grades code readiness **8.0/10** and
generalizable detection evidence **4.7/10** under separate weighted rubrics.
These are review judgments, not accuracy percentages. A second reviewer grades
code correctness 8.8/10 and evidence of automatic endpoint improvement 2.0/10;
that narrower evidence rubric is not averaged with the first. The ledger retains
both assessments and the unresolved failures. No 9/10 detection claim is supported.
