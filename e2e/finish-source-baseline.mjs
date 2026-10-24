import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";

// Authored lamp-state controls exercise real decoding, coarse discovery and
// native refinement. They do not measure real-climber timing accuracy.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const browserEngine = process.env.CLIMBIQ_E2E_BROWSER ?? "chromium";
if (!["chromium", "webkit"].includes(browserEngine)) throw new Error("Choose chromium or webkit for native Finish verification.");
const encoder = process.env.CLIMBIQ_FFMPEG ?? (process.platform === "win32"
  ? path.resolve("node_modules/.climbiq-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe") : "ffmpeg");
const parent = path.resolve("test-results/finish-source-baseline");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, "run-"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePath = "src/lib/detectFinishSignal.ts";
const sourceSha256 = hash(await readFile(sourcePath));
const definitions = [
  { id: "held", finish: 4, reset: null },
  { id: "reset", finish: 4, reset: 8 },
  { id: "initial-obstruction", finish: 6, reset: 8, obstruction: [3, 3.4] },
  { id: "mixed-history", finish: 6, reset: 8, obstruction: [2.2, 3.6] },
  { id: "entire-history-obstruction", finish: 6, reset: 8, obstruction: [1, 3.6] },
];
const report = { sourceSha256, browserEngine, scope: "Authored native component regression; zero independent climbs", fixtures: [], outcomes: [], errors: [] };
let owner, browser, browserServer;
const reportFile = path.join(directory, "results.json");
const saveReport = () => writeFile(reportFile, JSON.stringify(report, null, 2));
function killOwnedBrowser() {
  const processes = [owner?.child, browserServer?.process()];
  for (const child of processes) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); }
      catch (error) { report.errors.push(`Owned browser termination failed: ${error}`); process.exitCode = 1; }
    }
  }
}
async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { killOwnedBrowser(); } finally { reject(new Error(`${label} exceeded ${milliseconds} ms`)); }
      }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function encode(definition) {
  const file = path.join(directory, `${definition.id}.mp4`);
  const event = `gte(t,${definition.finish})${definition.reset === null ? "" : `*lt(t,${definition.reset})`}`;
  const obstruction = definition.obstruction ? `+gte(t,${definition.obstruction[0]})*lt(t,${definition.obstruction[1]})` : "";
  const filter = `drawbox=x=100:y=50:w=120:h=70:color=0x465c3a:t=fill:enable='${event}${obstruction}'`;
  await new Promise((resolve, reject) => {
    const child = spawn(encoder, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=0x463e69:s=320x180:r=30:d=30", "-vf", filter, "-c:v", "libx264", "-crf", "12",
      "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", "-n", file],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "", expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      errors += "Authored video encoder exceeded 30 seconds.";
      try { child.kill("SIGKILL"); }
      catch (error) { reject(new Error(`${errors} ${error}`)); }
    }, 30_000);
    child.stderr.on("data", data => errors += data);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      code === 0 && !expired ? resolve() : reject(new Error(errors || `Encoder exited ${code}`));
    });
  });
  return { ...definition, file, sha256: hash(await readFile(file)), license: "CC0-1.0", authoredFps: 30 };
}

try {
  await saveReport();
  for (const definition of definitions) report.fixtures.push(await encode(definition));
  // Freeze authored inputs before any detector prediction.
  await writeFile(path.join(directory, "inputs.json"), JSON.stringify({ sourceSha256, fixtures: report.fixtures }, null, 2), { flag: "wx" });
  if (browserEngine === "webkit") {
    browserServer = await webkit.launchServer({ headless: true, timeout: 30_000 });
    browser = await bounded(() => webkit.connect(browserServer.wsEndpoint(), { timeout: 30_000 }), 35_000, "WebKit connection");
  } else {
    owner = await startTestBrowser({ label: "finish-source-baseline" });
    browser = await bounded(() => chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`, { timeout: 30_000 }), 35_000, "Chrome connection");
  }
  report.browser = browser.version();
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(appUrl);
  await page.evaluate(() => {
    document.body.replaceChildren();
    const input = document.createElement("input"); input.type = "file"; document.body.append(input);
  });
  for (const fixture of report.fixtures) {
    await page.locator("input").setInputFiles(fixture.file);
    for (const maximum of fixture.finish === 4 ? [10, 30] : [30]) {
      const outcome = await bounded(() => page.evaluate(async maximumClimbSeconds => {
        const { detectFinishSignal } = await import("/src/lib/detectFinishSignal.ts");
        const video = document.createElement("video"); video.muted = true; video.playsInline = true; document.body.append(video);
        const url = URL.createObjectURL(document.querySelector("input").files[0]);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          await new Promise((resolve, reject) => {
            const abort = () => reject(new Error("Authored video metadata timed out"));
            const finish = callback => { controller.signal.removeEventListener("abort", abort); callback(); };
            video.onloadeddata = () => finish(resolve);
            video.onerror = () => finish(() => reject(new Error("Authored video could not decode")));
            controller.signal.addEventListener("abort", abort, { once: true });
            video.src = url;
          });
          return await detectFinishSignal({ video, signal: controller.signal, startSignalRawTime: 0, maximumClimbSeconds,
            zone: { id: "startLight", label: "Authored lamp", x1: .35, x2: .65, y1: .3, y2: .65 },
            calibration: { beforeStartRGB: { r: 70, g: 92, b: 58 }, afterStartRGB: { r: 70, g: 62, b: 105 }, colorDelta: 55 } });
        } finally {
          clearTimeout(timer);
          video.pause(); video.removeAttribute("src"); video.load(); video.remove(); URL.revokeObjectURL(url);
        }
      }, maximum), 45_000, `Native Finish ${fixture.id}/${maximum}`);
      report.outcomes.push({ fixture: fixture.id, maximum, ...outcome });
      await saveReport();
      if (fixture.id === "entire-history-obstruction") {
        assert.notEqual(outcome.confidence, "High", "An obstruction clearing cannot create a new automatic clock");
        assert.ok(outcome.candidates?.some(candidate => Math.abs(candidate.rawTime - 6) <= 1 / 30 && candidate.confidence !== "High"),
          "The prior coarse alternative must remain available for review after local refinement");
      } else {
        assert.equal(outcome.detected, true);
        assert.ok(Math.abs(outcome.rawTime - fixture.finish) <= 1 / 30, `${fixture.id} selected the reset instead of the first reversal`);
        const expectedConfidence = fixture.finish === 4 && maximum === 30 ? "Medium" : "High";
        assert.equal(outcome.confidence, expectedConfidence);
        if (fixture.id === "reset" && maximum === 30) {
          assert.ok(outcome.candidates.some(candidate => Math.abs(candidate.rawTime - 8) <= .201 && candidate.confidence !== "High"));
        }
      }
    }
    assert.equal(hash(await readFile(fixture.file)), fixture.sha256);
  }
  assert.deepEqual(report.errors, []);
  assert.equal(hash(await readFile(sourcePath)), sourceSha256, "Detector changed during verification");
  report.passed = true;
} catch (error) {
  report.errors.push(String(error)); process.exitCode = 1;
} finally {
  report.verificationPassed = report.passed === true;
  report.passed = false;
  report.phase = "cleanup-pending";
  await saveReport();
  for (const [label, close] of [["Browser close", () => browser?.close()],
    ["WebKit server close", () => browserServer?.close()], ["Owned Chrome close", () => owner?.close()]]) {
    try { await bounded(close, 10_000, label); }
    catch (error) { report.errors.push(String(error)); process.exitCode = 1; killOwnedBrowser(); }
  }
  report.passed = report.verificationPassed && report.errors.length === 0;
  report.phase = "finished";
  await saveReport();
  console.log(JSON.stringify({ directory, passed: report.passed === true, cases: report.outcomes.length, errors: report.errors }));
}
