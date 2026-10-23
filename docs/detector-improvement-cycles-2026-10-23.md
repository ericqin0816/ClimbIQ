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
| 1 | Repeated audio spectral calculations | Exact same-PCM parity on three real files; analyzer CPU improvement measured; cumulative production check pending |
| 2 | Repeated upper-Finish scan invariants | Exact full-result parity on 24 actual-pixel configurations; helper CPU improvement measured; cumulative production check pending |
| 3 | ROI sampling allocation and pixel parity | Hypothesis under test |
| 4 | Start review-cursor evidence | Planned, evidence first |
| 5 | Upper-Finish cue quality | False-looking neutral-wall proposal under investigation; no automatic error asserted |
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

Same-process interleaved helper medians after warm-up were 29.94→25.99 ms,
50.98→44.42 ms and 41.65→35.00 ms (13–16%, only about 4–7 ms per call). Fifty-nine
focused Finish/pipeline tests passed. An earlier all-transitions-rejected shortcut
was rejected because these actual recordings had eligible transitions; it offered
no demonstrated benefit. Faster helper arithmetic is not greater event accuracy.

Local detailed evidence currently lives under ignored `test-results/detector-ten/`,
`test-results/detection-cycles/`, and `test-results/finish-cycles/`.
