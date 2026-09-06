# ClimbIQ

Video analysis for speed climbing, running in your browser.

[Open the app](https://climbiq-detection-lab.vercel.app) · [How it works](docs/analysis-reference.md) · [Evaluation](REAL_VIDEO_BENCHMARK.md)

[![CI](https://github.com/ericqin0816/ClimbIQ/actions/workflows/ci.yml/badge.svg)](https://github.com/ericqin0816/ClimbIQ/actions/workflows/ci.yml)

Load a race recording to inspect its timing and the climber's estimated motion.
Each result stays linked to the video so you can check the relevant frame,
correct a marker, or compare two saved attempts.

The video stays on your device. ClimbIQ has no video-upload backend or account
requirement. It is an experimental analysis tool, not a replacement for a race
timing system.

## Try a recording

1. Open the app and choose a local MOV or MP4 that your browser can decode.
2. Use one unedited attempt with a fixed camera and the complete lane visible.
3. Select **Run full analysis**. Review any uncertain markers in the video.
4. Save the attempt or download its data. Saved attempts stay in that browser;
   export the library to move them to another computer.

The default start search covers the first 12 seconds. For a longer recording,
set the race's time window in **Review & advanced tools**.

## What it measures

| Result | Evidence and limits |
| --- | --- |
| Start and finish | Countdown audio and visible timing-light changes, checked against athlete motion and camera continuity. Weak evidence stays available for review. |
| First movement | Pixel motion near the selected climber. This is not an electronic reaction-time measurement. |
| Start → Hold 10 → Finish | Contact-defined phases, shown after the Hold 10 frame has been reviewed and accepted. A halfway height crossing is a separate estimate. |
| Motion and wall sections | MediaPipe pose tracking projected onto a calibrated wall plane. Camera movement, occlusion, and uncertain geometry can make these results unavailable. |

You can inspect and correct individual markers. Exports retain their evidence
source and distinguish automatic results, manual entries, and frame reviews.

## Inside the analyzer

Timing and pose tracking are separate. Missing a wrist landmark cannot silently
move an accepted start or finish. The timing pipeline searches for light changes,
combines them with audio cues, and checks whether the selected athlete launches
after the proposed start. Pose analysis runs within the accepted climb interval.

The implementation uses React, TypeScript, and Vite; Canvas and Web Audio handle
local media; MediaPipe Pose Landmarker runs on-device through WebAssembly. The
repository includes deterministic detector tests and real-browser video replay
tools.

## Validation

The test set includes six private phone recordings and eight public broadcast
crops. Controlled copies test compression, resizing, exposure, frame rate,
missing audio, and trimming. The copies are stress tests of the same recordings,
not additional independent climbs. Broadcasts test rejection of misleading
cues; they are not evidence that the app times edited race footage accurately.

For one recording with a user-reported **12.240 s** total, native-frame analysis
returned **12.255 s**. That 15 ms difference is a single total-time comparison,
not a general error bound or independent validation of either endpoint.

General timing accuracy has not been established. The next evaluation needs
independently reviewed start, Hold 10, and finish labels across more cameras and
gyms. [Read the benchmark methodology and known limitations](REAL_VIDEO_BENCHMARK.md).

## Run locally

Use Node.js 22, matching [.nvmrc](.nvmrc).

```bash
git clone https://github.com/ericqin0816/ClimbIQ.git
cd ClimbIQ
npm ci
npm run dev
```

```bash
npm run check       # Typecheck, unit tests, production build
```

Real-video tests need a running dev server, Chrome, and local recordings.
Private videos are deliberately excluded from Git. See the
[testing instructions](CONTRIBUTING.md#testing-with-recordings) for setup.

## Documentation

- [Analysis reference](docs/analysis-reference.md): detector behavior, calibration, review tools, saved sessions, and exports.
- [Benchmark methodology](REAL_VIDEO_BENCHMARK.md): regression observations, label provenance, and known failures.
- [Demo guide](COLLEGE_DEMO.md): a short walkthrough with results and limitations to discuss.
- [Contributing](CONTRIBUTING.md): development setup, reproducible bug reports, and test expectations.
