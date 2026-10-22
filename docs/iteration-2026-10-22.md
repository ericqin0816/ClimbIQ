# Training workflow iteration — 2026-10-22

Version 0.30.0 combines the existing reliability branch with current main's
coaching work, then adds practice, comparison replay, and study preparation.
This is an implementation and regression record. It is not an independent
accuracy study or a declaration that the native app is ready for release.

## Requested priorities

| Priority | Delivered | Remaining work |
| --- | --- | --- |
| Independent validation | Blinded two-reviewer protocol, empty worksheets/manifest, hash and build matching, grouped held-out splits, adjudication checks, and separate outcome reporting. | Recruit participants and collect 30–50 distinct attempts. No new independent labels, correction observations, training decisions, or return visits were collected. |
| Reliability | IndexedDB concurrency checks, explicit conflict recovery, staged decoding before replacement, explicit recording attachment, and durable attempt lineage. | Continue observing real import → review → save → compare sessions across devices. |
| First useful result | Two original CC0 synthetic recordings, authored timing references, inspect/review/save walkthrough, timing-only analysis, recording guide, and Saved access without loading a video. | Observe unassisted first use. Synthetic markers are teaching references, not real-climber accuracy evidence. |
| Training decision | Total and reviewed phase differences, two-original synchronized section replay, exact per-side stopping, and recent history grouped by attempt identity. | Measure which decisions climbers actually make and whether they return at a later session. |
| Workflow complexity | Extracted video preparation ownership, serialized analysis/restoration, library state, and session decoding into dedicated modules. | App.tsx still owns substantial UI/orchestration. This is a partial separation, not a completed rewrite. |
| Delivery | Refreshed tooling, redistributable media fixtures, production-build Chromium/WebKit tests with phone viewports, and native source/sync checks. | Compile/sign with Xcode and test physical iPhones, including interruptions and persistence. |

## Verification

- Node 22: typecheck, 912 tests across 89 files, production build, and compiled
  coaching-server smoke checks pass.
- Local production workflows: all 14 Chromium desktop/phone scenarios pass.
  Windows WebKit runs the two JSON/library workflows; 12 media cases are
  explicitly skipped because that engine rejects the available video codecs.
  macOS WebKit CI runs those media cases without skips.
- Browser regression suites pass for coaching, save recovery, mobile library,
  multi-tab conflicts, recording attachment, biomechanics ownership, compiled
  pose worker, and source-frame timing.
- A private real-recording workflow regression passes import, analysis, save,
  identity protection, export, and reload. Its accepted endpoints remain
  unchanged from the existing regression baseline. This is not a new accuracy
  label, and private recordings/reports are not committed.
- The full cancellation suite passes at all six analysis stages, preserving
  prior markers/evidence and rejecting invalid replacement video safely.
- `npm run ios:sync` passes under Node 22. No Xcode build, device installation,
  signing, or physical iPhone validation was performed on this Windows host.
- `npm audit --omit=dev` reports zero vulnerabilities. The full audit retains
  three moderate development-only entries through Capacitor CLI → xcode → uuid;
  a forced breaking dependency replacement was not applied.
- The empty study CLI smoke reports awaiting data with unknown measurements
  represented as null. No synthetic results are presented as participant data.

Hosted evidence:

- The application revision `ac89623` passed [full CI](https://github.com/ericqin0816/ClimbIQ/actions/runs/39798431996),
  including all 14 macOS WebKit desktop/phone media and library scenarios.
- The subsequent delivery-only revision `f5199de` passed all 14 production
  Chromium desktop/phone scenarios in its [hosted job](https://github.com/ericqin0816/ClimbIQ/actions/runs/39799406593/job/119895497525).
  Its [verification log](https://github.com/ericqin0816/ClimbIQ/actions/runs/39799406593/job/119895497141)
  confirms the 912 tests, production worker smoke, legacy browser workflows,
  and all three source-frame timing repetitions passed. Browser ownership
  diagnostics and a pinned encoder fallback address the observed CI failures.
- At handoff, GitHub still showed that run's repeat WebKit job queued and its
  other job conclusions pending despite their completed successful test logs.
  Application code and the WebKit scenarios are unchanged from `ac89623`.
  The main push starts another normal CI run; this document does not claim that
  later run has completed.

The original working directory's uncommitted stylesheet additions and overnight
notes were preserved. Implementation and verification used an isolated managed
worktree.

## Agent review

Three agents independently reviewed reliability, the product experience, and
validation/reporting. Their findings led to fixes for calibration task ownership,
unreviewed phase claims, replay cancellation/backgrounding, participant outcome
denominators, and practice-player readiness. They reported no remaining actionable
findings in their reviewed scopes after the fixes.

| Review | Rating |
| --- | ---: |
| Reliability | 9.0/10 |
| Experience | 9.0/10 |
| Validation and delivery | 9.3/10 |
| Arithmetic mean | 9.1/10 |

These are scoped implementation assessments. They do not replace independent
reviewer labels, observed climber behavior, or device measurements.

For field collection and reporting, follow [the study instructions](independent-study.md)
and [the iPhone beta protocol](beta-validation.md). Keep participant recordings,
consent records, reviewer originals, and raw observations outside Git.
