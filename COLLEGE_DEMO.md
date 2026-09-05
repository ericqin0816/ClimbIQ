# ClimbIQ college demo guide

## One-sentence pitch

ClimbIQ turns an ordinary speed-climbing video into reviewable race timing, Hold 10 phase splits, and wall-projected biomechanics entirely in the browser.

## Two-minute demo

1. Open [climbiq-detection-lab.vercel.app](https://climbiq-detection-lab.vercel.app).
2. Upload one unedited, fixed-camera attempt with the complete lane visible.
3. Run full analysis and point out that the video stays on the device.
4. Show accepted Start, first movement, Finish, and total, explaining that detector confidence is not a measured accuracy percentage. Open a suggested marker and demonstrate Previous/Next Frame.
5. Inspect Hold 10 in the full video. Only accept a frame after checking the visible contact. Then show Start → Hold 10 and Hold 10 → Finish; these are not the same as COM wall-height halves.
6. Open Performance insights to show the wall-projected COM path, tracking confidence, and the lower/middle/top route-section analysis.
7. Download the JSON or Obsidian report to show that the result is portable and auditable.

## Current complete-reference result to discuss

On the complete private phone-video reference `IMG_9199.MOV`, repeated local and production tests retain these timing observations:

- Start: 7.130 s
- First movement: 7.230 s, or 0.100 s after Start
- Finish: 17.480 s
- Total: 10.350 s
- Current local COM: roughly 44–45/52 usable samples at 5 fps
- Route recovery: 19/20 matched hold silhouettes, versus 8 with the original diagram
- Hold 10: review required; the candidate cursor can vary between runs
- A workflow test accepting source frame 11.470 s produces bottom 4.340 s and top 6.010 s

The last line checks UI behavior and arithmetic, not contact correctness. Do not present that test's acceptance as a human label. A source-frame timestamp identifies an image; it does not prove when physical contact occurred between images.

The five-video regression automatically accepted two Starts (40% coverage) and sent three to review. This is an observed acceptance rate, not accuracy. The old precision figures have been withdrawn: the legacy correctness flags have no auditable independent review provenance, and direct frame inspection disputes the old 14.290 s finish suggestion for `IMG_8903.MOV`. The summary now reports accuracy as unavailable until independently reviewed labels are supplied.

Current work adds native frame timestamps/durations, frame-rate-aware stepping, a compact phone/desktop review layout, faster pixel-only capture, and wall-marker checks against ceiling highlights and uneven clock sizes. The closer contact scan may be inconclusive. Unaccepted finish suggestions cannot silently bound automatic COM analysis: accept Finish or supply an official total first.

## A stronger engineering story than an accuracy slogan

Show one successful complete workflow and one honest refusal. Explain the tests
that changed the implementation:

- Thirty controlled copies exposed resize, compression, exposure, frame-rate,
  audio and trim weaknesses. They are five source climbs, not thirty new people.
- A red obstruction and a late timer reset produced false finishes. The reset
  coincided with a foreground person, showing why two visual heuristics are not
  necessarily independent evidence.
- Native frame review passed 126 seek/pixel checks across five phone recordings
  and two synthetic frame-rate clips, including repeated-frame hashes and
  Previous/Next Frame round trips.
- Saved/exported timing distinguishes automatic acceptance, manual entry and
  frame review. None automatically becomes an independent accuracy label.
- A stopped-timer prototype was withheld because compressed red holds could
  imitate digits. Rejecting a promising but unreliable experiment is part of
  the validation story.

## What makes the project technically interesting

- It fuses the known countdown audio pattern, lane-light color transitions, lane-local athlete motion, and full-frame scene continuity.
- A sub-0.100 s visible-motion delay, camera cut, missing launch, implausibly delayed launch, or uncorroborated upper-wall event is sent to review. Visual body motion is not an electronic pad-release measurement or a false-start ruling.
- Angled footage does not assume that the lower start sensor and upper finish indicator share one screen x-coordinate.
- Finish detection timestamps the first connected return-color flash, verifies its later settled state, and rejects neutral occlusion, detached old flashes, scoreboards, and timing resets.
- Hold 10 uses hand-contact evidence. A COM halfway crossing is kept separate and cannot become an accepted Hold 10 marker.
- Every accepted/suggested timestamp retains its evidence source, confidence, raw time, correction, and review note in the export. Native frame duration is not advertised as an event-error bound.

## Honest limitations

- Edited multi-camera broadcasts are a safety stress test, not the same input class as fixed phone footage. Six men’s/women’s broadcast crops were all withheld for review rather than auto-accepted.
- Automatic wall scale is approximate. Precise metre and m/s claims need four manually marked lane corners and a fixed camera.
- The current private dataset is too small and related to claim general accuracy.
- Route recovery now identifies Hold 10 on the complete reference, but both hand-contact proposals and the approximate wall scale still need review. One successful route fit cannot establish reliability across gyms or cameras.
- Controlled resizing, exposure, compression, frame-rate and audio tests expose additional failures. A red obstruction produced a false 9.290 s finish and has been guarded against; some modified recordings still lose start availability or produce inaccurate review suggestions. The old 14.290 s reference is itself disputed, so the exact error must not be scored against it. Modified copies are not independent new climbs.

## Next defensible study

Collect 30–50 fixed-camera attempts across phones, gyms, lanes, lighting, angles, and athletes. Label Start, pad release, Hold 10, and Finish with official timing where possible and two independent frame reviewers. Report automatic coverage, false accepts, median and 95th-percentile timing error, Hold 10 agreement, and abstention/review rate. Keep broadcasts in their own rejection-safety cohort.

Full evidence and reproduction details are in [REAL_VIDEO_BENCHMARK.md](REAL_VIDEO_BENCHMARK.md).
