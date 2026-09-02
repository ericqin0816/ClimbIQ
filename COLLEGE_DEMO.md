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

## Measured result to discuss

On the complete private phone-video baseline `IMG_9199.MOV`, local and public-production runs matched exactly:

- Start: 7.130 s
- First movement: 7.230 s, or 0.100 s after Start
- Finish: 17.480 s
- Total: 10.350 s
- COM: 42/52 usable frames at 5 fps
- Reviewed Hold 10 cursor: 11.515 s raw, or 4.385 s after Start
- Bottom phase: 4.385 s (42.4% of the race)
- Top phase: 5.965 s (57.6% of the race), 1.580 s longer

The complete five-video private regression automatically accepts two Starts (40% coverage), sends three to review, and has zero known false automatic Starts. Both accepted Starts were manually checked. That is a small regression set, not a population accuracy estimate: its 2/2 precision has a wide 95% Wilson interval of 34.2%–100%. One manually checked automatic Finish is correct, with the expected wider 20.7%–100% interval for 1/1.

## What makes the project technically interesting

- It fuses the known countdown audio pattern, lane-light color transitions, lane-local athlete motion, and full-frame scene continuity.
- A sub-0.100 s visual reaction, camera cut, missing launch, implausibly delayed launch, or uncorroborated upper-wall event is sent to review instead of being silently accepted.
- Angled footage does not assume that the lower start sensor and upper finish indicator share one screen x-coordinate.
- Finish detection timestamps the first connected return-color flash, verifies its later settled state, and rejects neutral occlusion, detached old flashes, scoreboards, and timing resets.
- Hold 10 uses hand-contact evidence. A COM halfway crossing is kept separate and cannot become an accepted Hold 10 marker.
- Every accepted/suggested timestamp retains its evidence source, confidence, raw time, correction, and review note in the export.

## Honest limitations

- Edited multi-camera broadcasts are a safety stress test, not the same input class as fixed phone footage. Six men’s/women’s broadcast crops were all withheld for review rather than auto-accepted.
- Automatic wall scale is approximate. Precise metre and m/s claims need four manually marked lane corners and a fixed camera.
- The current private dataset is too small and related to claim general accuracy.
- Route registration did not reach the automatic Hold 10 threshold on the complete baseline, so the demonstrated Hold 10 split is human-confirmed from a review cursor.

## Next defensible study

Collect 30–50 fixed-camera attempts across phones, gyms, lanes, lighting, angles, and athletes. Label Start, pad release, Hold 10, and Finish with official timing where possible and two independent frame reviewers. Report automatic coverage, false accepts, median and 95th-percentile timing error, Hold 10 agreement, and abstention/review rate. Keep broadcasts in their own rejection-safety cohort.

Full evidence and reproduction details are in [REAL_VIDEO_BENCHMARK.md](REAL_VIDEO_BENCHMARK.md).
