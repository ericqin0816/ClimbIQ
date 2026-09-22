import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "ios/App/App");
const projectPath = join(root, "ios/App/App.xcodeproj/project.pbxproj");
const config = JSON.parse(readFileSync(join(root, "capacitor.config.json"), "utf8"));
const command = process.argv[2] ?? "check";
const release = process.argv.includes("--release");
const read = (path) => readFileSync(join(root, path), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  assert(result.status === 0, `${args.join(" ")} failed. Resolve the error above and try again.`);
}

function build() {
  assert(process.env.npm_execpath, "Run this script through npm run ios:add or npm run ios:sync.");
  runNode(process.env.npm_execpath, ["run", "build"]);
}

function cap(...args) {
  runNode(join(root, "node_modules/@capacitor/cli/bin/capacitor"), args);
}

function checkConfig() {
  assert(Number(process.versions.node.split(".")[0]) >= 22, "Use Node.js 22 or newer (the repository pins Node 22).");
  assert(config.webDir === "dist", "The iOS app must bundle the Vite dist directory.");
  assert(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*){2,}$/.test(config.appId), "Choose a reverse-domain appId, such as com.yourteam.climbiq.");
  assert(!config.server?.url, "Remove server.url: release apps must load their bundled assets.");
  assert(!config.server?.cleartext, "Do not enable cleartext networking in the release configuration.");
  assert(!config.server?.allowNavigation?.length, "Review external navigation separately; do not give remote pages the native bridge.");
  const pkg = JSON.parse(read("package.json"));
  for (const name of ["core", "ios", "app", "filesystem", "share"]) {
    assert(pkg.dependencies[`@capacitor/${name}`]?.startsWith("8."), `Install the pinned Capacitor 8 ${name} dependency.`);
  }
  assert(pkg.devDependencies["@capacitor/cli"] === pkg.dependencies["@capacitor/core"], "Keep Capacitor CLI and core versions aligned.");
  assert(pkg.dependencies["@capacitor/ios"] === pkg.dependencies["@capacitor/core"], "Keep Capacitor iOS and core versions aligned.");
  if (config.appId === "com.example.climbiq") {
    assert(!release, "Replace the provisional com.example.climbiq ID in capacitor.config.json and both Xcode build configurations before release.");
    console.warn("NOTE: com.example.climbiq is provisional. Your Apple developer team must choose its own bundle ID before signing.");
  }
}

function prepareNewProject() {
  // Apply our app-specific metadata only when generating a new project. Sync never
  // overwrites signing settings, version numbers, or purpose text changed in Xcode.
  const infoPath = join(nativeRoot, "Info.plist");
  const info = readFileSync(infoPath, "utf8");
  assert(info.includes("\t<key>LSRequiresIPhoneOS</key>"), "Unexpected Capacitor template: add media purpose strings in Xcode.");
  const purposeText = `\t<key>NSCameraUsageDescription</key>
\t<string>Record a climbing attempt when you choose Take Video.</string>
\t<key>NSMicrophoneUsageDescription</key>
\t<string>Include start and finish sounds when you choose to record a climbing video.</string>
\t<key>NSPhotoLibraryUsageDescription</key>
\t<string>Choose a climbing video to analyze on this device.</string>
`;
  writeFileSync(infoPath, info.replace("\t<key>LSRequiresIPhoneOS</key>", `${purposeText}\t<key>LSRequiresIPhoneOS</key>`));
  writeFileSync(join(nativeRoot, "PrivacyInfo.xcprivacy"), read("scripts/ios-privacy.xcprivacy"));

  let project = readFileSync(projectPath, "utf8");
  const insertions = [
    ["/* Begin PBXBuildFile section */", '\n\t\tCA1000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = CA1000000000000000000002 /* PrivacyInfo.xcprivacy */; };'],
    ["/* Begin PBXFileReference section */", '\n\t\tCA1000000000000000000002 /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };'],
    ['\t\t\t\t504EC3131FED79650016851F /* Info.plist */,', '\n\t\t\t\tCA1000000000000000000002 /* PrivacyInfo.xcprivacy */,'],
    ['\t\t\t\t504EC30F1FED79650016851F /* Assets.xcassets in Resources */,', '\n\t\t\t\tCA1000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */,'],
  ];
  for (const [marker, addition] of insertions) {
    assert(project.includes(marker), "Unexpected Capacitor template: add PrivacyInfo.xcprivacy to the App target's Copy Bundle Resources in Xcode.");
    project = project.replace(marker, marker + addition);
  }
  // This beta is targeted at iPhone. Expand after testing an iPad layout.
  project = project.replaceAll('TARGETED_DEVICE_FAMILY = "1,2";', 'TARGETED_DEVICE_FAMILY = 1;');
  const version = JSON.parse(read("package.json")).version;
  project = project.replaceAll("MARKETING_VERSION = 1.0;", `MARKETING_VERSION = ${version};`);
  writeFileSync(projectPath, project);
}

function checkNative() {
  assert(existsSync(projectPath), "iOS project missing. Run npm run ios:add.");
  const project = readFileSync(projectPath, "utf8");
  const bundleIds = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((match) => match[1].replaceAll('"', ""));
  assert(bundleIds.length >= 2 && bundleIds.every((id) => id === config.appId), "Update the Debug and Release Bundle Identifier in Xcode to match capacitor.config.json.");
  assert(project.includes("PrivacyInfo.xcprivacy in Resources"), "PrivacyInfo.xcprivacy must be included in the App target resources.");
  const privacy = read("ios/App/App/PrivacyInfo.xcprivacy");
  assert(privacy.includes("NSPrivacyAccessedAPICategoryFileTimestamp") && privacy.includes("C617.1"), "Declare the Filesystem file timestamp API reason C617.1.");
  const info = read("ios/App/App/Info.plist");
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryUsageDescription"]) {
    assert(info.includes(`<key>${key}</key>`), `Add ${key} to describe the system video picker's media access.`);
  }
  assert(!info.includes("NSAllowsArbitraryLoads"), "Remove broad App Transport Security exceptions.");
  const swift = read("ios/App/CapApp-SPM/Package.swift");
  for (const plugin of ["CapacitorApp", "CapacitorFilesystem", "CapacitorShare"]) {
    assert(swift.includes(`.product(name: "${plugin}"`), `Run npm run ios:sync to register ${plugin}.`);
  }
  const bundledConfigPath = join(nativeRoot, "capacitor.config.json");
  if (existsSync(bundledConfigPath)) {
    const bundled = JSON.parse(readFileSync(bundledConfigPath, "utf8"));
    assert(bundled.appId === config.appId && !bundled.server?.url, "Native bundle configuration is stale or remote. Run npm run ios:sync.");
  }
  if (existsSync(join(nativeRoot, "public/index.html"))) {
    for (const asset of ["models/pose_landmarker_full.task", "mediapipe/wasm/vision_wasm_internal.js", "mediapipe/wasm/vision_wasm_internal.wasm", "mediapipe/wasm/vision_wasm_nosimd_internal.js", "mediapipe/wasm/vision_wasm_nosimd_internal.wasm", "mediapipe/wasm/vision_wasm_module_internal.js", "mediapipe/wasm/vision_wasm_module_internal.wasm"]) {
      assert(existsSync(join(nativeRoot, "public", asset)), `Packaged analysis asset missing: ${asset}. Restore public assets and run npm run ios:sync.`);
    }
  } else {
    console.warn("Web assets have not been bundled yet. Run npm run ios:sync before opening Xcode.");
  }
  console.log("iOS source configuration checks passed. These checks do not compile or run the native app.");
  if (release) console.warn("Release config checks do not verify signing, App Store metadata, app icons, privacy answers, or real-device behavior. Complete docs/ios-beta.md.");
}

try {
  assert(["add", "sync", "open", "check"].includes(command), "Usage: npm run ios:add | ios:sync | ios:open | ios:check [-- --release]");
  checkConfig();
  if (command === "add") {
    assert(!existsSync(join(root, "ios")), "The iOS project already exists. Run npm run ios:sync; do not delete your native settings.");
    build();
    cap("add", "ios", "--packagemanager", "SPM");
    prepareNewProject();
    checkNative();
  } else if (command === "sync") {
    assert(existsSync(projectPath), "iOS project missing. Run npm run ios:add first.");
    build();
    cap("sync", "ios");
    checkNative();
  } else if (command === "open") {
    assert(process.platform === "darwin", "Xcode only runs on macOS. On Windows, use npm run ios:sync and give this branch to your teammate with a Mac. See docs/ios-beta.md.");
    checkNative();
    assert(existsSync(join(nativeRoot, "public/index.html")), "Run npm run ios:sync before opening Xcode.");
    cap("open", "ios");
  } else {
    checkNative();
  }
} catch (error) {
  console.error(`iOS setup: ${error.message}`);
  process.exitCode = 1;
}
