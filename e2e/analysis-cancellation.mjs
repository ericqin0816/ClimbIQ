import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Real browser interruption tests. No video pixels or user library are exported.
const directory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const primary = path.join(directory, "IMG_9199.MOV");
const replacement = path.join(directory, "IMG_9076.MOV");
await Promise.all([access(primary), access(replacement)]);
const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const port = 9335;
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-cancel-${Date.now()}`)}`, "about:blank"],
{ stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let sendCommand;
const report = { appUrl: url, isGroundTruthLabel: false, stages: [] };

try {
  let debuggerReady = false;
  for (let index = 0; index < 100; index++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { debuggerReady = true; break; } } catch {}
    await delay(100);
  }
  if (!debuggerReady) throw new Error("Chrome debugger did not start.");
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error("Could not open the test app.");
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const { send } = createProtocolClient(socket);
  sendCommand = send;
  const errors = [];
  socket.addEventListener("message", event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await send("Runtime.enable");
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) { const value = await evaluate(expression); if (value) return value; await delay(80); }
    const status = await evaluate("document.querySelector('.quick-analysis-box .status-message')?.textContent");
    throw new Error(`Timed out: ${label}. App status: ${status}`);
  };
  const upload = async (file, ready = true) => {
    const oldSource = await evaluate("document.querySelector('video')?.src ?? ''");
    const input = await send("Runtime.evaluate", { expression: "document.querySelector('input[accept=\"video/*\"]')" });
    if (!input.result.objectId) throw new Error("Video upload control is missing.");
    await send("DOM.setFileInputFiles", { files: [file], objectId: input.result.objectId });
    if (ready) await until(`document.querySelector('video')?.src !== ${JSON.stringify(oldSource)} && document.querySelector('.upload-copy strong')?.textContent === ${JSON.stringify(path.basename(file))} && document.querySelector('.video-meta-line')?.textContent.includes('Ready')`, "video ready");
  };
  const stateExpression = `(() => {
    const v = document.querySelector('video');
    const run = [...document.querySelectorAll('button')].find(b => /Run full analysis|Analyzing climb/.test(b.textContent));
    return { fileName: document.querySelector('.upload-copy strong')?.textContent, source: v?.src,
      currentTime: v?.currentTime, paused: v?.paused, seeking: v?.seeking,
      busy: Boolean(run?.disabled), status: document.querySelector('.quick-analysis-box .status-message')?.textContent,
      markers: [...document.querySelectorAll('tbody tr')].filter(r => ['Start Signal','Earliest Visible Motion','Finish Pad'].includes(r.firstElementChild?.textContent.trim()))
        .map(r => [...r.querySelectorAll('td')].slice(0,5).map(c => c.textContent.trim())) };
  })()`;
  await until("Boolean(document.querySelector('input[accept=\"video/*\"]'))", "app load");
  report.version = await evaluate("document.querySelector('main[data-app-version]')?.dataset.appVersion");

  const stages = process.argv.includes("--rerun-only") ? [] : ["start", "finish", "pose"];
  for (const stage of stages) {
    console.error(`Testing ${stage} cancellation`);
    await upload(primary);
    await evaluate(`(async () => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2.5;
      if (v.seeking) await new Promise(r => v.addEventListener('seeked', r, { once: true })); })()`);
    const before = await evaluate(stateExpression);
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Run full analysis')).click()");
    await until("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Analyzing climb') && b.disabled)", "analysis starts");
    const stagePattern = stage === "start" ? "Finding the start|Reading|Scanning lane" : stage === "finish" ? "finish|return-color" : "Following the climber:";
    await until(`new RegExp(${JSON.stringify(stagePattern)}, 'i').test(document.querySelector('.quick-analysis-box .status-message')?.textContent ?? '')`, `${stage} phase`, 150000);

    // Even a programmatic file change must respect the busy-state guard.
    await upload(replacement, false);
    const blocked = await evaluate(stateExpression);
    if (blocked.fileName !== before.fileName || blocked.source !== before.source) throw new Error(`${stage}: replacement was allowed during analysis.`);
    const atCancel = await evaluate(`(() => { const state = ${stateExpression};
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel')?.click(); return state; })()`);
    const started = Date.now();
    await until(`!(${stateExpression}).busy`, `${stage} cancellation`, 30000);
    const after = await evaluate(stateExpression);
    if (!/cancelled/i.test(after.status)) throw new Error(`${stage}: cancellation was not acknowledged: ${after.status}`);
    if (!after.paused || after.seeking || Math.abs(after.currentTime - before.currentTime) > 0.002) throw new Error(`${stage}: paused video cursor was not restored.`);
    if (JSON.stringify(after.markers) !== JSON.stringify(atCancel.markers)) throw new Error(`${stage}: accepted markers changed after cancellation.`);
    await delay(350);
    const settled = await evaluate(stateExpression);
    if (settled.busy || JSON.stringify(settled.markers) !== JSON.stringify(after.markers)) throw new Error(`${stage}: stale task published after cancellation.`);
    report.stages.push({ stage, cancelledAfterMs: Date.now() - started, restoredCursor: after.currentTime,
      replacementBlocked: true, markersRetained: true, status: after.status });
  }

  // Establish a complete unsaved result, including COM and contact previews.
  if (!stages.length) await upload(primary);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Run full analysis')).click()");
  await until(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Analyzing climb') && b.disabled)`, "complete rerun starts");
  await until(`!(${stateExpression}).busy`, "complete rerun", 150000);
  const evidenceExpression = `({ com: document.getElementById('biomechanics-results-heading')?.closest('section')?.textContent ?? '',
    hold10: document.querySelector('.hold10-second-pass')?.textContent ?? '', previews: document.querySelectorAll('.hold10-evidence-frames img').length })`;
  const priorEvidence = await evaluate(evidenceExpression);
  if (!priorEvidence.com || priorEvidence.previews !== 3) throw new Error("Rerun cancellation test did not establish complete prior evidence.");
  // A rerun must not discard earlier timing before its replacement Start commits.
  const priorAnalysis = await evaluate(stateExpression);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Run full analysis')).click()");
  await until("/Verifying that the selected athlete launches/.test(document.querySelector('.quick-analysis-box .status-message')?.textContent ?? '')", "rerun preflight", 150000);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel').click()");
  await until(`!(${stateExpression}).busy`, "rerun cancellation", 30000);
  const cancelledRerun = await evaluate(stateExpression);
  if (JSON.stringify(cancelledRerun.markers) !== JSON.stringify(priorAnalysis.markers)) {
    report.rerunDiagnostic = { before: priorAnalysis.markers, after: cancelledRerun.markers, status: cancelledRerun.status };
    throw new Error("Cancelling preflight discarded prior timing before a replacement Start was committed.");
  }
  report.cancelledRerunPreservedPriorTiming = true;
  const restoredEvidence = await evaluate(evidenceExpression);
  if (JSON.stringify(restoredEvidence) !== JSON.stringify(priorEvidence)) throw new Error("Cancelled preflight lost the prior COM or Hold 10 evidence.");
  report.cancelledRerunPreservedPriorEvidence = true;

  // Rapid replacements deliberately race the first file's metadata callback.
  await upload(primary, false);
  await upload(replacement, false);
  await until("document.querySelector('.upload-copy strong')?.textContent === 'IMG_9076.MOV' && document.querySelector('.video-meta-line')?.textContent.includes('Ready')", "rapid replacement metadata");
  const replaced = await evaluate(stateExpression);
  if (Math.abs(replaced.currentTime) > 0.001 || replaced.markers.some(row => row[1] !== "Not set")) throw new Error("Rapid replacement retained an old cursor or accepted marker.");
  await evaluate(`(() => { const input = document.querySelector('input[accept="video/*"]'); const transfer = new DataTransfer();
    transfer.items.add(new File(['not a video'], 'invalid.txt', {type:'text/plain'})); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const invalid = await evaluate(stateExpression);
  if (invalid.source !== replaced.source || invalid.fileName !== replaced.fileName || !(await evaluate("Boolean(document.querySelector('.upload-error')?.textContent)"))) throw new Error("Invalid replacement destroyed the valid recording or did not report an error.");
  report.rapidReplacementPassed = true;
  report.invalidReplacementPreservedVideo = true;
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join(' | ')}`);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await closeTestBrowser(chrome, sendCommand);
  socket?.close();
  chrome.kill();
  console.log(JSON.stringify(report, null, 2));
}
