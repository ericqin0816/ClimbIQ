# Timing reliability follow-up

Baseline: `3f110af`, on the iOS development branch. Source media remains local.
These changes address reproducible sampling and cancellation defects. They do
not establish a general real-video accuracy bound or independent contact labels.

## Reproduced defects

The upper electronic-finish path still refined on millisecond-rounded 30 fps
seek positions. In a source-aware synthetic capture pipeline, a transition at
1.633333 seconds was reported at 1.667 seconds: the rounded seek fell just
before the source-frame boundary and the next sample skipped the first changed
frame. A 10 fps source also supplied repeated observations of the same image,
without native source timing in the returned evidence.

Upper detection had a second issue: when a coarse transition was High but its
finer samples did not verify it, the unchanged High coarse result was retained.
An agreeing entered total could therefore keep that result eligible for
automatic acceptance. The lower electronic detector already withheld High
confidence in this situation.

First-movement analysis did not receive cancellation. A request cancelled
before its first frame still performed the complete 35-seek test window. It
also swallowed decoder `AbortError` as a missing-motion result and could sample
a replacement source. Tests reproduce all three behaviors.

## Changes

Upper electronic refinement now uses the existing bounded source-frame walker.
It retains the seek cursor separately, records source-frame spacing, and counts
each decoded frame once. Missing native timing from the outset keeps an explicit
cursor fallback. Losing native timing midway aborts verification rather than
mixing clocks. Coarse upper discovery and physical-top review remain unchanged.

An upper coarse candidate that fails finer verification is capped at Medium
confidence and explicitly requests frame review. An entered total does not
override that missing verification. Existing independent corroboration and
conservative acceptance checks still apply.

First-movement analysis accepts an optional abort signal and checks it before
and after seeks. Source replacement and decoder cancellation propagate as
`AbortError`; ordinary decoding failures still produce diagnostic results.
The same checks cover the motion-based start estimate, which can scan the whole
start window when audio is unavailable. Successful motion calculations and
thresholds are unchanged.

## Verification

- Six-original full-workflow baseline passed before these detector edits:
  `test-results/timing-baseline-six-2026-09-22.json`.
- Focused timing, source-frame, upper-indicator, fusion, body-audit and
  cancellation unit tests passed: 106 tests across eight files.
- The encoded source-frame browser suite passed seven fixtures and 75
  phase/sensitivity checks, including a 30 fps upper-indicator transition at
  1.633333 seconds and a 10 fps distinct-frame case. Upper refinement retained
  61/61 and 21/21 unique source observations respectively, with 33.333 ms and
  100 ms observation intervals. These are synthetic sampling checks.
- The six-original candidate full workflow passed, including save/reload and
  review provenance: `test-results/timing-candidate-six-2026-09-22.json`. All
  accepted Start/Finish values and abstentions matched the same-media baseline.
  The two complete analyses retained the same usable COM counts in this run:
  46/62 and 44/52. Coverage is availability, not spatial accuracy.
  IMG_9199's second-pass review classification changed from contact-candidate
  to inconclusive (nine versus eight preview frames), despite unchanged broad
  tracking counts. Neither run accepted Hold 10 automatically. This observation
  is retained for the separate model-repeatability investigation; passing
  timing checks does not mean every tracking/review result was identical.
- Three edited public clips and eight controlled copies passed their workflow
  checks. All six checksummed false-boundary fingerprints remained blocked.
  The eight controlled copies retained the accepted timing states/values from
  the latest applicable completed same-media history. Compact IMG_9199 uses
  the 0.28.12 targeted follow-up, which corrected an older matrix's documented
  temporary availability loss. See
  `test-results/timing-transformed-comparison-2026-09-22.json`.
- Expanded cancellation smoke passed Start, detail recovery, motion-probe,
  upper-target, Finish and pose stages, plus rerun preservation of prior timing,
  COM, Hold 10 previews and lane evidence. Rapid and invalid replacements passed.
  The test's obsolete exactly-three-preview assertion was corrected to the
  existing five-to-nine loaded-frame contract; the pre-edit baseline already
  had nine frames. The corrected complete suite passed, not only an isolated
  retry: `test-results/timing-cancellation-verified-2026-09-22.json`.

The original Start/Finish observations remain regression references. Historical
disputed times, total-only user references, and synthetic transitions are not
promoted to independent real-video event labels.
