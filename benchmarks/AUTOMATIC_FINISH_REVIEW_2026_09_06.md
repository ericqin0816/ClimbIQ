# Automatic finish-target review

Baseline: 0.28.9, commit 01e031c. Candidate release: 0.28.10.
This is a review-navigation improvement, not a new contact detector or a
measurement of general timing accuracy. No benchmark labels were changed.

## Findings

The original IMG_9076 and its control/compact copies contain a persistent
compact upper target. Its horizontal position differs substantially from the
lower lane light because of perspective. Independent source-frame inspection
found the relevant athlete/target vicinity around 14.3 seconds. This is a
developer observation, not an independently annotated contact timestamp.

The old broad upper-motion review could prefer a later highest position during
the belay. The new pass uses the first sustained upward approach to choose a
short review window. On the control copy, the automatic window is 12.60–15.10
seconds. Its strip includes 14.267 seconds, without setting Finish.

Selecting only the largest local pixel change was also inadequate: in these
probes it preferred roughly 14.9–15.0 seconds. The delivered strip therefore
includes the entire approach window and the strongest change, not only the
peak's immediate neighbors.

## Hand-contact experiment not promoted

A source-cropped MediaPipe probe tracks torso and hand landmarks near the target.
The reaching hand becomes unreliable or occluded around the apparent contact,
even when the torso remains trackable. Later near-target hand points can occur
after an already accepted light-based Finish. Neither proximity nor best pose
confidence establishes the first physical press.

The experiment remains behind `e2e/finish-pad-probe.mjs --hands`; the application
does not run it. Its result is review evidence only. No visibility threshold,
contact radius, or timing-acceptance rule was relaxed to force a result.

## Delivered contract

- Only runs after an accepted Start and unresolved ordinary Finish checks.
- At most nine source-detail target frames, a 5 fps coarse search bounded by
  Start + 3 through Start + 30 seconds, and a 2.5-second 15 fps close-up scan.
- Persistent compact green/blue candidates; red displays and white lamps do not
  qualify. Ambiguous groups and unsupported lane assignments are withheld.
- Distinct frame support, an approach from below, and local scene continuity
  are required for the strip. The target is still explicitly unverified.
- At most eight transient close-ups, including the first-approach window.
- Does not set a user pad zone, accept Finish, create COM, export labels, or
  replace an accepted light timestamp. A marked pad takes precedence.
- Saving keeps on-screen evidence. Loading a session, changing video/Start,
  and rerunning Finish invalidate the old automatic review evidence.

These heuristics can miss targets or select the wrong colored feature. They
are not trained/validated pad recognition. Fixed-camera footage and user review
remain necessary when electronic timing cannot be verified.

## Verification

- `npm run check`: 621 tests across 61 files, typecheck and build pass.
- Six-original replay: accepted timing unchanged; the 12.240-second user total
  still produces 12.255 seconds. This single total does not validate either raw
  endpoint independently.
- Eight public clips: all remained review-only; the post-finish broadcast-tone
  false Start remained blocked. These clips are rejection tests, not accuracy
  labels for edited broadcasts.
- Five checksummed transformations paired with the previous 36-case matrix:

| Copy | Accepted Start, before and after | Accepted Finish, before and after |
| --- | --- | --- |
| IMG_9076 control-720 | 2.900 s | Unset |
| IMG_9076 compact-360 | 2.967 s | Unset |
| IMG_9076 low-fps-720 | Unset | Unset |
| IMG_9076 silent-720 | 2.917 s | Unset |
| IMG_8903 dark-720 | 4.290 s | Unset |

The window-reflection, spectator/timer-reset, and red-obstruction failure
fingerprints remained blocked. This release reran these five transformations,
not all 36 matrix cases.

Browser review tests cover manual marking, native-frame rescanning, cancellation,
save/reload, export/import, automatic localization without pad marking,
thumbnail navigation without acceptance, mobile layout, and replacement cleanup.
The automatic-only test also passed with `VideoFrame` unavailable. The React
review checklist caught a save-session invalidation bug, which was fixed and
added to the browser assertions.

Cancellation during the new target scan also passed: the recorded response was
448 ms, the paused cursor was restored, accepted markers remained unchanged,
and replacement was blocked while scanning. This is a local observation, not a
latency guarantee.

Initial browser verification exposed a premature assertion before the decoded
close-up was ready; it now waits for the caption. A subsequent local dev-server
run failed to fetch a dynamic module; the fresh run passed. No benchmark
expectation was changed to bypass either failure.

## Local-only evidence

Private frames, video, detailed landmarks, and generated JSON remain ignored.
Useful local reports include:

- `test-results/finish-pad-probe-9076-crop.json`: experimental hand visibility.
- `test-results/finish-pad-probe-9199.json`: later hand proximity is not first contact.
- `test-results/finish-pad-review-9076.json`: rejected peak-only navigation experiment.
- `test-results/finish-target-originals-final-0.28.10.json`: original replay.
- `test-results/finish-target-public-0.28.10.json`: public rejection replay
  (development UI still displayed 0.28.9 before the version-label update).
- `test-results/finish-target-transforms-0.28.10.json`: targeted stress/safety replay.

The unrelated local stylesheet changes were preserved and excluded from the
release. Production uses the committed stylesheet.
