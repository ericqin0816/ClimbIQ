# Pose performance work log

This work measures desktop-browser execution of existing recordings. It does not establish independent timing or pose accuracy, and it is not an iPhone benchmark.

## Baseline and repeatable method

The starting commit is `3f110af` (the first iPhone beta foundation). Before production performance changes, the existing full-workflow runner passed both selected originals:

| Original | Full workflow elapsed | Usable COM frames |
| --- | ---: | ---: |
| `12.24.mov` | 29.328 s | 46 / 62 |
| `IMG_9199.MOV` | 38.782 s | 44 / 52 |

These times include saving, reloading, comparison, and review checks; they are not inference-only latency. Source checksums and full outcomes are in the local ignored report `test-results/pose-performance-baseline-full.json`. The existing recordings and their reference limitations remain described in [REAL_VIDEO_BENCHMARK.md](../REAL_VIDEO_BENCHMARK.md).

`e2e/pose-performance.mjs` isolates the pose pass using the calibration, identity zone, accepted interval, and original-video checksum from a full-workflow report. It creates a fresh pose tracker for every repeat and records elapsed time, time to the first sample, event-loop delay, long tasks, model requests, output frames, and optional Chrome CPU profiles. It never uploads videos. Run browser benchmarks one at a time, with source edits and other CPU-intensive jobs paused.

```sh
node e2e/real-video-timing.mjs --full --report=test-results/pose-baseline.json 12.24.mov IMG_9199.MOV
node e2e/pose-performance.mjs --reference=test-results/pose-baseline.json --report=test-results/pose-direct.json --repeats=3 --profile
```

The direct runner imports source modules and needs the local Vite development server. Production/native validation still uses the normal application flow. The profiling option adds measurement overhead, so compare profiled runs with profiled runs, or use separate unprofiled runs for final speed comparisons. JS heap measurements do not include all WASM/GPU/native memory.

An initial exploratory profile showed MediaPipe WASM and pixel readback dominating the pose pass, with many synchronous tasks over 50 ms. Some other files were being edited during that exploratory run; it is not used to claim a before/after speedup. Google documents that `detectForVideo` is synchronous and suggests workers to keep inference off the UI thread. See the [official Pose Landmarker web guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

## Verified model cache

The first change retains at most one verified model in memory and starts model loading alongside the module import. The original byte-length and SHA-256 checks remain required before a model enters the cache. Each caller gets a private copy, so changes to one task's buffer cannot change the verified cache. Failed or cancelled loading never becomes a cached success; callers sharing a pending load can cancel independently, and the fetch is aborted when no caller needs it.

Only model bytes are shared. Each analysis creates and closes its own VIDEO-mode tracker, with the existing detection thresholds, two-person search, identity checks, crop geometry, and source-frame sampling intact. The cache retains approximately 9.4 MB until the page is unloaded or it is explicitly cleared. This memory cost must be considered during real-iPhone testing.

Cache tests cover integrity failures, HTML fallback, concurrent consumers, mutation isolation, cancellation before/during hashing, immediate retry after abort, changed model identity, and explicit cache clearing.

## Stable cache comparison

The paired runs below used Chrome 153.0.8010.53 on Windows with an AMD Ryzen 7 8700F (8 cores / 16 threads), with source edits and other runtime benchmarks paused. The old source was loaded from a benchmark-only copy of commit `3f110af`, so no shared production files were swapped during the comparison. Both sequences used CPU profiling. Full aggregate evidence is in [pose-performance-2026-09-22.json](../benchmarks/pose-performance-2026-09-22.json).

| Measurement | Original implementation | Model cache |
| --- | --- | --- |
| Model fetches after three passes in one page | 3 | 1 |
| `12.24.mov` first-sample times, warm passes | 197.6 / 190.7 ms | 190.4 / 176.6 ms |
| `IMG_9199.MOV` first-sample times, warm passes | 200.0 / 208.2 ms | 184.2 / 192.1 ms |
| `12.24.mov` usable frames, three passes | 45 / 35 / 35 of 62 | 45 / 35 / 35 of 62 |
| `IMG_9199.MOV` usable frames, three passes | 43 / 42 / 42 of 52 | 42 / 42 / 42 of 52 |

The first-sample measurement includes setup, seeking, and the first inference; it is not isolated model-loading time. The warm improvement was only about 7–16 ms in these runs. Overall pass times were roughly 3.5–5.6 s and remain dominated by inference. Differences in total time cannot confidently be attributed to the cache from this small sequential test. The demonstrated benefit is avoiding repeated model fetch/verification work, with a bounded memory cost; this is not a claim of a large overall speedup.

Decoded source timestamps matched for every paired repeat. All `12.24.mov` frame outputs and both warm `IMG_9199.MOV` outputs matched exactly. The cold 9199 output differed by one usable frame, within variability already observed before caching.

A separate `--pixel-probe` run captured a SHA-256 of every actual crop before inference, retaining only hashes and crop metadata. All four paired clip/repeat runs had identical crop hashes, source/crop metadata, and complete frame outputs: 80 crops per 12.24 pass and 53–54 crops per 9199 pass. This checks input/output parity in that instrumented path; it is not an accuracy label.

The extra pixel readback changes baseline behavior itself: warm 12.24 passes retained 45 frames with the probe versus 35 without it. That is pre-existing sensitivity to rendering/instrumentation and must not be called an improvement from the cache. Pixel-probe times are deliberately excluded from the speed comparison. Further rendering investigation should compare fixed crop pixels and fresh tracker state before changing the model or sampling policy.

The subsequent normal six-original application workflow passed with the cache. The two selected clips retained the full-workflow baseline's 46/62 and 44/52 usable COM frames and matching accepted timing. This distinguishes the normal UI regression result from the isolated direct-run harness's rendering sensitivity.

## Worker experiment

Worker transport and inference modules are being evaluated separately and are not yet selected by the normal pose-analysis path. A worker must own a fresh tracker per analysis, accept only one pending frame, release transferred images, and terminate immediately on cancellation. Automatic fallback is permitted only before frame processing begins; a mid-run worker failure must not silently mix outputs from a newly initialized tracker.

Before enabling a worker path, compare actual crop pixels, source timestamps, selected identity, usable COM coverage, derived outputs, and cancellation behavior with the main-thread baseline. Feature detection and startup failure must preserve a working main-thread path for unsupported devices. Desktop results cannot establish WKWebView or iPhone behavior.
