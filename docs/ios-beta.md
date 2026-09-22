# ClimbIQ: first iPhone beta

The `codex/ios-app` branch adds a Capacitor iPhone project around the shared React analysis app. A branch is a separate line of development; checking it out does not publish an app or change the live website. The installed app runs its bundled web files, not the published website.

**Handoff status, checked September 22, 2026:** Windows web checks, browser workflows, native source checks, and asset synchronization have passed. No Mac native build, signing, iPhone run, or TestFlight upload has been verified. The first goal below is a working installation on your friend's iPhone; invite testers after the device checks pass.

## What the owner needs to supply

| Item | Current project | Owner action |
| --- | --- | --- |
| Apple team | No `DEVELOPMENT_TEAM` is set | Use the team that will own this app. TestFlight needs Apple Developer Program membership; a free Personal Team is not the distribution team. |
| Bundle ID | `com.example.climbiq` in `capacitor.config.json` and both Xcode build configurations | Choose a unique reverse-domain ID under that team, then use it everywhere. `com.yourteam.climbiq` is only an example. |
| Artwork | Capacitor app icon and splash placeholders | Replace `AppIcon.appiconset` and `Splash.imageset` in `ios/App/App/Assets.xcassets` before distributing the beta. |
| Native version/build | Version `0.29.0`, build `1` | Confirm the intended version and use a new build number for each upload. These Xcode values do not automatically follow `package.json`. |
| App Store Connect record | Not created or checked in this work | Owner supplies the app name, primary language, matching bundle ID, internal SKU, beta contact, and test information. |

Have your friend sign in on their own Mac. Do not exchange Apple passwords or add credentials/provisioning profiles to Git. For an individual membership, inviting someone to App Store Connect does not make them a member of the signing team; having the account owner perform the first build avoids that access mismatch. [Apple's account roles](https://developer.apple.com/help/account/access/roles)

## Get the branch onto the Mac

Install Node.js **22** (the repository's `.nvmrc` and `engines` version), Xcode **26 or later**, and Xcode's command-line tools. Open Xcode once to finish setup and install iOS platform support. Use a macOS version supported by that Xcode release. This project already uses Swift Package Manager; it does not need CocoaPods. [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup), [SPM setup](https://capacitorjs.com/docs/ios/spm)

In Terminal, for a fresh checkout:

```sh
git clone --branch codex/ios-app --single-branch https://github.com/ericqin0816/ClimbIQ.git
cd ClimbIQ
node --version
xcodebuild -version
git rev-parse --short HEAD
npm ci
npm run check
npm run ios:sync
npm run ios:open
```

`node --version` should report `v22.x`. Share the commit printed by Git with the team so everyone knows which build is being tested. If the repository is private, your friend needs repository access first. The original/private test videos are not included in a clone; use recordings you have permission to share.

For an existing clean checkout, use `git fetch origin`, `git switch codex/ios-app`, and `git pull --ff-only` instead of cloning. If the local branch does not exist, use `git switch --track origin/codex/ios-app`. Save unfinished local work before switching. Then run the npm commands above.

`ios:sync` builds `dist`, copies it into the native project, registers plugins, and checks the source configuration. `ios:open` opens `ios/App/App.xcodeproj`. The first sync/open can use the provisional ID; set the real ID and team in the next step before trying a signed run. Xcode needs network access to resolve the Capacitor Swift package, and the local plugin packages need the `node_modules` installed by `npm ci`.

## Sign and run on an iPhone

1. In **Xcode → Settings → Accounts**, add the owner's Apple Account. In the project navigator select **App**, then the **App target → Signing & Capabilities**. Enable **Automatically manage signing** and select the owner's actual developer **Team**.
2. Choose the permanent bundle ID. Change `appId` in the root `capacitor.config.json` and the App target's **Bundle Identifier** for **both Debug and Release**. Check **Build Settings → Product Bundle Identifier** if the configurations differ. Sync does not rename an existing Xcode bundle ID. Keep the team and ID consistent with the future App Store Connect record. [Apple's distribution preparation](https://help.apple.com/xcode/mac/current/en.lproj/dev91fe7130a.html)
3. Back in Terminal, run `npm run ios:sync` and `npm run ios:check -- --release`. The release check is expected to reject `com.example.climbiq` until you replace it. Resolve the actual Xcode signing error if one remains; this script cannot check certificates, team permissions, or provisioning.
4. Connect and unlock the iPhone, trust/pair it with the Mac when asked, and select it as the destination for the **App** scheme. On devices that require it, enable **Settings → Privacy & Security → Developer Mode**, restart, and confirm the prompt. Developer Mode is for local Xcode installs; TestFlight testers do not need it. [Apple's Developer Mode guide](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
5. Use **Product → Run**. Let Xcode finish package resolution and device preparation. The project currently targets **iPhone, iOS 15 or newer**; that is the deployment minimum, separate from the SDK used to build it. Complete the device checks below, including relaunching without the Xcode debugger attached.

Run `npm run ios:sync` again after each web or plugin change, then rebuild in Xcode. Keep the native project in Git; do not delete `ios/` to refresh web assets. The CLI manages `ios/App/CapApp-SPM/Package.swift` when plugins change. If Xcode cannot find a local plugin, first confirm `npm ci` and sync completed; if package resolution remains stuck, use Xcode's package-resolution controls before changing dependencies.

## Move a tested build to TestFlight

Apple currently requires uploads to be built with **Xcode 26 or later and the iOS 26 SDK or later**; this has applied since April 28, 2026. Recheck the requirement on upload day. It does not require raising the app's deployment minimum to iOS 26. [Apple's SDK requirements](https://developer.apple.com/news/upcoming-requirements/)

1. Once the device checks pass, replace the placeholder artwork and set **App target → General → Version/Build**. Run `npm run check`, `npm run ios:sync`, and `npm run ios:check -- --release` on the exact commit being archived. Keep `VITE_POSE_EXECUTION` unset for the normal native build.
2. In **App Store Connect → Apps → + → New App**, create an **iOS** record with the exact bundle ID, name, language, and an owner-chosen internal SKU. An Account Holder, Admin, or App Manager can create it; the owner may need to accept Apple's current agreement first. [Create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
3. In Xcode select the **App** scheme and a generic iOS device destination such as **Any iOS Device (arm64)**, rather than a Simulator. Check that the scheme's Archive action uses **Release**, then choose **Product → Archive**. In Organizer, validate the archive and choose **Distribute App → App Store Connect** to upload. Choose that distribution method when the beta will include friends outside App Store Connect; an **Internal Only** upload is restricted to internal testing. [Apple's beta-build walkthrough](https://developer.apple.com/tutorials/develop-in-swift/test-your-beta-app)
4. Wait for processing, then open the build in the app's **TestFlight** tab. Resolve the actual processing issues and applicable export-compliance prompts, add beta instructions/contact details, and assign the build to a tester group. The upload role can be Account Holder, Admin, App Manager, or Developer. [Upload and processing](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
5. Start with an internal team group. Friends who are not App Store Connect users are **external testers**; the first external build needs TestFlight review before invitations can install it. Testers install Apple's TestFlight app and accept the invitation. Uploading to TestFlight does not publish a public App Store release. [TestFlight setup](https://developer.apple.com/testflight/)

Record the tested Git commit, bundle ID, team, native version/build, device/iOS version, and any failed checks with the beta notes. Keep developer credentials and private recordings out of that shared record.

## Commands at a glance

| Command | Purpose |
| --- | --- |
| `npm run check` | Web TypeScript, unit, production-build, and coaching-server checks. |
| `npm run ios:sync` | Builds and copies web assets; updates native plugins and checks source configuration. Works on Windows and Mac. |
| `npm run ios:check` | Checks IDs, plugin registration, privacy declarations, and bundled assets when present. Does not compile or sign iOS. |
| `npm run ios:check -- --release` | Also rejects the provisional ID; not a native release certification. |
| `npm run ios:open` | Opens the existing Xcode project on macOS after sync. |
| `npm run ios:add` | Only for generating a native project when `ios/` does not exist; not part of this handoff. |

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
- Run **Find start & finish**, then **Full analysis**, on the same local reference clip. Check that accepted timing stays consistent and pose analysis can be added later. The development corpus currently has no qualifying independent accuracy labels; collect separate labels through the beta evaluation plan before measuring accuracy.
- Cancel midway through analysis and load another video. Lock the phone or switch apps during analysis, then return; confirm interrupted work does not publish partial results as complete or overwrite a different recording.
- Run pose analysis in airplane mode from a fresh app launch. Confirm bundled model/WASM loading and record memory, heat, battery drain, duration, and any OS termination. Retest with a larger recording and repeated attempts.
- Save, rename, compare, and delete attempts; force-close and reopen. Update the app without uninstalling and verify the library remains. Test storage failure if possible and confirm the app does not claim a failed save succeeded.
- Export one analysis and the library backup with Share / Save to Files, cancel sharing, and import the backup. Confirm the exported content is readable and library restoration is accurate. Exported summaries are not video backups.
- Start with roughly 10–20 speed climbers and a couple of coaches over multiple sessions. Track completed analyses, manual corrections, repeat use, and what users still ask a coach after seeing the results.

Do not describe this beta as independently accurate until the [real-video benchmark](../REAL_VIDEO_BENCHMARK.md) has evidence from recordings outside the development set.

Use the [beta evaluation plan](beta-validation.md) and its empty reviewer worksheet to collect those recordings, independent event labels, device measurements, and usability results. Its acceptance gates are proposed targets, not completed validation.

## Verification limits and dependency note

The initial native project was generated and synchronized on Windows. The production web build and source checks can pass there; Swift compilation, Xcode package resolution, signing, native permission prompts, TestFlight uploads, and device performance cannot be verified there.

Capacitor core/CLI/iOS are pinned to 8.5.2, with compatible official App, Filesystem, and Share plugins. Use `npm ci` with the committed lockfile. A setup-time audit reported moderate development-dependency findings on the Capacitor CLI → xcode → uuid chain; run `npm audit` again for current findings before distributing. Review compatible updates separately instead of applying `npm audit fix --force` during this handoff.
