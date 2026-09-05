# Real-video benchmark

This benchmark records behavior on five private 1080 × 1920 phone recordings. The source videos stay outside the repository and are processed locally.

## September 5: recovery cadence and complete workflow verification

The September 2 measurements below are retained as the baseline. A controlled experiment on `IMG_9199.MOV` traced the sampling-rate collapse to a recovery schedule driven by raw frame counts: higher sampling rates advanced the search faster in wall-clock time. Search steps now use a common 5 Hz cadence while inference retains the requested rate. The 5 fps schedule is unchanged.

| Sample rate | Previous usable COM | Corrected recovery usable COM |
| --- | ---: | ---: |
| 5 fps | 42/52 (80.8%) | 42/52 (80.8%), unchanged |
| 10 fps | 45/104 (43.3%) | 85/104 (81.7%) |
| 15 fps | 0/156 (0%) | 132/156 (84.6%) |

Both corrected high-rate results were reproduced through Run full analysis → Save Session → Duplicate Session → page reload → comparison. Start remained 7.130 s, Finish 17.480 s, and total 10.350 s. The new `--full` runner fails if accepted timing has no usable COM, saved timestamps change, or identical attempts claim a gain/loss. This reference recording additionally requires at least 65% usable COM coverage in full mode.

A separate hypothesis—replacing stateful video inference with independent image inference on moving crops—was tested and rejected. It produced 0/52, 20/104, and 0/156 usable frames at 5/10/15 fps. The production model remains in VIDEO mode. Machine-readable results are in [tracking-recovery-results.json](benchmarks/tracking-recovery-results.json).

These gains measure internally usable tracking coverage on one recording. They do not establish hand-contact accuracy, correct identity at every frame, or calibrated metre/m/s accuracy. The app still labels this run Needs review, and route registration still does not accept Hold 10 automatically.

Comparison now shares the main analysis's timing/athlete freshness check, validates calibration, withholds stale tracking badges, and leads with the overall result. Small differences use explicit conservative display thresholds rather than the previous 5 ms cutoff; these are not measured error bounds. Regression tests also cover JSON save/reload, corrected timing, direction reversal, legacy Hold 10 proposals, and invariance to raw-time origin shifts. Time-shift tests operate on session data, not re-encoded videos.

## What the clips exposed

- Angled cameras can separate the apparent bottom-sensor and top-indicator x positions.
- A valid-looking beep/light event can occur after an athlete is already climbing.
- Ropes, hair, faces close to the phone, scoreboards, and post-climb timing resets can resemble finish evidence.
- A missing finish must not make pose analysis include setup footage or descent.

## Regression results

| Clip | Previous behavior | Current behavior |
| --- | --- | --- |
| `IMG_8903.MOV` | Plausible start, but no finish | Start launch confirmed; upper-wall fallback recovers a finish candidate around a 10.0 s climb |
| `IMG_9075.MOV` | Incorrect 14.900 s start was automatically accepted mid-climb | The 12 s start window excludes that later reset; an earlier 8.450 s cue remains review-only, while the reviewed exact start is 8.900 s |
| `IMG_9076.MOV` | 24.820 s post-climb frame suggested as start | The late event is excluded; an earlier 2.790 s setup cue remains safely review-only |
| `IMG_9077.MOV` | Incorrect 5.250 s start was automatically accepted while athletes were already underway | Start is blocked for review |
| `IMG_9199.MOV` | Plausible 7.130 s start and 10.350 s total | Valid result remains stable; existing lane-light finish path still wins |

## Current measured baseline

The September 2 evaluation reran every clip from a fresh page using the production workflow rather than calling detector helpers directly.

The same `IMG_9199.MOV` workflow was also rerun against the public production deployment. It reproduced the local result exactly: Start 7.130 s, first movement 7.230 s (0.100 s reaction), Finish 17.480 s, total 10.350 s, and 42/52 usable COM frames.

| Measurement | Result |
| --- | --- |
| Videos evaluated | 5 |
| Starts automatically accepted | 2 |
| Known false starts automatically accepted | 0 |
| Reviewed automatic-start precision | 2/2 in this sample; 95% Wilson interval 34.2%–100% |
| Starts conservatively sent to review | 3 |
| Accepted-start clips with an automatic High finish | 1/2 |
| Accepted-start clips with a bounded review finish | 1/2 |
| Reviewed automatic-finish precision | 1/1 in this sample; 95% Wilson interval 20.7%–100% |
| 5 fps complete COM run | 42/52 usable frames (80.8%) |
| Repeated 10 fps COM runs | 43–45/104 usable frames (41.3–43.3%) |
| 15 fps complete COM run | 0/156 usable frames (0%) |
| Automatic Hold 10 contacts on the complete COM run | 0 |
| Review-level Hold 10 height candidates | 1 (11.515 s raw / 4.385 s after start) |

This is a precision-first regression sample, not a population accuracy claim. Five related phone recordings are not enough to estimate general accuracy. The next useful dataset should contain labeled start, Hold 10 contact, and finish frames from different phones, gyms, lanes, lighting conditions, and camera angles.

### Next accuracy study

For a defensible college/demo result, collect at least 30–50 unedited fixed-camera attempts and label each Start, first pad release, Hold 10 contact, and Finish using official timing when available plus two independent frame reviewers. Report automatic coverage separately from correctness: acceptance rate, false-accept count, median/95th-percentile timestamp error, Hold 10 agreement, and review/abstention rate. Keep edited broadcasts as a separate stress-test cohort because they measure safe rejection, not the same task as fixed-phone timing.

## Public broadcast stress test

Six short 720p race crops from World Climbing's [Chamonix 2026 speed finals](https://www.youtube.com/watch?v=RvZXoTVxGBs) were also tested locally: three women's attempts and three men's attempts. These are kept in `benchmarks/public-broadcast-results.json` and summarized separately because a moving multi-camera broadcast is a different input class from a fixed phone recording.

- All six start cues remained review-only. They are recorded as unverified rather than mislabeled as confirmed timing errors: broadcast edits and incomplete lane-local evidence make them unsafe automatic ground truth even when an underlying beep may be real.
- No unsafe public start was automatically accepted. The full-frame audit measured 31.0%–79.1% structural change across four proposed cues and labeled them as camera cuts instead of treating the edit as athlete launch motion. One other cue had no reliable lane-local launch.
- The remaining clip exposed a late audio/light cue: the climber was already launching, but the estimated movement timestamp followed the cue by only 0.033 s. The [World Climbing competition rule](https://images.ifsc-climbing.org/ifsc/image/private/t_q_good/prd/jaq7awz9jmqwpddwnbpr.pdf) defining sub-0.100 s reactions as false starts is now a conservative automatic-acceptance floor, so this candidate is review-only too.
- As a downstream safety stress test, the unverified 8.817 s men’s cursor was manually continued without promoting it to ground truth. Neither the lower lane light nor the angled upper search verified a Finish, and pose analysis stayed paused; the app did not manufacture a total or scan the descent.
- The women’s source-590 crop was also continued with its known 6.20 s winning time. Official time supplied a safe analysis boundary but did not create an accepted Finish when neither lower nor upper visual evidence verified one; approximate wall calibration then refused the broadcast framing and requested manual corners.
- Before the camera-reference guard, one mid-wall reframe produced a false 13.983 s physical-finish review boundary, only 3.100 s after Start despite the official winning time being 6.20 s.
- Anchoring physical top tracking to the post-start camera view removed that false boundary. The detector now reports no verified finish for the moving-camera crop instead of supplying an inaccurate time.

| Broadcast crop | Division | Proposed Start | Automatic result | Safety reason |
| --- | --- | ---: | --- | --- |
| Source 590 s | Women | 10.783 s | Review only | 31.0% structural frame change |
| Source 702 s | Women | 8.517 s | Review only | 73.9% structural frame change |
| Source 816 s | Women | 6.517 s | Review only | 79.1% structural frame change |
| Source 1552 s | Men | 8.817 s | Review only | 0.033 s measured visual reaction |
| Source 1652 s | Men | 7.908 s | Review only | No reliable lane-local launch |
| Source 1745 s | Men | 1.017 s | Review only | 57.2% structural frame change |

These six proposal times are unverified review cursors, not manually labeled ground truth. The table demonstrates rejection behavior across both divisions; it must not be used to claim start-time error without a separate exact-frame/audio annotation pass.

This stress test supports the current precision-first policy: fixed-camera footage can produce automatic timing and splits, while broadcast camera changes are rejected or sent to review.

The complete `IMG_9199.MOV` run exposed the largest remaining data limitation: timing was stable at 7.130 s → 17.480 s across repeated runs, but visual route registration consistently found only 8 of the 10 matches required by policy, so Hold 10 contact could not be accepted automatically. COM tracking changed sharply with sample rate: 5 fps produced 42/52 usable frames (80.8%) and recovered every wall-height split, 10 fps produced only 43–45/104 (41.3–43.3%), and 15 fps failed identity selection. The measured 5 fps setting is now the phone-video default; 10/15 fps remain advanced options.

With the improved 5 fps track, the review-only hand-height fallback found a continuous crossing at 11.515 s raw (4.385 s after Start). Reviewing and accepting that frame in the UI produced 4.385 s Start → Hold 10 and 5.965 s Hold 10 → Finish: 42.4% of the race before Hold 10 and 57.6% after, with the top phase taking 1.580 s longer. The independent 7.5 m COM-height crossing was 4.409 s, 0.024 s later; they remain separately labeled instead of treating that near-agreement as proof of contact. This remains a human-confirmed workflow rather than an automatic contact claim because Hold 10 itself was not visually registered.

## Acceptance policy

Automatic timestamps are intentionally precision-first:

1. Start light/audio evidence defines the exact clock only after lane-local motion confirms a new launch, the full frame remains continuous across the cue, and the measured reaction is at least the 0.100 s valid-race floor.
2. The original start-verified lower lane remains the athlete-identity anchor.
3. Lower-sensor finish evidence is preferred when it is strong.
4. Upper electronic evidence is accepted only with physical-top or official-time corroboration.
5. Physical-only and ambiguous results are surfaced for exact-frame review.
6. Pose analysis pauses when there is no usable finish boundary, preventing setup/descent contamination.
7. Start search honors the selected absolute video-time window, and finish search stops 30 seconds after Start, preventing later attempts and timing resets from entering a single-race analysis.

## Automated coverage

The test suite includes tiny upper indicators, exposure changes, transient and full-frame occlusions, frame-level transition refinement, physical top reach/descent, missing descent, and automatic-start body-audit cases. Seeded variance coverage adds 60 noisy green-state trials that must not invent a Start, 40 noisy blue transitions that must remain detectable, 80 noisy climb-state trials that must not invent a Finish, and 50 noisy sustained finish reversals that must retain the correct boundary. Run it with `npm test`.

The browser timing runner executes only the five IDs recorded in the benchmark JSON by default, so extra research clips can safely live in the private video directory. Run one new clip without claiming a baseline using:

```bash
npm run benchmark:timing -- new-race-clip.mp4
```
