# Source-time COM measurements — September 5, 2026

## What was investigated

The prior release had variable COM coverage on the same video. An additional
independent IMAGE-mode pose detector was tested only after ordinary tracking
failed. It produced 45/62 usable samples on `12.24.mov` versus the prior 46/62,
and 45/52 on `IMG_9199.MOV`, without a demonstrated coverage benefit. That
experiment was removed; no second detector, extra model memory, or relaxed
identity gate ships. Its ignored report is
`test-results/independent-recovery-experiment.json`.

## Measurement defects

The saved samples already contain native decoded-frame timestamps, but the COM
fitter, speed calculation, gap checks and path duration used the later seek
cursors. On the 12.24 clip these differ by up to 28.333 ms. Uneven cursor offsets
can distort velocity even when the measured positions follow constant motion.

COM also deduplicated cursor timestamps only. Several seeks into the same
source frame could count as independent body measurements. A requested 15 fps
is not proof that the source supplies 15 independent observations per second.

The updated measurements use validated native source time, retain cursor time
for seeking/export compatibility, and fall back to cursor time when trustworthy
native metadata is absent. Duplicate source frames remain inspectable but only
one usable representative contributes to fitting and metrics. Non-increasing
mixed/native timestamps are withheld. Peak speed needs at least three consecutive
usable measurements at an observed cadence of at least 8 Hz, not just an 8+ fps
setting. Existing pose, visible-mass, calibration and start/finish gates remain.

Source intervals can straddle the requested smoothing window (for example,
0.173/0.207 s from a nominal 5 Hz scan). A fit includes at least one actual
observed interval inside its validated continuous chunk; it never widens across
a rejected point or tracking gap. Charts use the same chunking rules as metrics.
COM wall-section crossings also use source time and refuse to interpolate
through explicitly rejected jumps, even if their cursor gap is short.

## Evidence boundaries

Controlled tests cover known constant motion, duplicate frames, bad imported
metadata, non-increasing times, and observed cadence. They test the calculations,
not whether real-video pose coordinates or approximate wall geometry are true.
Tracking coverage alone is not a pose-accuracy label. The user's 12.24 s total
remains a total-only reference, not separate Start/Finish annotations.

## Verification

- 535 unit tests in 54 files, TypeScript, and production build pass. Build emits
  the non-blocking large-entry-chunk advisory.
- The six-source replay passes without changing accepted Start/Finish markers
  or hold numbering. `12.24.mov` retains 12.255 s, 18 holds, and 46/62 usable
  samples; `IMG_9199.MOV` retains 10.342 s, 19 holds, and 45/52 usable samples.
  Report: `test-results/source-time-0.28.4-six.json` (before the final shared
  chart chunking and smoothing-boundary follow-up).
- A deliberately generated 5 fps copy was analyzed at a requested 15 fps:
  184 requests contained only 62 unique native frames. All 122 repeats were
  excluded from independent COM measurement; peak speed remained unavailable.
  Save/reload and comparison passed. This is a derived stress test, not a new
  labeled climb. It returned 12.200 s with 0.2 s source-frame duration, which
  must not be presented as better timing accuracy than the original.
  Report: `test-results/source-time-5fps-at-15.json`.
  Derived SHA256: `a35f89e4520629006d382ee57d4ade565fdc1144de19de6d7f32a0ab7d6b781c`.
  Transform: original `12.24.mov`, `fps=5`, H.264 CRF 18, AAC audio, stripped
  source metadata. Private generated media remains ignored.
- After shared chart chunking and the smoothing-window follow-up, both complete
  original recordings passed again, including save/reload, Hold 10 review,
  comparison and the exact-video Hold 8 regression:
  `test-results/source-time-final-0.28.4.json`.
  Final counts: 46/62 usable samples and 43 speed samples for 12.24; 44/52 and
  41 speed samples for 9199. The one-sample variation on 9199 is not presented
  as an improvement in pose accuracy.
- The final 5 fps / requested-15-fps repeat also passes, preserving 122 excluded
  repeats and no peak speed: `test-results/source-time-5fps-final.json`.
- The browser/React verification pass inspected desktop and 390 px mobile speed
  traces. Charts preserve actual gaps without fragmenting continuous source
  samples; no page errors were reported. Reused existing accessible chart labels
  and pure shared calculations rather than adding effects or duplicate state.
- Existing `src/styles.css` edits remain untouched and uncommitted. No private
  media, screenshot, or generated session is included in Git.
