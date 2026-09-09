# Changelog

User-facing changes and their limits. Detailed experiments and regression
observations are recorded in [benchmarks](benchmarks).

## 0.29.0 — 2026-09-08

- Added a local evidence-review panel with accepted timing, frame-reviewed
  Hold 10 phase gates, optional comparable baseline, and source-video links.
- Added optional NVIDIA NIM prioritization of approved evidence IDs. Model-written
  measurements, technique causes, and training prescriptions are never displayed.
- Hosted review requires explicit consent, server-only credentials, a private
  workspace access code, durable Redis records and an atomic daily request limit.
  Repeated requests reuse the saved reservation; archived reviews omit video links.
- Added policy, provider-adapter, persistence-boundary and responsive-browser tests.

Hosted AI is disabled until configured. Live NIM/Redis operation is not yet
verified. This does not improve detector accuracy or establish coaching validity.
See [setup, privacy and limits](docs/coaching.md).

## 0.28.13 — 2026-09-08

- Hold 10 review now shows a bounded, scrollable source-frame strip covering
  both available estimates and an additional 0.6-second visual lead-in. A
  disputed earlier estimate no longer disappears behind the retained cursor.
- Kept the crop centered on the estimated hold and hid hand rings on
  inconclusive/height-only results. Thumbnail navigation does not accept a split.
- Corrected the wall chart to equal horizontal/vertical metre scales. Speed
  charts show unavailable intervals and continuous-trace coverage explicitly,
  and do not connect invalid/unselected samples or fill gaps with guessed values.

These are review and presentation fixes. Pose coordinates, calculated speeds,
contact acceptance thresholds, and accepted Start/Finish timing are unchanged.

## 0.28.12 — 2026-09-06

- Added a bounded native-decoder readiness check after video seeks. A delayed
  decoder must not supply an old frame for calibration at a new cursor.
- Preserved small variable-frame-rate boundary gaps for the native walker to
  resolve, without counting a repeated frame as fresh timing evidence.
- Enabled CI on `codex/` preview branches so cross-platform changes can be
  verified before moving production. Encoded-fixture failures now include
  calibration and source-sample diagnostics.

## 0.28.11 — 2026-09-06

- Replaced rounded seek grids with bounded native-frame traversal for short
  calibrated Start refinement and dense Finish refinement. Duplicate frames no
  longer count as independent observations; source duration drives the next
  seek when available.
- Added elapsed blue-state support for high-frame-rate Start refinement and
  prevented an early glitch from borrowing a later blue confirmation after a
  return to green.
- Made camera-cut failures apply across nearby cues in the same fused event.
  Another colored patch can no longer bypass a failed full-frame scene check.
- Added a consistency check for three or more native-refined visual Start
  cues: an isolated blue-confirmation outlier cannot shift the accepted clock
  or re-enter Finish lane selection. Exact protocol audio retains priority.
- Preserved source/cursor timing metadata and propagated observation intervals
  when every clock-defining visual cue has native timing. Audio-defined clocks
  do not inherit a light's precision.
- Added encoded 10/30/60 fps video tests, including low-fps glitches and a brief
  first Finish flash. CI now runs those tests in Chrome using generated media;
  private recordings are not needed or uploaded.

Native frame timestamps describe the observed pixels, not the physical timing
system's latency or a measured accuracy guarantee. Missing native metadata has
an explicit cursor fallback; a native scan that loses timing or exceeds its
budget cannot be silently treated as verified.

## 0.28.10 — 2026-09-06

- Added automatic upper-target localization when the ordinary Finish checks
  remain unresolved. It follows the selected lane through perspective shifts
  and looks for a persistent compact green/blue target.
- Added a bounded first-approach review strip, with source-frame close-ups.
  The strip includes the whole approach instead of centering only on a later
  strongest change or highest belay position.
- Kept automatic target suggestions separate from user-marked pad areas,
  accepted timing, saved labels, and exports. Private preview frames remain
  transient. Saving the current session keeps its on-screen review strip;
  changing the video, Start, or loading a session clears it.

This reduces setup for reviewing some angled recordings; it does not establish
automatic pad contact. In the inspected footage, the reaching hand can be
occluded at the target. Hand-proximity research remains diagnostic only, and
Start/Finish acceptance thresholds are unchanged.

## 0.28.9 — 2026-09-06

- Added a bounded higher-detail light search for uncertain Starts. It uses more
  source pixels and preserves existing confidence and launch thresholds.
- Prevented weak reflections from pulling a stronger start-evidence group away
  from its visual cue.
- Added a chromaticity check to the recovery pass so neutral darkening does not
  backdate a later blue transition.
- Excluded weak Finish fallbacks in a recovered pass when stronger visual lane evidence is present.
  A reproduced late reflection-based false Finish is now a rejection test.
- Replaced the promotional README banner with a concise project overview,
  measurement limits, and links to the technical reference. Added contributor
  guidance and issue/pull-request templates.

Recovered Starts do not guarantee an automatic Finish. Low-frame-rate and
ambiguous recordings can still require review. These changes improve observed
availability on specific recordings; they do not establish general accuracy.

## 0.28.8 — 2026-09-05

- Separated protocol-shaped audio search hints from confidence in the start
  clock. Stronger preparation-beep checks no longer change the visual search
  window solely by demoting audio confidence.
- Retained per-patch lane evidence and calibration through the Start-to-Finish
  handoff, with diagnostics in the current analysis export.
- Made Finish retries respect an explicitly chosen body lane.
- Added cancellation and video-replacement tests for lane-evidence cleanup.

Two compressed copies moved to Start review under the stronger audio rule.
Accepted timing on the six original recordings stayed unchanged in that release.
