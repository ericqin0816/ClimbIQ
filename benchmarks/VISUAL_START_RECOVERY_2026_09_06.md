# Visual start recovery: development record

Baseline: 0.28.8, commit 746a1e2. This pass addresses uncertain Starts and the
public repository presentation. Private media and generated frames stay ignored.
The user's 208 added stylesheet lines are unrelated and excluded.

## Reproduced causes

1. The standard 480 × 320 discovery raster lost useful pixels around a small
   floor light. A 960 × 640 bounded pass (never upscaled) found stronger refined
   light evidence on IMG_9076 and two compressed copies.
2. RGB distance alone could backdate a later blue transition to an earlier
   neutral darkening. The recovery pass additionally requires a sustained
   blue-directed chromaticity change. Applying this globally altered working
   lane choices and tracking, so that experiment was rejected; the extra test
   applies only to the recovery pass.
3. Two Low color patches at 2.450/2.650 s could drag a Medium audio cluster at
   2.850 s away from a Medium visual cue at 2.967 s. Reliable audio now anchors
   clustering when only weak colors are available. Once reliable color joins,
   it defines the visual clock. Medium audio alone still cannot auto-accept.
4. The nearest-to-beep weak reflection could outrank a stronger visual lane.
   In a selected recovery pass, reliable visual support now precedes Low support,
   independently of audio confidence. Weak patches remain in the audit but do
   not become alternate Finish sensors. Standard-pass ordering and fallback
   availability stay unchanged.

## Recovery contract

The retry runs once, only if more source pixels exist and the standard pass
lacks High refined visual evidence. It retains the same time window and signal
thresholds. An unguided window longer than 12 seconds does not retry at higher
detail. A detail pass must strictly improve visual confidence to replace the
standard pass; equal-strength alternatives are withheld. A protocol search hint
does not create a confidence vote. Candidate passes replace one another instead
of accumulating duplicate votes from the same light at different resolutions.

The selected result still passes the existing artifact, camera-continuity and
lane-local launch checks. No finish acceptance threshold changed. More automatic
Starts do not establish more accurate Starts, and they cannot force a Finish.

## Specific output changes inspected

- Preliminary original IMG_9076 candidate: Start 2.950 s, lane-local motion 3.050 s. Before/after source
  frames around 2.883/2.983 s show blue light appearing while the athlete is at
  the starting holds. This is developer inspection, not independent annotation.
  Finish stays unaccepted and COM stays paused.
- Control-720 copy: Start 2.900 s. Compact-360 copy: Start 2.967 s. Both previously
  needed Start review in 0.28.8. Their different source-frame observations and
  outputs are retained, not forced to a common target.
- Low-FPS copy still requires review: a 3.000 s proposal has only a 0.033 s
  visible-motion delay under the unchanged visual-audit policy.
- A development candidate accepted a false Finish at 31.433 s from a weak
  window-reflection fallback. Direct frame inspection showed the climber back
  on the floor. Excluding weak fallback patches in the presence of reliable
  visual support blocks that result. Its checksummed fingerprint is now in
  `known-video-failures.json`.

After adding the signed-opponent guard, original IMG_9076 no longer has a
stronger recovered visual clock and remains at its unaccepted 2.790 s audio
review cursor. Its preliminary new-acceptance expectation was discarded; the
original benchmark record is unchanged. No independent labels or measured
accuracy were invented, and no thresholds were relaxed to retain that gain.

## Local reports

- `test-results/visual-start-probe-baseline.json`: per-patch discovery and body evidence.
- `test-results/visual-start-probe-detail.json`: additional source pixels, before the chromaticity guard.
- `test-results/visual-start-probe-direction.json`: guarded detail-pass evidence.
- `test-results/visual-recovery-originals-candidate.json`: rejected global color-rule experiment.
- `test-results/visual-recovery-originals-scoped.json`: original accepted workflows restored; new IMG_9076 Start flagged for inspection.
- `test-results/visual-recovery-9076-0.28.9.json`: exposed the false reflection-based Finish.
- `test-results/visual-recovery-9076-guarded-0.28.9.json`: both Start recoveries retained, false Finish blocked, low-FPS review retained.

Unit/typecheck/build pass: 596 tests across 59 files. Browser cancellation passes
for Start, the added detail pass, Finish and pose, including prior-evidence
restoration and replacement cleanup. Detail-pass cancellation took 441 ms in
the recorded browser test; this is an observation, not a latency guarantee.
Public rejection-safety replay and the full 36-case matrix are release gates.

The initial broad reliable-lane filter lost a valid Finish on the low-FPS 12.24
copy and Start/Finish on its trimmed copy. That partial matrix
(`video-robustness-2026-09-06T05-11-08-836Z.json`) was stopped and is not a completed
evaluation. Lane preference/filtering was scoped to selected recovery passes,
preserving the standard-pass behavior. A second opponent-color condition rejects
additive gray brightening as well as brightness scaling in recovery refinement.
Targeted and original replays are rerunning before a fresh complete matrix.

Final targeted replay passed in `visual-recovery-final-targets-0.28.9.json`:
the low-FPS 12.24 Start/Finish stayed 9.400/21.667 s and the trimmed copy stayed
7.400/19.655 s. Control/compact IMG_9076 Starts remained 2.900/2.967 s with no
accepted Finish. The 31.433 s reflection-failure guard held. The low-FPS IMG_9076
copy still requires review; the standard-pass lane choice remains unchanged.

Final original-six replay passed in `visual-recovery-final-six-0.28.9.json` with
the original regression expectations unchanged. Accepted boundaries and the
12.255 s user-reference total are preserved. Final public replay passed in
`visual-recovery-final-public-0.28.9.json`; all eight clips remain unaccepted.
Guided Finish review also passed after the final changes, including manual-lane
exclusion, desktop/mobile checks, save/reload and export/import.

The fresh full matrix is `video-robustness-2026-09-06T05-28-05-717Z.json`; compare
it with 0.28.8's `video-robustness-2026-09-06T02-35-42-137Z.json` on exact hashes.
Do not count the interrupted broad-filter matrix as a completed run.

## Completed release gate

The final 36-case matrix completed with zero workflow errors and zero
source-consistency timing regressions. The paired 10 ms comparison against
0.28.8 reports:

- 36 checksummed pairs, zero unpaired cases.
- Zero lost accepted Start/Finish boundaries.
- Zero accepted-time changes, including changes within the comparison tolerance.
- Two new unverified Start acceptances: control-720 IMG_9076 at 2.900 s and
  compact-360 IMG_9076 at 2.967 s. Their inspected visual recovery is the intended
  change. Their Finish remains unaccepted. Accuracy remains unavailable.
- All four known false-boundary fingerprints remain blocked. No comparable
  tracking-coverage change exceeded 0.08 (coverage is not spatial accuracy).

The matrix's 21 source-relative investigation flags include existing unavailable
results and the new acceptances; they are not 21 newly introduced regressions.
The paired comparator intentionally reports the two acceptances for inspection
rather than declaring them independently correct. The source regression JSON
remains unchanged. Decision: ship the bounded recovery and its stricter fallback
guard, with these limitations documented.

Final verification also includes 596 unit tests, typecheck/build, the complete
original-six workflow, eight public rejection-safety clips, four cancellation
stages, and guided Finish review. The new probe's invalid-media path and the
timing runner's invalid-port rejection were checked. Documentation file links
resolve. Browser inspection confirmed the recovered compact-copy Start and no
accepted Finish without runtime exceptions. Test browser sessions were closed.

## Repository presentation

Removed the generated advertising banner from the README rather than substituting
private athlete footage or fabricated product imagery. The landing README now
links to the live app, explains measurements and limitations, and provides a
locked-dependency setup. Detailed operating notes moved to `docs/analysis-reference.md`.
Added contributing guidance and bug/PR templates, fixed moved relative links,
and populated the repository's About description and topics. A final writing
pass removed the slogan-like opening and kept concrete, qualified claims.
