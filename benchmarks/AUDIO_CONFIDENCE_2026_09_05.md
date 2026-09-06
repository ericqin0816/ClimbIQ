# Weak preparation tones and false broadcast starts

**Decision: withheld from the live app.** The published detector remains 0.28.6.
This document records an experiment, not a released confidence improvement.

## Reproduced failure

The public Emma Hunt highlight starts shortly before the race and omits most
preparation audio. By source time 7 s, the lane B scoreboard has stopped at
5.99 s and Hunt has finished. Audio-only analysis in 0.28.6 nevertheless calls
a 4.78 / 5.92 / 7.14 s sequence High confidence. Its estimated pitches are
553.8 / 601.3 / 1064.4 Hz; the second preparation fragment has only four
qualified 10 ms-hop frames. The full application refuses this timestamp because
the selected athlete does not begin a new launch afterward.

Source: Simon Tran's [repost credited to World Climbing](https://www.youtube.com/watch?v=66FnK6L6roM).
Only source 0–35 s was downloaded for local testing; media are not committed.
The [USA Climbing event report](https://usaclimbing.org/news/hunt-makes-history-team-usa-takes-four-medals-and-two-world-records-at-world-climbing-series-krakow/)
corroborates Hunt's total, not an exact raw start or pad-contact frame.
SHA256: `599c77deea0dc06d0fbb5c01709c3f3d195e4f82e63f1d4c6b5868dbaf094d54`.

## Experiments and decision

- Tightening the pitch-matching gate used to select a sequence from 8% to 4%
  merely selected another false High cue at 7.84 s. Discarded.
- Also demanding sustained preparation evidence during sequence selection
  removed that false High, but shifted IMG_9077's audio suggestion from 5.25
  to 5.96 s. Discarded as a timestamp-changing shortcut.
- The candidate retains the original earliest-pattern selection, then checks
  stronger confidence eligibility. High requires preparation-pitch disagreement
  no greater than 4%, at least six qualified frames on each preparation tone,
  and at least 80 ms of observed support per preparation tone. Weak evidence
  stays at the original review cursor; a later stronger pattern does not silently
  become Start. A short final cue can remain usable when both preparation tones
  are well supported.

These are conservative confidence policies, not official equipment tolerances
or measured event-accuracy bounds. Qualified analysis windows overlap, so six
frames are not six independent observations. The camera/body checks remain
required; this change does not claim reliable automatic broadcast analysis.

## Targeted observations

| Source | Previous audio result | Candidate audio result |
| --- | --- | --- |
| 12.24.mov | 9.400 s, High | 9.400 s, High |
| IMG_8903.MOV | 4.290 s, High | 4.290 s, High |
| IMG_9075.MOV | 7.230 s, Medium | 7.230 s, Medium |
| IMG_9076.MOV | 2.790 s, Medium | 2.790 s, Medium |
| IMG_9077.MOV | 5.250 s, High | 5.250 s, Medium |
| IMG_9199.MOV | 4.120 s, Medium | 4.120 s, Medium |
| Krakow men's crop | 2.920 s, Low | 2.920 s, Low |
| Hunt highlight | 7.140 s, High | 7.140 s, Medium |

These are audio-only results, not the final fused clock. IMG_9199's accepted
Start, for example, is 7.130 s from other corroborated evidence, not 4.120 s.
Experiments use fresh source-module imports to avoid stale browser research
code after a development hot reload.

`npm run test:audio-browser -- --references` checks ten synthetic browser-codec
scenarios and four checksummed source confidence references. Negative references
limit confidence but do not demand preservation of a known-wrong cursor. All
four source checks pass. Five new synthetic unit cases cover pitch mismatch,
brief preparation, keeping a weak early suggestion, and small pitch-estimation
error with sustained preparation. Total unit suite: 565 passing tests.

## Full-app observations before final regression pass

The first 14-source full run preserved accepted timings and public refusals.
Hunt's fused review suggestion moved from 7.140 s (after the finish) to 0.717 s
near the opening launch; it remains unaccepted and is not an exact onset label.
IMG_9077's fused review cursor moved from 5.250 to 5.400 s when the weak audio
stopped overriding visual evidence. Its audio-only cursor is unchanged.

The first run failed because it pinned that explicitly `reviewedCorrect: false`
private cursor within 40 ms. The failed report is retained. The test policy now
reports changes to explicitly unverified cursors without treating them as target
labels; it still fails automatic acceptance of a review-only start, pins
established private observations, checks accepted boundaries, and applies known
false-event fingerprints. Three policy unit tests cover that distinction.
This is not a timing-correction claim for IMG_9077.

Cancellation after an accepted prior run preserves timing and evidence; rapid
replacement and invalid-file replacement also pass. The Hunt review message is
legible at 390 px width (`test-results/confidence-hunt-mobile-0.28.7.png`).

The fresh 14-source cohort passes with all original accepted timings unchanged.
The experimental unit suite had 568 passing tests. However, the transformed-source
matrix exposed a regression not visible in those original-source checks:

| Derived recording | 0.28.6 | Experiment |
| --- | --- | --- |
| IMG_9076 control-720 Start | 2.850 s accepted | 2.917 s accepted |
| IMG_9076 control-720 Finish | 14.300 s accepted | Unaccepted; late 29.717 s timer-reset review suggestion |
| IMG_9076 compact-360 Start | 2.850 s accepted | Unaccepted |
| IMG_9076 low-fps-720 Start | Unaccepted | 2.950 s accepted, unverified |
| IMG_9076 low-fps-720 Finish | Unaccepted | 14.333 s accepted, unverified |

Demoting the audio cue changes the winning visual lane and which start-verified
lanes remain available to finish detection. Thus a narrowly reasonable confidence
rule has downstream lane/finish consequences. These are not independent labels
proving either old or new timing correct; the changed start is unverified, and
the late reset suggestion is not a useful improvement. The live body/scene guard
already prevents the broadcast false start from being accepted.

The completed 36-case comparison reports two availability losses, two new
unverified acceptances, and one 67 ms timing drift under a 10 ms comparison
policy. The broader 100 ms source-consistency check reports zero timing
regressions, which is not sufficient to clear this experiment. No workflow
crashed; the issue is changed detection behavior. Both runs retain 21 cases
needing investigation under the existing label policy.

The runtime change and its experimental-only assertions were removed after the
matrix completed. App source and version are restored to 0.28.6, with 563 retained
unit tests passing. The complete experimental diff is preserved in
[`experiments/strict-audio-confidence.patch`](experiments/strict-audio-confidence.patch),
based on commit `5b30872`. It is for future investigation, not deployment. Applying
it enables the experimental source-confidence command documented above; that
command is not part of the retained live 0.28.6 decoder. Source identity and
review-policy improvements that do not change detection remain separately useful.

Next investigation: separate preparation-tone confidence from source/lane
selection, and verify that all appropriately corroborated lane evidence survives
a confidence demotion before changing automatic clock eligibility.

Reproduction reports (ignored local artifacts):

- Before: `test-results/video-robustness-2026-09-06T00-22-02-829Z.json`
- Experiment: `test-results/video-robustness-2026-09-06T00-58-06-220Z.json`
- Compare with `npm run benchmark:compare -- BEFORE.json AFTER.json --tolerance=0.01`.
- The saved patch passes `git apply --check` against the retained runtime, but
  was not reapplied to the live application.
