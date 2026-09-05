# Upper finish refinement: September 5 follow-up

## Reproduced defect

The coarse upper-indicator search calibrated a patch at radius 0, 1 or 2,
but temporal refinement expanded that patch by at least two pixels per side.
A tiny indicator could therefore be detected at discovery and disappear into
the surrounding wall during refinement. Its original undiluted calibration
was still used to judge the diluted samples.

Three synthetic indicator positions reproduced the loss. Refinement now uses
the selected discovery radius and explicitly covers its pixel edges. An
additional floating-point defect could turn an exact one-pixel crop into a
two-by-two crop; the new edge policy snaps machine-precision rounding noise
without snapping genuinely fractional selections.

## Scope and rejected experiment

The precise edge policy is opt-in and currently used only by upper-indicator
temporal refinement. An initial global conversion change made original
`IMG_8903.MOV` automatically accept Finish at 15.740 s, where the baseline
requires review. This was a new unverified acceptance, not an accuracy gain.
That global change was rejected; existing lower-sensor pixel membership is
preserved explicitly and covered by compatibility tests.

The finish corroboration policy is unchanged. A synthetic tiny-light capture
pipeline reaches refined High confidence when its supplied timing cross-check
agrees, but withholds the same standalone upper change without corroboration.
That controlled fixture does not establish real pad contact or independent
accuracy on phone recordings.

## Verification

- 494 unit tests in 50 files, TypeScript checks and production build passed.
- Tests cover discovery-to-refinement color consistency at three positions,
  exact pixel round trips at 20/180/320-pixel dimensions, genuinely fractional
  bounds, bottom-right edge handling, legacy sensor crop compatibility, and
  propagation through the actual color-sampling function.
- Two orchestration tests exercise coarse capture, discovery, native crop
  sampling, temporal refinement and the official-time corroboration policy.
- Four full dark/silent workflows on original sources 8903 and 9076 passed
  with zero workflow errors and no accepted-time drift. Both checksummed known
  false-finish cases remained unaccepted. Three cases still need investigation;
  these transformed copies do not create independent labels. Report:
  `test-results/video-robustness-2026-09-05T17-20-30-686Z.json` (ignored).
  This run used the final detector changes while the displayed app label was
  still 0.27.1; the label was subsequently bumped to 0.27.2.
- Interactive Chrome upload/analysis of original 8903 returned to the expected
  review-only Finish behavior, with COM paused rather than scanning descent.
  No browser exceptions were reported. A local browser run interrupted by
  development-module reloading is excluded and not counted as a detector result.
- The settled 0.27.2 full-workflow replay passed all five originals, including
  session save/reload. The reference 9199 retained Start 7.130 s and Finish
  17.480 s, passed identical-attempt comparison, and produced 44/52 usable COM
  samples with 19/20 registered hold silhouettes. Accepted timing did not change;
  the sampling fix is not represented as increased real-video accuracy.

## Limitations

This corrects a demonstrated sampling inconsistency. It is not a finish-pad
tracker, does not recover occluded contact, and does not establish a general
accuracy percentage. Tiny lights can still disappear during coarse resizing,
and compression or camera movement can make an otherwise valid crop unusable.
Independent event labels remain necessary to score timestamp accuracy.
