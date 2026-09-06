# Contributing

ClimbIQ is a browser application. Most changes belong in `src/lib` (analysis),
`src/components` (interface), or `src/App.tsx` (workflow). Tests sit beside the
modules they exercise. Browser workflows live in `e2e`.

## Development

Use Node.js 22 and install the locked dependencies with `npm ci`. Run
`npm run dev` for the app and `npm run check` before submitting a change. The
latter runs typechecking, unit tests, and the production build.

Keep unrelated edits out of a change. Explain the behavior being changed and
include a failing regression test when fixing a bug. For interface changes,
check the complete flow at desktop and phone widths.

## Testing with recordings

Place recordings in `node_modules/.climbiq-private-videos/`, or set
`CLIMBIQ_VIDEO_DIR` to a local folder. These files are not distributed with the
repository. The browser runner uses a separate temporary Chrome profile.

With the development server running:

```bash
npm run benchmark:timing -- --full example.mov
npm run test:cancellation
npm run test:finish-review
npm run test:audio-browser
```

The cancellation and Finish review suites expect the named private fixtures in
their scripts. The audio suite generates synthetic signals and needs no private
recording. `CLIMBIQ_CHROME` can point to a nonstandard Chrome installation.

Use `--report=test-results/run.json` with the timing runner to retain a local
report. `--full` includes tracking, saving, reloading, comparison, and review
checks. Timing-only mode stops before the full pose workflow.

For controlled variations of a recorded benchmark fixture:

```bash
npm run benchmark:robustness -- --full IMG_9199.MOV
npm run benchmark:compare -- before.json after.json --tolerance=0.01
```

Set `CLIMBIQ_FFMPEG` to a local FFmpeg executable for transformations; the
Windows fallback path is a local development dependency, not a bundled tool.
Reports pair source and transformed-file checksums before comparing outputs.

A new automatic acceptance needs inspection just as a lost result does. Do not
change a benchmark expectation only to make a test pass. Record why the output
changed and distinguish a regression observation from an independently reviewed
label. Keep false starts, timer resets, camera cuts, and unrelated foreground
motion in rejection tests.

## Reporting a problem

Include the app version, browser, steps to reproduce, expected behavior, and
what happened. For timing problems, note the raw video time as well as the
displayed climb time. State whether the reference comes from an official timer,
your own frame review, or an earlier app result.

Review diagnostic exports before posting them: they can contain video filenames,
athlete notes, timestamps, and pose coordinates. Do not attach another person's
video, private footage, or a private sharing link without permission. Synthetic
fixtures or a small reproducible signal trace are preferable when they capture
the same bug.
