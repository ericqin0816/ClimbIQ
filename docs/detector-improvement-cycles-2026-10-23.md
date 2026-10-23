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
| 6 | Further measured detector bottleneck | Planned after profiling |
| 7 | Start temporal/identity robustness | Planned after independent review |
| 8 | Finish source-frame robustness | Planned after independent review |
| 9 | Contact/tracking or remaining timing limitation | Evidence will determine scope |
| 10 | Reserved-source evaluation and final refinement | Whole-source checks reserved; not yet run |

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

Local detailed evidence currently lives under ignored `test-results/detector-ten/`,
`test-results/detection-cycles/`, and `test-results/finish-cycles/`.
