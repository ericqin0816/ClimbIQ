# Three practical video reviews — October 22, 2026

This evaluation tests actual import, analysis, review, save, reload, comparison,
and replay. It uses new public recordings and one existing private phone
regression clip. It is separate from the earlier engineering/UI review and from
the proposed [independent study](beta-validation.md).

## What the footage can establish

Two distinct Emma Hunt attempts were downloaded from World Climbing's
[Edinburgh 2022 broadcast](https://www.youtube.com/watch?v=XRAiut7pJQU), discovered
through this [video index](https://www.speed-climbing.com/p/beta-and-record-videos.html).
The requested source ranges were 3160–3188 and 4103–4128 seconds; section seeking
and remuxing were not established frame-accurate to the original source clock.
All test cursors and observation brackets use acquired-clip time. Different opponents and
race context distinguish the attempts. Both contain camera movement and belong
to the broadcast stress cohort, not the fixed-phone target cohort.

A separate [Jakarta training video](https://www.youtube.com/watch?v=wjG2ZkpMoII)
provides a portrait, upward-panning, two-climber stress case. Its acquired AVC
format contains **no audio**; missing audio here is a property of the downloaded
test file, not evidence about the original recording or the app's audio decoder.

World Climbing's [Kiromal slow-motion record video](https://www.youtube.com/watch?v=nbz7V8GcAHg)
was also acquired and inspected. Its ascent occupies roughly 25 video seconds
for a displayed 5.00-second result. It is a temporal negative control and was
excluded from normal-speed timing evaluation. It was not used to claim detector
accuracy or another successful automatic workflow.

| Local test file | SHA-256 | Duration / dimensions |
| --- | --- | --- |
| Edinburgh 3160–3188 | `31f8c10fe9bccd68b275400a36ef58d22573d7cdcbcf027bae05802c1f6402b1` | 28.03 s / 1280×720 |
| Edinburgh 4103–4128 | `3691040ba00d7a3150a7d7098be77fdca9656527835e8b5870a853b1e447170d` | 25.17 s / 1280×720 |
| Jakarta | `91e08cbc30af6ee92a5fbc7bd7deffaa441835b087a6fb20af3c454ab2869f42` | 11.90 s / 720×1280 |
| Kiromal slow motion | `8b233074753a1724498178862c8acec9429d6fc92de320caa9d2163af48ef2d2` | 144.36 s / 1280×720 |

Media and full local reports remain outside Git. Public availability does not
establish redistribution rights. Acquisition metadata, hashes, and visual
observations were recorded before the acquisition reviewer saw predictions.
These were new convenience samples, not a randomized or independently labeled
held-out study. Repeated passes reuse the same two broadcast attempts and must
not be counted as six independent climbs.

Only one agent made pre-prediction visual observations, using broad frame
windows. There were no qualifying independent exact electronic Start or Hold 10
labels, second blinded reviewer, or adjudication. Stance departure does not
identify the electronic start signal. Endpoint error, false-acceptance rate,
human correction time, and training benefit therefore remain unmeasured.

## Fixed agent rubrics

Each reviewer retained five equally weighted 0–2 dimensions across all three
rounds. A score of 1 generally means the outcome depends on informed manual work
or limited evidence; 2 requires a demonstrated dependable outcome in scope.
The scores are judgments about these observed workflows, not population metrics.

| Reviewer scale | Five dimensions |
| --- | --- |
| Practical experience | Usable result; correction burden; meaningful training comparison; recording suitability/clarity; continuity/recovery |
| Functionality | Import/analysis; conservative timing/identity; review/update integrity; genuine pair comparison/replay; persistence/recovery |
| Evidence-aware usefulness | File/result safety; first useful automatic result; manual correction usability; saved comparison/replay; defensible training decision |

The acquisition reviewer also scored **source evidence quality 5.5/10**:
traceability 2, observable endpoints 1.5, target capture match 0.5, independent
label precision 0.5, and capture/athlete diversity 1. Workflow fixes do not make
those underlying labels or capture conditions more representative.

| Review round | Practical experience | Functionality | Evidence-aware usefulness |
| --- | ---: | ---: | ---: |
| 1 | 6.0/10 | 7.7/10 | 6.5/10 |
| 2 | 7.1/10 | 8.0/10 | 7.2/10 |
| 3, final | **7.4/10** | **7.8/10** | **7.1/10** |

Final per-dimension scores, in the rubric order above: experience
`1.7 / 1.5 / 0.8 / 1.6 / 1.8`; functionality
`1.0 / 1.8 / 1.8 / 1.3 / 1.9`; evidence-aware usefulness
`2.0 / 0.8 / 1.8 / 1.8 / 0.7`. Round 3 broadened the test conditions and exposed
a phone playback interruption plus slow unsupported-source analysis. Lower final
functionality/usefulness scores preserve those observations rather than forcing
every successive score upward. None of these practical scores reached 9/10.

## Round 1: real baseline

Frozen served build: `57fc62b71dd12a1b68ca52bf079a8997e6cbd3bc`, clean checkout;
its application code matches the documentation-only starting revision `0949958`.

The existing `12.24.mov` phone recording was run through full analysis in an
isolated desktop Chromium context. Import took 0.21 s, the first total appeared
at 10.69 s, and full analysis became idle at 21.15 s, with approximately 300 ms
observation resolution. Start 9.400 s and Finish 21.655 s were automatically
accepted, yielding 12.255 s. These are regression outputs, not verified event
accuracy. Tracking retained 41/62 usable COM samples and registered 11/20 holds;
there was **no Hold 10 contact proposal**. Save, actual library download, reload,
reopen, and explicit original-file reattachment preserved the markers.

The new public pair passed all seven mechanical stages on desktop Chromium.
Imports took 1.60/1.31 s; timing-only analysis took 14.28/13.54 s. Automatic
coverage was **0/4 endpoints**. Both recordings required Start and Finish review;
Hold 10 stayed unset, with phase replay correctly disabled. Actual native
whole-attempt playback, paused endpoints, saving/reload, failed replacement
preservation, and correction identity all passed without page or CSP errors.

For mechanical review testing, the pair harness used operational cursors within
broad stance-departure/top-touch windows. Native-frame quantization gave durations
6.800 and 7.033 s and an app delta of **+0.233 s lost**. That is **not a valid
performance finding**: the windows permit either ranking and do not label the
electronic cue. The source's displayed 6.88/6.84 results also cannot establish
raw contact frames or a section change. Accepting the wrong event definition can
produce a misleading training conclusion even when arithmetic and replay work.

Observed gap: manual Start review was hidden behind a marker editor and required
setting a marker before a Review control appeared. A completed real total also
offered no direct contact-review route when Hold 10 detection was unavailable.

## Round 2: reachable manual recovery

Frozen clean build: `def4387d56b4626bdbfe5928c7fc562b4d373ad7`.

Changes added direct native Start review before automatic analysis, explicit
signal/event guidance, a visible normal-speed warning, and direct Hold 10 review
with a total-only fallback when contact is obscured. Opening or cancelling review
does not accept a marker. Manual acceptance follows the existing Medium-confidence
policy. Invalid marker acceptance now keeps review open and displays its reason.

The same real pair passed all seven stages with guided entry checks and actual
undecodable comparison replacement recovery. Automatic coverage stayed **0/4**;
analysis took 13.80/16.15 s. No contact was fabricated. Actual files remained
attached after failed replacement, and replay recovered. No page/CSP errors.

Separate actual Jakarta and saved-phone workflows were inspected at 320×740 and
320×568, without accepting unknown events. Closing review restored the opener,
and raw Start/Hold 10 inputs stayed empty. This exposed two refinements: manual
navigation cursors still said “Suggested,” and Return/Close initially extended
about 36 pixels behind bottom navigation on the shorter screen. Scrolling made
them reachable, but the initial layout needed improvement.

## Round 3: phone replay and honest cursor provenance

Frozen clean build: `f5d9a140183742bf5cc67bf25614e5ded087ee23`.

Manual panels now say “Starting cursor” and “Return to cursor,” omit a premature
confidence badge and an irrelevant adjustment metric, and explain before the
actions that the cursor is not a prediction. Short screens use a compact manual
action row. Accepted manual markers still retain Medium confidence and genuine
presented-frame provenance.

Actual-file inspection at 320×740 and 320×568 verified decoded frames, unchanged
unset markers, opener restoration, all actions at least 44 pixels high, and all
actions above navigation. At 568 pixels, the lowest Start action button ended at
494.53 and the lowest contact action button at 493.89, with navigation starting
at 499. Their containing groups ended at 498.53 and 497.89 respectively.

Jakarta timing-only analysis on the 320×740 viewport took 43.164 s after a 0.125 s
import. It accepted **0/2 endpoints**, left every marker and the total unset, and
offered an unaccepted 0.807 s Start review cursor. Save, actual library export,
reload, and original reattachment preserved the unset state without page errors.
This is conservative handling of a panning, audio-free test file, not validated
timing accuracy. Its review cursor is not an independently verified start cue.

The first phone-pair run paused safely on native buffering at approximately
3.95 s of section playback and did not finish within the 60 s observation. Its
failure report is retained. Timestamp inspection places the initial pause before
the later Jakarta analysis; simultaneous inference does **not** explain that
initial pause. Backup and correction stages were not reached in this first run.
Separate diagnostic checks preserve this failure rather
than silently retrying it or counting it as uninterrupted playback.

A separate quiet diagnostic run completed native phone playback without a
waiting event, with the same unmodified app build. That demonstrates a successful
phone pass; it does not explain or erase the first failure. Because playback did
not buffer in this diagnostic run, its conditional explicit-recovery stage was
not exercised. Correction retained attempt identity and the saved library.
The probe retained 786 moving observations, with maximum equal-elapsed skew
0.005583 s and both players paused at their own accepted 14.2/15.2 s endpoints.
These measure playback mechanics, not event-timing accuracy.

That diagnostic's backup assertion initially failed on a transient decoder flag:
import intentionally changes `videoMetadata.metadataLoaded` from true to false,
because a JSON backup does not attach or decode a video. This is expected import
behavior, not lost measurements. The failed assertion is retained and the
harness comparison was corrected to require false on imported metadata while
strictly preserving every other field, including timestamps and attempt lineage.
A focused check then **passed** using the actual downloaded backup in a fresh
phone context: two sessions restored, all other fields and lineages survived
reload, decoder flags were false, no videos were attached, and replay stayed
disabled. There were no page or CSP errors. The app was not changed to satisfy
the incorrect readiness expectation.

## Delivery verification

The final application code at `f5d9a14` passed
[hosted CI](https://github.com/ericqin0816/ClimbIQ/actions/runs/39889989161):
963 unit tests, type checking, production build, compiled server checks,
production dependency audit, and the configured native-source/worker/frame checks.
Production browser workflows passed **38/38 Chromium** and **38/38 macOS WebKit**,
including phone viewports and the new native manual-entry/invalid-contact/short-
screen regression. Those redistributable synthetic-fixture CI tests are separate
from the public real-video runs, which used Chromium on this Windows workstation.

Later changes to the practical runner add retained native-event diagnostics,
separate conditional recovery reporting, continued independent checks after
failure, and focused actual-backup restoration. Their syntax and actual quiet
playback/backup checks passed. They do not alter the application or reclassify the
earlier failed observations as passes. Full local evidence is under ignored
`test-results/practicality/` and `test-results/practical-online/`.

## Reproduction and interpretation

The committed [practical pair harness](../e2e/practical-video-pair.mjs) uses real
files, native decoding, actual detector runs and downloads, disposable browser
storage, and a non-overwriting report. It never stubs the detector or playback
clock. The manifest must supply two known distinct attempts; different file
hashes alone do not prove distinct attempts. Omit `review.hold10` when contact is
unobservable. Operational cursor input is separate from independent annotation.

With a production preview already running, use Node 22:

```powershell
node e2e/practical-video-pair.mjs --url=http://127.0.0.1:5190/ --manifest=test-results/practical-online/edinburgh-manifest.json --report=test-results/practical-online/new-run.json --guided --phone --backup
```

For a focused backup check without another detector run, add
`--restore-backup=path/to/actual-downloaded-library.json` with a fresh report path.
Failed stages keep the overall report failed even when later independent checks
pass. An explicit Replay recovery action, if needed, is a separate reported stage.

The local manifest contains `clips: [{id, file, sourceUrl, athlete,
review: {start, finish, hold10: null, basis, isGroundTruthLabel: false}}, ...]`.
File paths resolve relative to the manifest. Use precise defined events for
actual measurements; the operational placeholder cursors used here are suitable
only for exercising mechanics. Scripts know the controls and do not measure
unaided human task completion or human correction time.

The existing fixed-phone clip produced a total quickly, and the tested desktop
save/review/replay mechanics worked. This convenience corpus does not yet
establish automatic usefulness across ordinary training recordings, correct
contact-defined section differences, or a training decision that a climber made.
Collect the independent fixed-phone study and observe real correction effort
before describing those outcomes as validated. Physical iPhone behavior remains
untested by these desktop and phone-viewport runs.
