# Changelog

User-facing changes and their limits. Detailed experiments and regression
observations are recorded in [benchmarks](benchmarks).

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
