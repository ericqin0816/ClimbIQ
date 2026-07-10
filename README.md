# ClimbIQ Detection Lab

ClimbIQ Detection Lab is the web-based proof of the core video-detection and biomechanics engine for ClimbIQ. It is intentionally not the full ClimbIQ product yet. There are no athlete profiles, comparison pages, mobile apps, backend services, cloud storage, or AI coach in this version.

The goal is to prove that a local speed climbing video can be loaded in the browser, sampled frame by frame, and converted into useful climb timestamps.

## Why Web First

This lab uses a real `HTMLVideoElement` plus the Canvas API. That keeps frame extraction direct and testable:

- load a local video file with an object URL
- seek to raw video times
- draw video frames to canvas
- read pixel data
- run simple detection logic locally
- copy a debug report when detection fails

Starting with Expo or React Native would add video and canvas constraints before the core detection engine is proven.

## Timing Does Not Depend on Pose

Speed climbing phone videos are difficult for pose detection. The climber can be small, fast, partially occluded, or filmed from an angle that hides the wrist or hand. This lab uses more reliable signals first:

- start signal from a light color change
- first movement from pixel motion inside the climber's starting body zone
- finish pad from official total time after the detected start signal

ClimbIQ now includes optional pose analysis, but pose never changes accepted timing markers. This separation prevents a missed or occluded landmark from silently moving the authoritative Start Signal, First Movement, or Finish Pad timestamps.

## Experimental Biomechanics

After accepting timing markers, the **Biomechanics & Center of Mass** panel can run MediaPipe Pose Landmarker locally against sampled video frames. The workflow is:

1. Capture a frame showing the complete standardized speed lane.
2. Mark bottom-left, bottom-right, top-right, and top-left lane corners.
3. Confirm that the camera is fixed with no pan, tilt, shake, or zoom.
4. Analyze the accepted Start-to-Finish range at 5, 10, or 15 fps.
5. Review the synchronized skeleton, wall-projected center-of-mass path, speed chart, quality rating, and frame table.

The four-corner calibration solves a perspective transform from intrinsic video coordinates to the standardized 3 m × 15 m wall plane. Pose joints are projected into wall coordinates before segment centers and whole-body center of mass are calculated.

The COM calculation uses the 12-segment mass and segment-center ratios published by Pandurevic et al. for an adult-male reference population. The result is labeled as an estimated 2D wall projection. It is not a 3D, force, or clinical measurement and may not match every athlete's body proportions.

Velocity is fit from nearby timestamped COM samples rather than assuming perfectly uniform video frames. Gaps longer than 0.25 seconds are not bridged. Low visible-body coverage, extrapolated points, implausible speeds, sparse sampling, and multi-person ambiguity produce warnings instead of being silently accepted.

## Start Signal Detection

The user draws a tight Start Light Zone around the light that changes color. The detector samples the start search window at 10 fps, builds a baseline RGB value from the first 0.5 seconds, then looks for a sustained color distance change over multiple frames.

It also computes green and blue scores. If green drops while blue rises, confidence increases because that pattern matches many start-light changes.

## First Movement Detection

The user draws a Start Body Zone around the climber's body in the start position. The detector samples from Start Signal to Start Signal + 2.0 seconds, compares consecutive crops inside the zone, smooths the motion score, builds an early baseline, and returns the first sustained motion spike.

This does not rely on wrist tracking.

## Finish From Official Time

The finish timestamp is calculated, not video-detected:

```text
Finish Pad raw time = Start Signal raw time + Official total time
Finish Pad climb time = Official total time
```

The app labels this source clearly as official-total-time based.

## Run The Project

```bash
npm install
npm run dev
npm run typecheck
npm run test
```

Open the dev server URL, upload a local climbing video, run the frame sampling test first, then define the Start Light Zone and Start Body Zone.

## Deploy On Vercel

This project is configured as a public Vite site on Vercel.

```bash
npm run build
npx vercel
npx vercel --prod
```

Vercel should use:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

The app is still client-only. Uploaded videos are read locally in the browser with `HTMLVideoElement` and canvas; this version does not upload videos, store files, or use a backend.

## Debug Reports

Every detection run updates the visible debug panel. Use **Copy Debug Report** to copy JSON containing:

- video metadata
- normalized zones
- frame sampling diagnostics
- start signal detection debug data
- first movement detection debug data
- accepted timestamps

## Obsidian Export

The **Export & Dataset** card can generate an Obsidian-ready Markdown note for each analyzed attempt. Use **Copy Obsidian Note** or **Download Markdown** after accepting timestamps.

The Markdown includes:

- YAML frontmatter for Obsidian properties
- attempt summary
- accepted timestamps
- split calculations
- detection notes and warnings
- athlete notes and review questions
- a fenced JSON block with machine-readable data

Suggested vault structure:

```text
ClimbIQ Training Log/
Attempts/
Exports/
Debug Reports/
Templates/
```

Suggested workflow:

1. Create an Obsidian vault called `ClimbIQ Training Log`.
2. Create folders: `Attempts`, `Exports`, `Debug Reports`, `Templates`.
3. After analyzing a climb, click **Download Markdown** or **Copy Obsidian Note**.
4. Save the Markdown note into `Attempts`.
5. Save the JSON export into `Exports`.
6. Keep videos local. ClimbIQ stores the video file name only, not the video file.

## JSON Dataset Export

Use **Copy JSON** or **Download JSON** to export structured machine-readable attempt data. This is the source of truth for future model improvement.

The dataset JSON includes:

- app version and export timestamp
- session metadata
- video metadata, file name only
- official total time
- zones
- start-light calibration
- detection settings and offsets
- accepted timestamps
- reviewed candidates
- split calculations
- detection warnings
- athlete notes

Use **Import Session JSON** to load a previous export back into the browser. Imported sessions restore metadata, zones, calibration, settings, timestamps, notes, and splits where possible. They do not restore the video file; reupload the matching local video if you want to review frames.

## Local Privacy

ClimbIQ Detection Lab is local-first:

- videos are not uploaded
- videos are not stored in localStorage
- exports store metadata, timestamps, zones, calibration, settings, notes, and debug data
- local saved sessions stay in the browser's `localStorage`
- optional folder saving uses the browser File System Access API when supported

ClimbIQ does not train a custom AI model. Pose inference uses the bundled MediaPipe Pose Landmarker Lite model on the user's device. Dataset exports include calibration, compact trajectory data, quality metrics, warnings, and pose landmarks when available so future versions can improve analysis and coaching workflows.

## Biomechanics limitations

- A single wall calibration is valid only for a fixed camera. Panning, zooming, handheld shake, and broadcast camera movement invalidate metre and m/s output.
- Pose quality depends on resolution, lighting, occlusion, athlete size in frame, and other people in view.
- Draw a tight Start Body Zone to help select the correct athlete when two people are visible.
- Four clicked wall corners establish a solvable mapping but cannot prove that each click is accurate; review the path visually.
- The calculation is a wall-plane projection and cannot measure motion perpendicular to the wall.
