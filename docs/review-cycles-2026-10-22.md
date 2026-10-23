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
server checks passed. Production workflows passed 44 cases locally; 28 Windows
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
project reviewer confirmed the 9.6 score after the final hosted WebKit run;
local Windows skips did not supply that evidence. No reviewer reported a score
for independent real-climber accuracy or native readiness.

The first Round 3 [hosted run](https://github.com/ericqin0816/ClimbIQ/actions/runs/39873514879)
passed verification, Chromium, both WebKit focus regressions, and 33 of 34 WebKit
cases. One desktop endpoint test missed its transient playback-state predicate.
The trace showed individual remote evaluations taking about 335–833 ms against
a 500 ms observation window, followed by normal completed playback. That trace
supports an observation problem but does not prove the intermediate video clocks.
The test now arms a bounded in-page animation-frame/media-event probe before
replay, retains the exact shorter-side endpoint state, requires the other clock
to advance while that endpoint remains paused, and checks both final endpoints.
It keeps the same 5 ms endpoint tolerance and actual native playback; no retries,
playback stubs, or clock overrides were added. Failure reports retain clock,
paused, seeking, ready-state, and visibility samples.

The replacement [hosted run](https://github.com/ericqin0816/ClimbIQ/actions/runs/39874399165)
passed both endpoint tests and both focus tests, but exposed one desktop WebKit
export interaction after opening a practice recording. A separate controlled
readiness regression then reproduced delayed practice landing stealing focus from
an outside export action. Practice landing now completes in a layout effect
before Ready is painted, and a pending request yields immediately to outside
pointer, focus, keyboard, or wheel intent. The regression retains actual native
decoding and an actual downloaded export; only visible-player readiness
notifications are delayed to exercise the race. The provenance workflow also
waits for its intended one-shot landing before initiating its next action.

The next [hosted run](https://github.com/ericqin0816/ClimbIQ/actions/runs/39875543547)
passed those previous product regressions, but exposed two test portability
assumptions. Safari may blur a pointer-activated download button, so the intent
test now explicitly re-establishes and verifies outside keyboard focus after the
real download and before releasing readiness. A calibration readback lasts about
200 ms and can finish before a remote assertion; an in-page mutation observer
now retains an actual DOM commit with both saved rows, replacement input, and
sampling action disabled together, then verifies enabled recovery. No application
code, readiness timeout, or disabled-state requirement changed for these test
adjustments.

Final [hosted verification](https://github.com/ericqin0816/ClimbIQ/actions/runs/39876463932)
completed successfully at `813f80dd739c921fc4869c893efd201da079b101`:

- Verification passed: 963 tests, typecheck/build/server, production audit,
  native source configuration, compiled-worker policy checks, existing browser
  workflows, and all three source-frame timing repetitions.
- Chromium passed all 36 desktop/phone workflows.
- macOS WebKit passed all 36 desktop/phone workflows without skips, including
  endpoint stopping, review focus, outside-export intent, calibration ownership,
  and provenance through replacement and a new recording.

All three closing reviewers confirmed no remaining actionable finding in their
reviewed scopes. The final documentation commit records this result without
changing the reviewed application or tests. The scores remain implementation
assessments, subject to the evidence limits below.

At the first production publish (`57fc62b`), the public app and coaching status
endpoint returned HTTP 200, the production policy was present, and
[`build-info.json`](https://climbiq-detection-lab.vercel.app/build-info.json)
reported that commit with `workingTreeDirty: true`. The deployed checkout's
changes were not inspected; their cause or contents are not established here.
The corresponding local checkout/build was clean. Preserve the hosted flag:
this production build is not a qualifying frozen-study build. Use and retain a
verified clean build for that study. The project reviewer independently checked
this limitation and retained the 9.6 software/delivery score; the flag does not
invalidate the successful reviewed-code CI run.

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
