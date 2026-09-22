# Analysis scope: timing parity and desktop runtime

The **Start & finish only** scope completed sooner than **Full analysis** on
both tested recordings while preserving exactly the same accepted Start and
Finish evidence. Full analysis remains the default.

## Measured results

Two paired repeats per recording, in seconds from Analyze click to fully idle UI:

| Recording | Timing-only median | Timing-only range | Full median | Full range | Median paired difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| `12.24.mov` | 5.176 | 4.957–5.395 | 13.011 | 12.994–13.028 | 7.835 |
| `IMG_9199.MOV` | 13.796 | 13.739–13.853 | 23.275 | 23.211–23.339 | 9.479 |

All four pairs matched exactly on accepted and detected raw times, climb times,
offsets, sources, confidence, observation intervals, and acceptance provenance:

| Recording | Accepted Start (raw s) | Accepted Finish (raw s) |
| --- | ---: | ---: |
| `12.24.mov` | 9.400 | 21.655 |
| `IMG_9199.MOV` | 7.121 | 17.472 |

Both modes retained automatic High-confidence fused Starts and light-detected
Finishes. The Finish observation interval remained 0.035 s; Start had no
recorded interval in these runs. Neither confidence nor sampling interval is a
measured event-accuracy bound.

## Workflow checks

- Timing-only produced no movement candidates or accepted movement markers,
  pose/COM frames, route overlay, Hold 10 evidence, or candidate preview images.
  Model requests, Worker construction, CDP worker creation, and PNG frame
  encoding were all zero. Full runs encoded 18 candidate preview frames each,
  confirming that the capture counter exercised the existing preview path.
- Running Full after timing-only produced a usable full analysis. Switching
  the same open recording back to timing-only preserved exact Start/Finish
  evidence and cleared the prior movement, COM, Hold 10, and preview output.
  The reverse check deliberately retained the in-memory model cache; network
  silence alone was not treated as proof that pose work was skipped.
- `IMG_9075.MOV` paused for Start review in timing-only mode. After the scope
  selector changed to Full, accepting the displayed 8.435 s frame still resumed
  the originally captured timing-only scope. The marker retained Low confidence
  and `frame-review` provenance; Finish remained unset.

## Method and limits

The harness ran against a frozen production build of version 0.29.0, entry
bundle `assets/index-DTb3F-wr.js`, in desktop Chrome on 2026-09-22. Each paired
run used a fresh document and cleared HTTP cache in an owned temporary browser
profile. Pair order alternated; video/model tests ran serially. There were
**two repeats per clip**, not a broad device or recording sample.

Timing uses the browser clock immediately before the Analyze click and ends
when the UI becomes idle, including queued video work. A 250 ms quiet period
confirms completion but is excluded from the duration. File selection/loading,
manual review pauses, and export inspection are excluded. The same-page Full
upgrade (15.248 s) and reverse timing-only run (5.362 s) are separate workflow
checks and are excluded from the paired medians.

These measurements use unmodified local recordings and real detector/model
execution, without mocked network responses or pixels. The automated review
click tests continuation; it does not independently establish the physical Start
instant. Synthetic tests elsewhere and recorded review acceptance must not be
promoted to real-event ground truth.

Full analysis still showed COM variability: the two fresh-document `12.24.mov`
runs had 39/62 and 35/62 usable frames, versus 46/62 in the warm same-page Full
upgrade. Warm here means retained page/video state; timing-only had not loaded
the pose model. `IMG_9199.MOV` had 45/52 in both full runs. This benchmark does not
establish COM parity or spatial accuracy. It also does not establish iPhone
performance, battery use, or general timing accuracy. Timing-only retains the
same Start/Finish gates; it saves work by omitting later movement analysis.

## Reproduce

Keep source recordings local. Build once, then leave the served production
output unchanged until the run finishes. In the first terminal:

```powershell
$env:COACHING_ENABLED = '0'
npm run build
npx vite preview --host 127.0.0.1 --port 4173 --strictPort
```

In a second terminal:

```powershell
$env:CLIMBIQ_E2E_URL = 'http://127.0.0.1:4173/'
$env:CLIMBIQ_VIDEO_DIR = 'path/to/local-recordings'
node e2e/timing-scope.mjs --report=test-results/timing-scope.json
```

Defaults are two repeats of `12.24.mov` and `IMG_9199.MOV`, plus the same-page
scope switches and `IMG_9075.MOV` Start-review case. The harness rejects a Vite
development server unless explicitly run with `--allow-dev`; such runs should
not replace production measurements. Its isolated browser and temporary profile
are closed and removed after the run.

The local evidence file is
`test-results/timing-scope-atomic-2026-09-22.json`; it records source SHA256s,
per-run durations, exact marker projections, stage transitions, and assertions.
Private recordings, frame pixels, and local absolute paths are not included in
this tracked summary.
