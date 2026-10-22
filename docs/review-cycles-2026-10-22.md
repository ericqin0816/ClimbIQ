# Three review and improvement rounds — 2026-10-22

Three agents reviewed the product/UI, code/reliability, and project/delivery
independently. Each round used the same scoring rubric, then implemented and
verified concrete recommendations. These are scoped engineering judgments,
not independent accuracy measurements or evidence of market demand.

## Fixed scoring rubrics

- Product experience: clear purpose, first useful result, training decision,
  review/identity, and continuity; each worth two points.
- UI: hierarchy, phone layout, interaction, accessibility/touch, and
  consistency/efficiency; each worth two points.
- Code: correctness/async ownership (40%), maintainability (25%), React and
  performance (20%), and accessibility/contracts (15%).
- Project: setup, CI fidelity, documentation/handoff, release traceability,
  and study integrity; each worth two points.

## Round 1

Starting revision: `505d2df`. Result: `07515ac`.

| Product experience | UI | Code | Project |
| ---: | ---: | ---: | ---: |
| 7.8 | 7.6 | 8.5 | 8.5 |

The review found an out-of-order keyboard calibration crash, malformed imported
scalar values that could reach string operations, UTC dates on local attempts,
hidden practice onboarding, and frame-review controls below fixed phone
navigation. The fixes use explicit incomplete corner drafts, validate imported
fields, use local dates, expose practice in the first screen, and place frame
evidence and acceptance above navigation at both 320×740 and 320×568.

Build identity now distinguishes the current exporter from the build that last
accepted a detector Start. Old/unknown provenance is preserved rather than
assigned to the current build. The production preview and compiled-worker smoke
use the shipped Content Security Policy; browser workflows fail on page errors
or policy violations. Native handoff instructions now point to main.

Verification: 944 tests, typecheck, production build, compiled server, real
compiled worker under CSP, and focused phone geometry checks passed. The
[hosted CI run](https://github.com/ericqin0816/ClimbIQ/actions/runs/39869937454)
completed successfully, including macOS WebKit media workflows.

## Round 2

Starting revision: `07515ac`. Result: `910338e`.

| Product experience | UI | Code | Project |
| ---: | ---: | ---: | ---: |
| 8.5 | 8.6 | 8.8 | 9.4 |

The main experience gap was reaching a useful replay after saving two attempts.
Comparison now has its own destination and links the largest meaningful reviewed
phase change to replay. A single preparation action checks the two bundled
synthetic videos against their content hashes before association. Uploaded
personal recordings still require explicit confirmation on both sides.
Preparation does not automatically start playback.

The next-action card recognizes saved content and returns to Save when notes,
markers, settings, identity, or other persisted content changes. Closing frame
review restores its opener without stealing focus from unrelated controls.
Typed dataset/report modules replace about 253 lines of App serialization, and
Markdown and JSON folder exports share the same captured dataset. Static chart
geometry is memoized separately from the moving cursor.

Study validation now requires adjudication after both original labels and a
documented resolution for disjoint qualifying observation brackets. Production
browser output has a dedicated directory so its cleanup preserves other local
evidence. New workflows cover provenance through import, edit, save, reload,
correction, failed replacement, and a new recording.

Verification: 955 tests, typecheck, production build, and compiled server passed.
Production workflows passed 40 cases locally, with 24 explicitly skipped Windows
WebKit media cases; macOS CI runs these without that platform skip. Two new test
navigation mistakes were corrected and their full practice scenarios passed on
desktop and phone. The private recording regression and all six cancellation
stages passed, including build-provenance preservation and replacement clearing.
Accepted timing remained unchanged from the existing regression baseline.

The [Round 2 hosted run](https://github.com/ericqin0816/ClimbIQ/actions/runs/39871827957)
passed verification and Chromium, but failed the close-review focus assertion on
both macOS WebKit projects. Its other 30 WebKit scenarios passed. Safari pointer
activation does not reliably focus the opening button, so reading only
`document.activeElement` could not recover the correct opener. Round 3 explicitly
focuses review triggers before opening the region and retains the guided-finish
button in the DOM while its review is open. The focus regression stays enabled;
the final hosted result is recorded below.

## Round 3

Starting revision: `910338e`.

| Product experience | UI | Code | Project |
| ---: | ---: | ---: | ---: |
| 9.0 | 8.9 | 9.1 | 9.5 |

The review found misaligned replay players, source controls displacing the video
on phones, and practice opening above its next review action. It also found that
the study CLI could overwrite its own manifest or earlier report, and whitespace
numeric cells could become actual zero timestamps. Reports now require a fresh
output filename, including when the existing path is a hard-link alias; blank
numeric fields remain unknown and actual zero stays zero. Practice dates use the
same local-date helper as regular attempts.

Saved-state guidance now memoizes compact pose evidence by immutable React state,
and checks editable fields separately from that evidence. A 450-frame helper
probe on this host measured about 11.6 ms for two full content keys per edit and
0.0023 ms for the reused-evidence text path. Refreshing the two evidence keys
still costs about 11.4 ms when evidence changes. These are isolated helper costs,
excluding compaction and rendering; they are not phone latency measurements.
Tests retain detection of changes to every supported persisted field category,
including recording identity, and pure helpers do not cache mutable callers.

The UI now aligns the two videos in shared rows and moves confirmed recording
replacement controls behind them. The selected phase/state and Pause action are
near the replay action. Practice opening consumes one request tied to its adopted
video context, brings the current step into view, and focuses its primary action
only after readiness. Generic review buttons and the practice review trigger
capture their opener explicitly for Safari.

Verification: 963 tests across 98 files, typecheck, production build, and compiled
server checks passed. Production workflows passed 42 cases locally; 26 Windows
WebKit media cases are explicitly skipped on that host. The affected landing,
review-focus, and replay cases passed again after the final layout refinement.
Both replay frames are aligned and fully above fixed navigation at 320×740 and
320×568. The actual compiled worker ran under the shipped policy and verified 23
bundled assets. The private full recording workflow passed again, with no new
accuracy claim. Production audit and native source configuration checks passed.

Closing agent assessment:

| Scale | Before round 1 | After round 3 |
| --- | ---: | ---: |
| Product experience | 7.8 | 9.2 |
| UI | 7.6 | 9.2 |
| Code | 8.5 | 9.1 |
| Project | 8.5 | 9.6 |

The experience reviewer independently completed desktop, 320×740, and 320×568
walkthroughs. At the shortest size, both replay frames end at y484 and fixed
navigation begins at y499. The code reviewer found no remaining actionable bug
in the reviewed ownership, serialization, focus, or memoization changes. The
project assessment remains conditional on the final hosted WebKit rerun; the
local Windows skips cannot supply that evidence. No reviewer reported a score
for independent real-climber accuracy or native readiness.

## Evidence limits

The product rubric assesses the implemented experience. Overall product readiness
also needs independent climber usefulness, correction effort, repeat-use, and
device evidence. No participants, blinded real-climber annotations, observed
training decisions, or return visits were collected during these rounds.
Synthetic reference transitions and private regression recordings cannot supply
those missing measurements. Follow [the independent study](independent-study.md)
to collect them, retaining reviewer originals outside Git.

The Windows host cannot compile/sign the native app or validate physical iPhones.
The source configuration checks do not establish native readiness. The public
web app and coaching status endpoint were reachable; the latter reports hosted
AI disabled in the default private-workspace mode. No server configuration or
account credentials were changed.

Production dependency audit reported zero vulnerabilities. The full audit's
three moderate development-only Capacitor CLI dependency entries are recorded in
the [previous iteration](iteration-2026-10-22.md); no forced downgrade was applied.
Original checkout stylesheet edits and overnight notes were preserved in place;
these rounds used an isolated managed worktree.
