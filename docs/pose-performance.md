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

## Worker inference and its limits

Browser analysis now tries a fresh worker for each pose pass; Capacitor native apps keep main-thread inference by default until real-device verification. This uses `Capacitor.isNativePlatform()`, not browser-name guessing. Developers can deliberately build with `VITE_POSE_EXECUTION=main-thread`, `auto`, or `worker` to force a comparison or return to the original path. Do not mistake an override build for a verified native configuration.

The worker uses the same Full model, CPU delegate, VIDEO tracker options, crop geometry, sampling, and identity checks. It accepts one frame at a time, closes transferred images, and terminates on completion or cancellation. A new task always gets a new tracker. Automatic fallback is allowed only during startup: missing worker/OffscreenCanvas/ImageBitmap support, blocked workers, or initialization failure selects the existing main-thread implementation before any inference result is used. Mid-run failure aborts that analysis rather than mixing outputs from another tracker.

The installed MediaPipe 0.10.35 resolver's module mode uses `vision_wasm_module_internal.js` and `.wasm`, both already included in the bundled public assets. The `.js` loader is an ES module despite its extension. The iOS setup checker also verifies this pair is present.

Detailed observations are in [pose-worker-2026-09-22.json](../benchmarks/pose-worker-2026-09-22.json):

- Four paired main-thread/worker pixel-probe runs produced identical crop SHA-256 lists and identical complete frame outputs, including selected identity, COM, source times, and derived metrics. These checks cover two existing recordings and do not create accuracy labels.
- In worker runs without pixel probing or CPU profiling, maximum event-loop delay was about 2–4 ms; corresponding main-thread runs had roughly 100–220 ms stalls. Whole pose passes still took about 3.9–5.5 s. The demonstrated improvement is responsiveness, not a blanket throughput speedup.
- Real browser cancellation during worker initialization and inference settled in roughly 0.1–0.3 ms after the abort signal. A retry succeeded. Missing-API fallback and an actual `worker-src 'none'` CSP both completed using the main-thread backend. Every owned worker was terminated, with no pending workers or duplicate termination calls. This verifies ownership cleanup, not all native/GPU memory behavior.
- A frozen **production build**, independent of Vite HMR, passed both normal full workflows: accepted timing, source provenance, dense Hold 10 retry, explicit contact review, saved attempts, reload, and lineage-aware comparison. It retained 46/62 and 45/52 usable COM frames. Hold 10 remained unaccepted until explicit review.
- On that production build, an actual pointer click on the app's Cancel button while a worker inference was pending reached its handler in 3 ms. Cancellation was acknowledged after 1.654 s, including restoring the paused video's cursor. Accepted timing stayed intact and the worker was terminated.

After selecting the final browser-auto/native-main defaults and adding the transactional video-import checks, a new frozen production build with **no execution override** passed both complete workflows again. Its actual pointer-cancel test reached the handler in 9 ms and completed cancellation/restoration in 1.645 s, with one worker created and terminated and no pending frame. These are individual local observations, not a guaranteed latency bound.

Native WKWebView, device heat, battery, memory pressure, and actual iPhone responsiveness remain unverified. Native builds therefore retain the existing main-thread backend unless a developer explicitly overrides it for testing. The model cache applies to both platforms.

## Production worker packaging smoke

After `npm run build`, run `node e2e/pose-worker-build-smoke.mjs`. This synthetic-only check owns an ephemeral preview server and browser profile, finds the emitted worker through the built app's actual module graph, and verifies the served assets match the selected build. It initializes the packaged model and module WASM loader in a strict worker, sends two blank frames, requires valid array replies, and terminates the worker. It cannot silently pass using the main-thread fallback. No private recordings, labels, or pose-accuracy assertions are involved.

Use `--build-dir path` for a frozen build or `--url http://127.0.0.1:port/` for an existing preview; an existing preview must serve the same selected build. The first local run checked 24 built assets and passed with one worker created and terminated. This catches production bundling/loader regressions; it does not replace the real-video parity or native-device checks above.
