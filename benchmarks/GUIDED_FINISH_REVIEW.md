# Guided finish review — 0.28.x

## Delivered behavior

- A synchronized close-up accompanies the full video during finish review.
- Users mark their actual finish-pad area on an enlarged upper-wall image,
  switch to the full image, or enter labelled corner percentages by keyboard.
- Pad coordinates are stored separately from automatic electronic-light zones.
- A focused 15-sample/s rescan covers up to 2.5 seconds around the paused cursor,
  bounded by accepted Start and the video end. It restores the prior cursor.
- Up to five surrounding frames help inspect a local appearance change.
  Thumbnail selection never accepts Finish. Explicit acceptance retains frame
  timing and user-selected-area provenance in the marker note.
- Closing review cancels an active scan; replacing the source clears review
  images and the prior pad region. Regions survive session and dataset export.
- Review code is loaded on demand. No detector thresholds or automatic
  acceptance rules were relaxed, and no video is uploaded.

## Evidence and limits

The change is a review workflow, not a trained finish-pad detector or a measured
accuracy improvement. Pixel change may represent approach, contact, lighting,
occlusion or camera movement. A selected region does not prove correct athlete
identity or physical contact. Use fixed-camera footage and inspect the full
video before acceptance. Synthetic and browser test acceptances are workflow
fixtures, not independent event labels.

504 unit tests in 52 files, TypeScript checks and build pass. New tests cover
area validation, persistence labels, bounded windows, exposure-only changes,
native-frame deduplication, fallback timing, cancellation and disabled controls.
All five original full-video regression workflows pass with accepted timing
unchanged. Desktop and 390 × 844 phone views were visually checked, including
pad marking, the filmstrip, and acceptance controls. Private screenshots remain
in ignored `test-results/`.

The browser workflow exercises two-corner marking in the magnified view,
coordinate entry, rescanning, cursor restoration, unchanged timestamps after
thumbnail navigation, cancellation on close, save/reload, separate pad-area
dataset export, explicit manual provenance, and replacement-video cleanup.
Test-harness fixes separated two pointer clicks into distinct UI updates,
allowed sub-pixel-to-CSS-pixel coordinate rounding, and wrapped the asynchronous
export read correctly. Failed harness runs are not counted as product passes.

The complete native-timing browser run passed, including a real dataset
export/re-import round trip of the marked area. The disabled-VideoFrame run
also passed marking, rescan, close cancellation, save/reload, dataset export,
manual acceptance provenance and source replacement. The latter was run before
the additional dataset re-import assertion was added; no application code
changed between those checks.

## Reproduce

Run `npm run dev`, then `npm run test:finish-review`. The script uses local
`IMG_9199.MOV` and `IMG_9076.MOV`; override `CLIMBIQ_VIDEO_DIR`,
`CLIMBIQ_CHROME` or `CLIMBIQ_E2E_URL` when needed. Port 9336 is reserved for this
runner. Set `CLIMBIQ_E2E_DISABLE_VIDEO_FRAME=1` for the source-timestamp fallback.

The production build emits a non-fatal main-bundle size warning (about 500 kB
minified); the new review component and scanner have separate lazy chunks.

## Production verification and layout follow-up

The 0.28.0 production workflow passed marking, rescan, unchanged timing,
close cancellation, save/reload, dataset export/re-import, manual provenance
and replacement cleanup. GitHub verification passed for `19bc15d`.

Production screenshot inspection then found that existing global button styles
laid filmstrip labels out beside their images. The 0.28.1 follow-up explicitly
stacks these controls and adds real-browser label-position assertions. Screenshot
capture also waits for responsive layout and uses instant scrolling, preventing
an in-progress smooth scroll from capturing a different section of the page.
The user's unrelated local `src/styles.css` changes were not committed; live
verification therefore checks the actual production styles independently.
