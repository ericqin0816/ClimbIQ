import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Diagnostic only: compare every discovered patch with lane-local motion.
// Imports source modules from Vite; no timestamp is accepted or labeled here.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const files = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const reportFile = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
if (!files.length) throw new Error("Provide local video paths and optional --report=PATH.");
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32"
  ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const port = 9338;
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-lanes-${Date.now()}`)}`, "about:blank"],
{ stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, send;
const report = { appUrl, isGroundTruthLabel: false, outcomes: [] };
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Lane probe browser did not start.");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  send = createProtocolClient(socket).send;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("Boolean(document.querySelector('main[data-app-version]'))")) break;
    if (attempt === 99) throw new Error("App did not load.");
    await delay(100);
  }
  report.version = await evaluate("document.querySelector('main').dataset.appVersion");
  await evaluate("(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'lane-probe-input'; document.body.append(i); })()");
  const input = (await send("Runtime.evaluate", { expression: "document.getElementById('lane-probe-input')" })).result.objectId;
  for (const file of files) {
    await send("DOM.setFileInputFiles", { objectId: input, files: [path.resolve(file)] });
    const outcome = await evaluate(`(${probe.toString()})(${process.argv.includes("--detail")})`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    report.outcomes.push({ fileName: path.basename(file), sourceSha256: hash.digest("hex"), ...outcome });
    console.log(JSON.stringify({ fileName: path.basename(file), audio: outcome.audio, lanes: outcome.lanes.map(lane => ({
      zone: lane.zone, cue: lane.result.rawTime, confidence: lane.result.confidence, movement: lane.movement.rawTime, audit: lane.audit,
    })) }, null, 2));
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  await closeTestBrowser(chrome, send); socket?.close();
  if (reportFile) { await mkdir(path.dirname(path.resolve(reportFile)), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2)); }
  if (!report.passed) console.error(report.error);
}

async function probe(detailPass) {
  const { detectAudioStartSignal } = await import("/src/lib/detectAudioStartSignal.ts");
  const { detectAutomaticStartLight } = await import("/src/lib/detectAutomaticStartLight.ts");
  const { detectFirstMovement } = await import("/src/lib/detectFirstMovement.ts");
  const { deriveAutomaticStartBodyZone } = await import("/src/lib/startRegion.ts");
  const { assessAutomaticStartBodyAudit } = await import("/src/lib/startBodyAudit.ts");
  const file = document.getElementById("lane-probe-input").files[0];
  const url = URL.createObjectURL(file), video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.src = url; document.body.append(video);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Video loading timed out.")), 15000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("Video decode failed.")); };
    });
    const searchEnd = Math.min(12, video.duration);
    const audio = await detectAudioStartSignal({ file, searchStart: 0, searchEnd });
    const discovery = await detectAutomaticStartLight({ video, searchStart: 0, searchEnd, expectedStartTime: audio.searchHintTime, detailPass });
    const lanes = [];
    for (let index = 0; index < (discovery.laneCandidates?.length ?? 0); index++) {
      const lane = discovery.laneCandidates[index], result = discovery.laneResults[index];
      const body = deriveAutomaticStartBodyZone(lane.zone);
      const movement = await detectFirstMovement({ video, zone: body, startSignalRawTime: result.rawTime, sensitivity: "medium" });
      lanes.push({ zone: lane.zone, body, calibration: lane.calibration, result, movement,
        audit: assessAutomaticStartBodyAudit(movement, result.rawTime) });
    }
    return { audio: { rawTime: audio.rawTime, searchHintTime: audio.searchHintTime, confidence: audio.confidence }, lanes };
  } finally { video.remove(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
