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

## Repeated crop rendering

The crop canvas now requests `willReadFrequently: true` from creation. This asks the browser to prefer software rendering for the fractional video crop; it adds no explicit pixel-readback loop. The model, tracker options, crop geometry, identity checks, and timing gates remain unchanged. The [canvas specification](https://html.spec.whatwg.org/multipage/canvas.html) describes the software preference and leaves the precise smoothing algorithm to the browser, so this is not a guarantee of identical behavior across browsers or devices.

The earlier variation was reproduced in an ignored, frozen laboratory build. It logged exact crop rectangles, source-frame timestamps, and raw unrounded model outputs. Ordinary rendering used no additional pixel reads or VideoFrames. Every repeat used a fresh VIDEO tracker. Three passes per condition, two complete recordings, both backends, fresh browser processes, reversed order, and fixed-pixel replays were compared. Input recordings were checked by checksum and stayed local. See [pose-repeatability-2026-09-22.json](../benchmarks/pose-repeatability-2026-09-22.json) for hashes and aggregate results.

| Control | Observation in desktop Chrome |
| --- | --- |
| Ordinary canvas, `12.24.mov` | 45, 35, 35 usable COM frames; raw outputs diverged at 10.2 s despite the same crop rectangle and source timestamp. |
| Add 5 ms after every crop | Each run's raw output exactly matched its corresponding ordinary run; waiting alone did not remove the variation. |
| Software preference from creation | 44, 44, 44 frames; exact raw outputs, crop sequence, and result frames across main-thread, worker, and reversed-order fresh-process runs. |
| Explicit readback before or after inference | Both sequences gave 45, 45, 44 frames and matching corresponding raw outputs. Readback changed later rendering behavior and was not a stable substitute. |
| Replay one captured RGBA sequence | Three fresh trackers per backend exactly matched the capture and each other. |
| Second recording, `IMG_9199.MOV` | Both paths repeated consistently; software gave 43/52 in the direct harness and matched exactly between backends. |

A separate rendering probe held the same NV12/BT709 source frame at 10.171667 s. Full-frame RGBA pixels matched exactly between ordinary and software canvases. The fractional video crop differed in 2,854 of 182,016 channel values, each by one byte level, in either draw order. Drawing the pinned VideoFrame instead followed another consistent crop path. This supports a source/resampling-path explanation rather than a wrong source timestamp or a broad color-conversion error. The internal browser backing was not measured, and pixel readback itself affects execution, so these observations do not identify a specific GPU implementation bug.

This change trades some speed for the demonstrated repeatability. On the second clip, the three-run median rose from about 3.80 to 4.48 s on the main thread and 3.84 to 4.53 s in the worker. Those timings include different resulting crop trajectories; they are not isolated rendering costs. The first clip showed no comparable total-pass penalty. Software rendering changes model inputs and outputs: neither a larger nor smaller usable-frame count establishes accuracy.

The frozen application prototype passed all six original workflows. Accepted timing stayed unchanged; the unverified-Finish clip still paused COM, and the three weak-Start clips still required review. The complete clips produced 44/62 and 44/52 usable COM frames under the application's settings, which differ from the direct harness's defaults. Actual pointer cancellation reached its handler in 2 ms and restored the cursor in 1.690 s in one desktop run. Native WKWebView repeatability, cost, heat, and battery remain unverified; native inference still uses the existing main-thread backend.

The permanent `e2e/pose-repeatability.mjs` check runs Full analysis repeatedly on the same recording and document, comparing complete pose frames, accepted markers, calibration, athlete identity, and source-frame audit. It checks the original local recording checksums and refuses a Vite development page. With an immutable production preview running on port 4173 and the original private clips available locally:

```sh
node e2e/pose-repeatability.mjs --repeats=2 --report=test-results/pose-repeatability.json
```

`CLIMBIQ_E2E_URL` selects another preview and `CLIMBIQ_VIDEO_DIR` selects the local recording directory. This regression is separate from synthetic CI checks; it needs the two original recordings and does not upload or commit them.

The subsequent build emitted from the source change passed this check: two consecutive Full analyses on each loaded recording produced identical complete pose frames, accepted markers, calibration, identity region, and source-frame audit. A second browser invocation reproduced the same frame hashes. The current build also passed all six original full workflows and kept the review/rejection outcomes above. Its pointer-cancel observation was 1 ms to the handler and 1.707 s through cursor restoration, with one worker created and terminated and none pending.
