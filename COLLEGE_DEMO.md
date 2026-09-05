# ClimbIQ college demo guide

## One-sentence pitch

ClimbIQ turns an ordinary speed-climbing video into reviewable race timing, Hold 10 phase splits, and wall-projected biomechanics entirely in the browser.

## Two-minute demo

1. Open [climbiq-detection-lab.vercel.app](https://climbiq-detection-lab.vercel.app).
2. Upload one unedited, fixed-camera attempt with the complete lane visible.
3. Run full analysis and point out that the video stays on the device.
4. Show the accepted Start, first movement, Finish, and total. Open any suggested marker to demonstrate exact-frame review rather than a black-box answer.
5. Review Hold 10. Once its exact contact frame is accepted, show Start → Hold 10, Hold 10 → Finish, bottom/top race shares, and the slower-phase difference.
6. Open Performance insights to show the wall-projected COM path, tracking confidence, and the lower/middle/top route-section analysis.
7. Download the JSON or Obsidian report to show that the result is portable and auditable.

## Historical 0.23.0 result to discuss

On the complete private phone-video baseline `IMG_9199.MOV`, local and public-production runs matched exactly:

- Start: 7.130 s
- First movement: 7.230 s, or 0.100 s after Start
- Finish: 17.480 s
- Total: 10.350 s
- COM: 42/52 usable frames at 5 fps
- New local route recovery: 19/20 matched hold silhouettes, versus 8 with the original diagram
- New local contact-review cursor: 11.440 s raw; no Hold 10 marker is automatically accepted
- Accepting that cursor in a workflow test yields bottom 4.310 s and top 6.040 s

The Hold 10 acceptance test checks the UI and arithmetic, not a new ground-truth label. Its detailed scan retains 26/26 selected athlete samples; tracking coverage is not proof of exact contact timing. The previously production-verified timing/COM values above are unchanged in the local 0.23.0 regression.

The five-video regression automatically accepted two Starts (40% coverage) and sent three to review. This is an observed acceptance rate, not accuracy. The old precision figures have been withdrawn: the legacy correctness flags have no auditable independent review provenance, and direct frame inspection disputes the old 14.290 s finish suggestion for `IMG_8903.MOV`. The summary now reports accuracy as unavailable until independently reviewed labels are supplied.

Current overnight work adds decoded-frame timestamp provenance, faster pixel-only capture, and a wall-marker fix tested against ceiling highlights and uneven clock sizes. The complete reference retains 44–45/52 usable motion frames and 19 registered holds in current local tests. Its closer contact scan may be inconclusive; it must remain a review aid. Unaccepted finish suggestions no longer silently bound automatic COM analysis: accept the finish or supply an official total first.

## What makes the project technically interesting

- It fuses the known countdown audio pattern, lane-light color transitions, lane-local athlete motion, and full-frame scene continuity.
- A sub-0.100 s visible-motion delay, camera cut, missing launch, implausibly delayed launch, or uncorroborated upper-wall event is sent to review. Visual body motion is not an electronic pad-release measurement or a false-start ruling.
- Angled footage does not assume that the lower start sensor and upper finish indicator share one screen x-coordinate.
- Finish detection timestamps the first connected return-color flash, verifies its later settled state, and rejects neutral occlusion, detached old flashes, scoreboards, and timing resets.
- Hold 10 uses hand-contact evidence. A COM halfway crossing is kept separate and cannot become an accepted Hold 10 marker.
- Every accepted/suggested timestamp retains its evidence source, confidence, raw time, correction, and review note in the export.

## Honest limitations

- Edited multi-camera broadcasts are a safety stress test, not the same input class as fixed phone footage. Six men’s/women’s broadcast crops were all withheld for review rather than auto-accepted.
- Automatic wall scale is approximate. Precise metre and m/s claims need four manually marked lane corners and a fixed camera.
- The current private dataset is too small and related to claim general accuracy.
- Route recovery now identifies Hold 10 on the complete reference, but both hand-contact proposals and the approximate wall scale still need review. One successful route fit cannot establish reliability across gyms or cameras.
- Controlled resizing, exposure, compression, frame-rate and audio tests expose additional failures. A red obstruction produced a false 9.290 s finish and has been guarded against; some modified recordings still lose start availability or produce inaccurate review suggestions. The old 14.290 s reference is itself disputed, so the exact error must not be scored against it. Modified copies are not independent new climbs.

## Next defensible study

Collect 30–50 fixed-camera attempts across phones, gyms, lanes, lighting, angles, and athletes. Label Start, pad release, Hold 10, and Finish with official timing where possible and two independent frame reviewers. Report automatic coverage, false accepts, median and 95th-percentile timing error, Hold 10 agreement, and abstention/review rate. Keep broadcasts in their own rejection-safety cohort.

Full evidence and reproduction details are in [REAL_VIDEO_BENCHMARK.md](REAL_VIDEO_BENCHMARK.md).
