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

Keep original recordings outside the project and set `CLIMBIQ_VIDEO_DIR` to
their local folder. The runner defaults to `node_modules/.climbiq-private-videos/`
for disposable test copies only: `npm ci` replaces `node_modules`, so never keep
your only copy there. Recordings are not distributed with the repository. The
browser runner uses a separate temporary Chrome profile.

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
The timing runner uses debugging port 9334 by default; set `CLIMBIQ_E2E_PORT`
to a different unused port when running another isolated replay concurrently.

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

To inspect every discovered start-light patch and its local motion evidence,
use the diagnostic probe with a local Vite server:

```bash
node e2e/start-lane-probe.mjs --detail --report=test-results/lanes.json /path/to/clip.mov
```

Omit `--detail` for the standard discovery pass. This probe does not accept
timestamps or produce accuracy labels; the full browser workflow still has to
pass its artifact, launch, and Finish checks.

For automatic finish-target review diagnostics:

```bash
node e2e/finish-pad-probe.mjs --start=2.9 --lane=0.73 --report=test-results/finish-target.json /path/to/clip.mov
```

The Start and normalized lower-lane x coordinate are explicit diagnostic inputs,
not accepted labels. Add `--hands` to run experimental cropped hand tracking;
it does not establish contact or change application timing. Reports can contain
private close-ups and landmarks: keep them local.

The Finish review suite also uses the generated control copy of IMG_9076.
Generate it with `npm run benchmark:robustness -- --generate-only --variants=control-720 IMG_9076.MOV`
or point `CLIMBIQ_RECOVERY_VIDEO` to that fixture. Use
`node e2e/finish-review.mjs --automatic-only` to test just automatic localization,
thumbnail navigation, saved-label separation, and replacement cleanup.

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
