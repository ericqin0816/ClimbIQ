# Hold 10 context and metric chart presentation

Release: 0.28.13. Baseline: 0.28.12, commit 2d7bab2.

## Reproduced problem

On 12.24.mov, the broad cursor was 15.921 s and the closer estimate 15.405 s.
The 0.516 s disagreement exceeded the existing 0.450 s replacement limit.
Keeping the cursor unconfirmed was reasonable, but previewing only the retained
cursor ±0.130 s omitted the earlier evidence. The first image was at 15.791 s.

The first implementation widened the strip to the dense scan itself. Visual
inspection still found insufficient lead-in, so the final plan adds up to
0.6 seconds of earlier visual context, bounded by the accepted climb start.
The pose scan and candidate acceptance policy are not expanded.

The final native strip for this replay spans 14.587–16.793 s, includes frames
near both estimates, and retains the unaccepted 15.921 s review cursor. Source
frame captions can precede an interpolated candidate by part of a frame. No
contact time or bottom/top split was independently established by this change.

## Presentation changes

- Up to nine unique, chronologically ordered source-frame images; explicit
  approximate cursor fallback when native metadata is unavailable.
- Fixed target-centered crop; no hand rings on inconclusive/height-only evidence.
- Horizontal filmstrip with keyboard-focusable navigation and mobile scrolling.
- A 120 × 600 SVG plot area for the 3 × 15 m wall, using 40 units/metre on each
  axis. The old 300 × 600 mapping exaggerated lateral movement by 2.5×.
- Shaded unavailable speed intervals and continuous-time coverage. Invalid or
  unselected samples break chart segments; isolated speed samples appear as dots.
  No coordinates, numerical speed values, or saved metrics are rewritten.

## Verification

- 659 unit tests across 65 files, typecheck, and production build pass.
- Unit coverage includes disputed earlier estimates, lead-in bounds, duplicate
  preview requests, equal metric scales, native sample timestamps, isolated
  samples, missing speed, and non-mutating gap calculation.
- Full local replays of 12.24.mov and IMG_9199.MOV pass. Start/Finish remain
  9.400/21.655 and 7.121/17.472 respectively. Hold 10 stays unaccepted until the
  explicit test-only review action; that action is workflow testing, not a label.
- Desktop (1440 px) and mobile (390 px) checks cover layout, loaded previews,
  equal rendered plot proportions, and navigation to the captioned frames.
- Save/reload, closer-scan cancellation/retry, explicit review provenance, and
  dependent split calculations remain covered by the full replay.

The initial replay exposed an obsolete test that waited for exactly three
images after retry. It was updated for the bounded strip, with new checks for
both estimates, approach/follow-through, unique times, and no implicit acceptance.

Private frames and complete replay reports remain in ignored local output.
Improved presentation is not evidence of improved pose-model accuracy. Remaining
tracking noise, calibration uncertainty, and unconfirmed physical contact must
still be reviewed rather than hidden by cosmetic smoothing.
