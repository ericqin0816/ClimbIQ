# ClimbIQ: first iPhone beta

The `codex/ios-app` branch adds an iPhone project around the existing React app with Capacitor. The analysis code stays shared with the website. The iPhone app loads the `dist` files included in its installation; it does not open the published website.

This is a development foundation, not an App Store submission. Native compilation, signing, camera access, and real-device performance still need verification on a Mac and iPhone. The app icon and launch artwork are Capacitor placeholders.

## What a branch means

A Git branch is a separate line of development in the same project. `codex/ios-app` lets us make and review iPhone changes before combining them with the main version. Creating a branch does not publish the app or change the live website. A branch is local until someone commits and pushes its changes; do not switch branches with unfinished changes you have not saved.

After the team reviews, commits, and shares this branch, your friend can check it out on a Mac:

```sh
git fetch origin
git switch codex/ios-app
npm ci
npm run ios:sync
npm run ios:open
```

If Git has not created a local copy of the shared branch, use `git switch --track origin/codex/ios-app` instead. Nothing in the setup scripts pushes code or uploads an app.

## Tools and commands

Use the repository's Node.js 22 version. Capacitor 8 needs Node 22 or newer. Building and running iOS requires macOS, Xcode 26 or newer, and its command-line tools. This project uses Swift Package Manager, so CocoaPods is not needed. See the [official environment setup](https://capacitorjs.com/docs/getting-started/environment-setup) and [Swift Package Manager guide](https://capacitorjs.com/docs/ios/spm).

| Command | What it does |
| --- | --- |
| `npm run ios:check` | Checks app configuration, plugin registration, bundle IDs, and native privacy setup. Works on Windows. Does not build or run iOS. |
| `npm run ios:sync` | Builds the current web app, copies it into the iOS project, and updates native plugins. Works on Windows and Mac. Run after every web or dependency change. |
| `npm run ios:open` | Opens the existing Xcode project on a Mac. Gives a clear handoff message on Windows. |
| `npm run ios:add` | Generates a new native project only when `ios/` does not exist. The branch already includes it; normally use `ios:sync`. |
| `npm run ios:check -- --release` | Also rejects the provisional app ID. This is a configuration check, not a release certification. |
| `npm run check` | Runs the repository's web TypeScript, unit, production-build, and coaching-server checks. |

Keep `ios/` in Git. Xcode project settings, Swift files, app icons, and privacy metadata are source files. Generated web assets, local Xcode state, signing profiles, and builds are ignored. Do not delete the iOS directory to refresh web changes. The CLI manages `ios/App/CapApp-SPM/Package.swift`; rerun sync when plugins change.

## Your friend's Mac steps

1. Install Xcode and its command-line tools, open Xcode once, and finish its component setup. Run `npm ci` and `npm run ios:sync` from this branch.
2. Choose an app bundle ID owned by your friend's Apple developer team, for example `com.yourteam.climbiq`. **`com.example.climbiq` is a placeholder and must be replaced before signing.** Change `appId` in `capacitor.config.json`, then change the App target's Bundle Identifier for both Debug and Release in Xcode. Sync alone does not change an existing Xcode bundle identifier.
3. In Xcode, select the App target, open Signing & Capabilities, select the correct team, and use automatic signing. Keep Apple credentials and provisioning profiles out of Git. Run `npm run ios:sync` again and confirm `npm run ios:check -- --release` passes.
4. Connect an iPhone, select it as the run destination, and run the App scheme. The current project targets iPhone on iOS 15 or newer. Test actual devices; a Simulator cannot establish video performance or camera behavior.
5. Complete the device checklist below. Replace the placeholder icon and launch artwork in `ios/App/App/Assets.xcassets`. Set the native version and increment the build number in the App target before each uploaded build. Native versions are separate from `package.json` after project generation.
6. Create the matching app record in App Store Connect. From Xcode, archive the release build and use Organizer to validate and distribute it to App Store Connect. Complete beta information, contact details, and applicable export-compliance answers. Follow [Apple's upload instructions](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
7. Start with your team as TestFlight testers, then invite the first climbers and coaches. External testing can require beta review. TestFlight is separate from publishing a public App Store version; see [Apple's TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

## Data, permissions, and native plugins

`@capacitor/app` supplies app lifecycle events, `@capacitor/filesystem` stores saved analysis summaries and export files, and `@capacitor/share` opens the iOS share sheet. Original videos are selected for the current analysis; saved attempts do not include the video recording itself. Keep the original recording separately if you want to review it later. Removing the app can remove its local library; export a backup first.

The video input uses the system file picker. The Info.plist purpose strings cover selecting a recording and the picker's optional **Take Video** action, including its audio. These strings do not automatically request access when the app launches. Test Photos, Files, capture, denied access, and cancellation on your target iOS versions. No background-processing entitlement, full-filesystem access, contacts, location, or photo-library write access is added. Library files stay in the app's private storage; the share sheet exposes only the selected export.

Opening a recording first checks it in a temporary decoder. A damaged, cancelled,
or superseded selection should leave the current video and unsaved measurements
intact. A filename, duration, and resolution do not prove that a file belongs to a
saved attempt. When that association is unknown, choose **Attach to this attempt**
only for its original recording, or **Analyze as a new attempt** to start fresh.
Reopening an already associated attempt while its current recording remains open
does not require another confirmation. This is a local association, not a persisted
content fingerprint. Confirm this preparation/attachment flow on an actual iPhone.

The App target includes `PrivacyInfo.xcprivacy` with the Filesystem plugin's file-timestamp API category and reason `C617.1` for files within the app container. `scripts/ios-privacy.xcprivacy` is the template used if a new native project is generated. The [Filesystem documentation](https://capacitorjs.com/docs/apis/filesystem) and [privacy manifest guide](https://capacitorjs.com/docs/ios/privacy-manifest) explain the requirement. Review the archived app's privacy report before upload. This manifest does not replace App Store Connect privacy answers or a privacy policy. If you add analytics, remote coaching, accounts, or another SDK, review their actual data behavior and update those disclosures.

The pose model and MediaPipe WASM files are packaged from `public/models` and `public/mediapipe`, and asset URLs preserve the `capacitor://localhost` scheme. Native execution still needs a real-device test, especially WebAssembly, Web Crypto, audio decoding, and frame seeking. The website's `/api/coaching` server is not part of the native app. Hosted coaching is disabled in the native beta until a separately configured, tested backend and consent flow are available. Do not put server secrets into `VITE_*` variables or the app bundle.

The browser version can run pose inference in a worker to keep controls responsive. **Native builds keep the existing main-thread inference path by default**, with a cache of integrity-verified model bytes. Worker behavior on an actual iPhone has not been verified. `VITE_POSE_EXECUTION=main-thread|auto|worker` is an intentional developer build override for comparisons and fallback; leave it unset for the normal native handoff. See the [performance evidence and limits](pose-performance.md).

Keep `server.url` out of the committed Capacitor config. Loading the public site would bypass the bundled build. This branch does not grant remote pages navigation access to the native bridge or weaken App Transport Security.

## Real-iPhone verification before inviting testers

Record the device model, iOS version, app version/build, video format, file size, and time spent processing. Test an older supported iPhone as well as a recent one.

- Fresh install: launch without a permission prompt; confirm notch, home indicator, keyboard, landscape, larger text, and VoiceOver do not block key controls.
- Import a portrait MOV/HEVC recording from Photos, an MP4 from Files, a slow-motion clip, and a video stored only in iCloud. Check orientation, duration, decoded audio, scrubbing, and cancellation of the picker. Try a damaged or unsupported file and confirm the error is useful.
- Replace an edited attempt with a damaged nonempty video file and verify the original video and unsaved markers remain. Cancel opening, choose two files quickly, and reopen a saved attempt with a different clip of the same filename. Verify the attachment choice and that unconfirmed recordings never supply saved overlays or review links.
- If the picker offers Take Video, accept and deny camera/microphone access separately; confirm the app returns safely to import. A denied microphone should not crash the app.
- Analyze the same independently annotated speed-climbing recordings used in the web benchmark. Compare event frames and reported times with the reference labels; record uncertainty and correction effort. Passing software tests does not establish timing accuracy.
- Cancel midway through analysis and load another video. Lock the phone or switch apps during analysis, then return; confirm interrupted work does not publish partial results as complete or overwrite a different recording.
- Run pose analysis in airplane mode from a fresh app launch. Confirm bundled model/WASM loading and record memory, heat, battery drain, duration, and any OS termination. Retest with a larger recording and repeated attempts.
- Save, rename, compare, and delete attempts; force-close and reopen. Update the app without uninstalling and verify the library remains. Test storage failure if possible and confirm the app does not claim a failed save succeeded.
- Export one analysis and the library backup with Share / Save to Files, cancel sharing, and import the backup. Confirm the exported content is readable and library restoration is accurate. Exported summaries are not video backups.
- Start with roughly 10–20 speed climbers and a couple of coaches over multiple sessions. Track completed analyses, manual corrections, repeat use, and what users still ask a coach after seeing the results.

Do not describe this beta as independently accurate until the [real-video benchmark](../REAL_VIDEO_BENCHMARK.md) has evidence from recordings outside the development set.

Use the [beta evaluation plan](beta-validation.md) and its empty reviewer worksheet to collect those recordings, independent event labels, device measurements, and usability results. Its acceptance gates are proposed targets, not completed validation.

## Verification limits and dependency note

The initial native project was generated and synchronized on Windows. The production web build and source checks can pass there; Swift compilation, Xcode package resolution, signing, native permission prompts, TestFlight uploads, and device performance cannot be verified there.

Capacitor core/CLI/iOS are pinned to 8.5.2, with compatible official App, Filesystem, and Share plugins. Vitest was patched to 4.1.11. At setup time, npm audit still reported three moderate development-dependency entries on the Capacitor CLI → xcode → uuid chain; the advisory concerns uuid buffer handling. This is not a dependency shipped in the web bundle. Recheck upstream releases before distributing and avoid `npm audit fix --force`, which currently proposes downgrading Capacitor rather than a compatible patch.
