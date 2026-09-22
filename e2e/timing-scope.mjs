/**
 * Real-video full/timing-only parity and workload regression.
 * Run against an immutable production preview with COACHING_ENABLED=0.
 * Example: CLIMBIQ_E2E_URL=http://127.0.0.1:4173 node e2e/timing-scope.mjs
 * No requests, pixels, detections, or marker values are mocked. Automated Start
 * acceptance below is a workflow test, never an independent event annotation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProtocolClient } from "./cdp-client.mjs";
import { startTestBrowser } from "./test-browser.mjs";

const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:4173/";
const videoDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const fileNames = argument("files", process.env.CLIMBIQ_BENCHMARK_FILES ?? "12.24.mov,IMG_9199.MOV").split(",").map(value => value.trim()).filter(Boolean);
const repeats = Number(argument("repeats", "2"));
const weakStartFile = argument("weak-start", "IMG_9075.MOV");
const skipWeakStart = process.argv.includes("--skip-weak-start");
const skipFollowup = process.argv.includes("--skip-followup");
const allowDev = process.argv.includes("--allow-dev");
const reportPath = path.resolve(argument("report", "test-results/timing-scope.json"));
const timeoutMs = 300000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const modelRequest = url => /\/models\/|\.task(?:\?|$)|vision_wasm|poseInference[.-]worker|\/wasm\//i.test(url);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10, "--repeats must be an integer from 1 to 10.");
assert(fileNames.length > 0, "At least one --files recording is required.");

const report = {
  startedAt: new Date().toISOString(), appUrl, videoDirectory, repeats,
  methodology: {
    measurement: "Browser performance.now() immediately before Analyze click to first fully idle UI; 250 ms quiet confirmation is excluded.",
    workload: "Unmodified local recordings, real detectors, no mocked network or inference. No independent timing ground truth is asserted.",
    isolation: "Owned temporary Chrome profile; fresh document and cleared browser cache before each paired run; alternating pair order.",
    comparison: "Exact accepted Start/Finish values, source, confidence, sampling interval, and acceptance provenance on the same frozen build.",
    reverseScope: "The same document runs timing-only, Full, then timing-only again with the model cache deliberately retained. Existing evidence may remain during preflight; no new preview work or retained movement output is allowed after completion.",
    scope: "Desktop browser measurements on these clips only; not iPhone performance or event-accuracy evidence.",
    weakStart: "Automated acceptance of the displayed suggested frame tests continuation only; it is not a verified Start annotation.",
    allowDev,
  },
  passed: false, sourceFingerprints: {}, app: null, pairs: [], laterFull: null, reverseTimingOnly: null, weakStart: null, errors: [],
};

let browser;
let lastProtocol;
let port;
const openSockets = new Set();

async function sourceFingerprint(fileName) {
  const filePath = path.resolve(videoDirectory, fileName);
  await access(filePath);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

async function waitUntil(evaluate, expression, duration, label) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function launch() {
  browser = await startTestBrowser({ label: "timing-scope", args: [
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ] });
  port = browser.port;
  report.browserProfile = browser.profile;
}

async function openPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: "PUT" });
  assert(response.ok, "Could not open an isolated test page.");
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  openSockets.add(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const { send } = createProtocolClient(socket);
  const evaluate = async expression => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  };
  const requests = [];
  const workerTargetsCreated = [];
  const exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "worker")
      workerTargetsCreated.push({ targetId: message.params.targetInfo.targetId, url: message.params.targetInfo.url });
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const protocol = { send, evaluate, requests, workerTargetsCreated, exceptions, targetId: target.id, socket };
  lastProtocol = protocol;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Target.setDiscoverTargets", { discover: true });
  await send("Network.clearBrowserCache");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__timingScopeWorkerRequests = [];
    window.__timingScopePngEncodes = 0;
    const encode = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      if (!args[0] || args[0] === 'image/png') window.__timingScopePngEncodes++;
      return Reflect.apply(encode, this, args);
    };
    if (window.Worker) window.Worker = new Proxy(window.Worker, { construct(target, args, newTarget) {
      window.__timingScopeWorkerRequests.push(String(args[0]));
      return Reflect.construct(target, args, newTarget);
    }});
  })();` });
  await send("Page.navigate", { url: appUrl });
  await waitUntil(evaluate, `Boolean(document.querySelector('select[aria-label="Analysis scope"]')) && document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'`, 20000, "analysis scope control and library hydration");
  const app = await evaluate(`({ url: location.href, version: document.querySelector('[data-app-version]')?.dataset.appVersion,
    entryScripts: [...document.scripts].map(script => script.src).filter(Boolean),
    defaultScope: document.querySelector('select[aria-label="Analysis scope"]').value })`);
  assert.equal(app.defaultScope, "full", "Full analysis must remain the default on a fresh page.");
  if (!allowDev) assert(!app.entryScripts.some(url => url.includes("@vite/client")), "This benchmark requires a frozen production preview; --allow-dev is for workflow debugging only.");
  if (report.app) assert.deepEqual(app, report.app, "The served build changed between paired runs.");
  else report.app = app;
  return protocol;
}

async function closePage(protocol) {
  await fetch(`http://127.0.0.1:${port}/json/close/${protocol.targetId}`).catch(() => undefined);
  protocol.socket.close();
  openSockets.delete(protocol.socket);
}

async function upload(protocol, fileName) {
  const { send, evaluate } = protocol;
  const input = await send("Runtime.evaluate", { expression: `document.querySelector('.upload-dropzone input[type="file"]')`, returnByValue: false });
  assert(input.result.objectId, "Video input is missing.");
  await send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [path.resolve(videoDirectory, fileName)] });
  await waitUntil(evaluate, `document.querySelector('.upload-copy strong')?.textContent.trim() === ${JSON.stringify(fileName)} && Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))`, 25000, `${fileName} ready to analyze`);
  assert.equal(await evaluate(`document.querySelector('video')?.currentTime`), 0, "A fresh video must start at the zero cursor.");
}

async function selectScope({ evaluate }, scope) {
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Analysis scope"]');
    if (!select || select.disabled) throw new Error('Analysis scope is not available.');
    select.value = ${JSON.stringify(scope)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitUntil(evaluate, `document.querySelector('select[aria-label="Analysis scope"]')?.value === ${JSON.stringify(scope)}`, 2000, `${scope} selected`);
}

// Observe the real busy control before clicking. Completion is recorded in the
// browser, so CDP polling and Node scheduling do not inflate measured duration.
async function timedClick(protocol, selector = "#upload .analyze-button") {
  protocol.requests.length = 0;
  protocol.workerTargetsCreated.length = 0;
  await protocol.evaluate(`(() => {
    window.__timingScopeWorkerRequests = [];
    window.__timingScopePngEncodes = 0;
    window.__timingScopeProbe?.stop?.();
    const clicked = document.querySelector(${JSON.stringify(selector)});
    if (!clicked || clicked.disabled) throw new Error('Timed action is unavailable.');
    for (let parent = clicked.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    const initialPreviewSources = new Set([...document.querySelectorAll('.candidate-previews img')].map(image => image.getAttribute('src')));
    const probe = window.__timingScopeProbe = { startedAt: performance.now(), done: false, sawBusy: false,
      idleSince: null, durationMs: null, statusTransitions: [], maxCandidatePreviewImages: 0,
      initialCandidatePreviewImages: document.querySelectorAll('.candidate-previews img').length,
      maxNewCandidatePreviewImages: 0 };
    let frame;
    const sample = () => {
      if (probe.done) return;
      const now = performance.now();
      const run = document.querySelector('#upload .analyze-button');
      const busy = Boolean(run?.disabled);
      probe.sawBusy ||= busy;
      if (probe.sawBusy) {
        const status = document.querySelector('.quick-analysis-box .status-message')?.textContent.trim() ?? '';
        if (status !== probe.statusTransitions.at(-1)?.status && probe.statusTransitions.length < 1000)
          probe.statusTransitions.push({ elapsedMs: now - probe.startedAt, status });
        const previews = [...document.querySelectorAll('.candidate-previews img')];
        probe.maxCandidatePreviewImages = Math.max(probe.maxCandidatePreviewImages, previews.length);
        probe.maxNewCandidatePreviewImages = Math.max(probe.maxNewCandidatePreviewImages,
          previews.filter(image => !initialPreviewSources.has(image.getAttribute('src'))).length);
      }
      if (probe.sawBusy && !busy) {
        probe.idleSince ??= now;
        if (now - probe.idleSince >= 250) { probe.durationMs = probe.idleSince - probe.startedAt; probe.done = true; observer.disconnect(); return; }
      } else probe.idleSince = null;
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector('main') ?? document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    const tick = () => { sample(); if (!probe.done) frame = requestAnimationFrame(tick); };
    probe.stop = () => { observer.disconnect(); cancelAnimationFrame(frame); };
    clicked.click();
    tick();
  })()`);
  try {
    await waitUntil(protocol.evaluate, `window.__timingScopeProbe?.done`, timeoutMs, "analysis and queued video work to become idle");
    return await protocol.evaluate(`(() => { const { stop, ...measurement } = window.__timingScopeProbe; return measurement; })()`);
  } finally { await protocol.evaluate(`window.__timingScopeProbe?.stop?.()`).catch(() => undefined); }
}

async function exportDataset({ evaluate }) {
  return evaluate(`(() => {
    const original = navigator.clipboard.writeText; let captured;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { captured = text; } });
    try {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Copy JSON');
      if (!button || button.disabled) throw new Error('Dataset export is unavailable.');
      for (let parent = button.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      button.click(); return JSON.parse(captured);
    } finally { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: original }); }
  })()`);
}

const markerKeys = ["markerId", "acceptedRawTime", "climbTime", "detectedRawTime", "offsetApplied", "source", "confidence", "observationIntervalSeconds", "accepted", "acceptanceMode", "userAccepted", "userAdjusted"];
function acceptedTiming(dataset) {
  return ["startSignal", "finishPad"].map(id => {
    const marker = dataset.acceptedTimestamps.find(value => value.markerId === id);
    assert(marker, `Dataset is missing ${id}.`);
    return Object.fromEntries(markerKeys.map(key => [key, marker[key] ?? null]));
  });
}

async function collect(protocol, measurement) {
  const dataset = await exportDataset(protocol);
  const dom = await protocol.evaluate(`({
    selectedScope: document.querySelector('select[aria-label="Analysis scope"]')?.value,
    completedScope: document.querySelector('[data-last-analysis-scope]')?.dataset.lastAnalysisScope
      ?? document.querySelector('[data-analysis-scope]')?.dataset.analysisScope ?? null,
    activeScope: document.querySelector('[data-analysis-scope]')?.dataset.analysisScope ?? null,
    workerRequests: window.__timingScopeWorkerRequests,
    pngFrameEncodes: window.__timingScopePngEncodes,
    candidatePreviewImages: document.querySelectorAll('.candidate-previews img').length,
    routeMarkerCount: document.querySelectorAll('.video-route-hold').length,
    suggestedStart: [...document.querySelectorAll('button')].find(button => button.textContent.includes('Review suggested start'))?.textContent.trim() ?? null,
    status: document.querySelector('.quick-analysis-box .status-message')?.textContent.trim() ?? ''
  })`);
  return {
    ...measurement, ...dom, markers: acceptedTiming(dataset),
    otherAcceptedMarkers: dataset.acceptedTimestamps.filter(marker => !["startSignal", "finishPad"].includes(marker.markerId) && marker.acceptedRawTime !== null),
    movementCandidateCount: dataset.candidates.firstMovement.length,
    poseValidFrames: dataset.biomechanics?.result?.metrics?.validFrames ?? 0,
    poseFrameCount: dataset.biomechanics?.result?.frames?.length ?? 0,
    sourceFrameTimingAudit: dataset.sourceFrameTimingAudit,
    hold10EvidencePresent: Boolean(dataset.hold10SecondPassEvidence),
    modelRequests: [...new Set(protocol.requests.filter(modelRequest))],
    workerTargetsCreated: [...protocol.workerTargetsCreated],
    exceptions: [...protocol.exceptions],
  };
}

function assertTimingOnly(result, label) {
  assert.equal(result.poseFrameCount, 0, `${label}: timing-only published pose frames.`);
  assert.equal(result.poseValidFrames, 0, `${label}: timing-only published COM measurements.`);
  assert.equal(result.sourceFrameTimingAudit, null, `${label}: timing-only retained a pose sampling audit.`);
  assert.equal(result.hold10EvidencePresent, false, `${label}: timing-only ran the Hold 10 second pass.`);
  assert.equal(result.movementCandidateCount, 0, `${label}: timing-only published movement candidates.`);
  assert.deepEqual(result.otherAcceptedMarkers, [], `${label}: timing-only published movement or Hold 10 markers.`);
  assert.equal(result.candidatePreviewImages, 0, `${label}: timing-only retained candidate previews.`);
  assert.equal(result.maxNewCandidatePreviewImages, 0, `${label}: timing-only generated new candidate previews.`);
  assert.equal(result.pngFrameEncodes, 0, `${label}: timing-only encoded a PNG frame, indicating candidate-preview capture work.`);
  if (result.initialCandidatePreviewImages === 0)
    assert.equal(result.maxCandidatePreviewImages, 0, `${label}: timing-only queued candidate preview work.`);
  assert.equal(result.routeMarkerCount, 0, `${label}: timing-only registered route holds.`);
  assert.deepEqual(result.modelRequests, [], `${label}: timing-only requested pose/model resources.`);
  assert.deepEqual(result.workerRequests, [], `${label}: timing-only constructed a worker.`);
  assert.deepEqual(result.workerTargetsCreated, [], `${label}: CDP observed a worker created during timing-only.`);
  assert(!result.statusTransitions.some(entry => /Detecting the first visible movement|Checking that the camera stayed fixed|Following the climber|Registering the 20|Camera looks stable|Hold 10 second pass/i.test(entry.status)), `${label}: timing-only entered a movement analysis stage.`);
  assert.deepEqual(result.exceptions, [], `${label}: browser raised an uncaught exception.`);
}

function assertFull(result, label) {
  assert(result.markers.every(marker => marker.acceptedRawTime !== null), `${label}: expected accepted Start and Finish on this complete test clip.`);
  assert(result.poseValidFrames > 0, `${label}: full analysis did not produce valid pose measurements.`);
  assert(result.movementCandidateCount > 0, `${label}: full analysis did not produce movement candidates.`);
  assert(result.pngFrameEncodes > 0, `${label}: full analysis did not exercise candidate-preview frame capture.`);
  assert.deepEqual(result.exceptions, [], `${label}: browser raised an uncaught exception.`);
}

async function runPair(fileName, repeatIndex, pairIndex) {
  const order = pairIndex % 2 === 0 ? ["timing-only", "full"] : ["full", "timing-only"];
  const pair = { fileName, repeat: repeatIndex + 1, order, runs: {}, parity: false };
  report.pairs.push(pair);
  for (const scope of order) {
    const protocol = await openPage();
    try {
      await upload(protocol, fileName);
      await selectScope(protocol, scope);
      console.log(`${fileName} repeat ${repeatIndex + 1}: ${scope} started`);
      const result = await collect(protocol, await timedClick(protocol));
      pair.runs[scope] = result;
      if (scope === "timing-only") assertTimingOnly(result, fileName);
      else assertFull(result, fileName);
      console.log(`${fileName} repeat ${repeatIndex + 1}: ${scope} ${(result.durationMs / 1000).toFixed(3)}s`);
      if (!skipFollowup && !report.laterFull && scope === "timing-only") {
        await selectScope(protocol, "full");
        report.laterFull = { fileName, pairedMeasurement: false, ...(await collect(protocol, await timedClick(protocol))) };
        assertFull(report.laterFull, `${fileName} full after timing-only`);
        console.log(`${fileName}: later Full analysis works after timing-only`);
        await selectScope(protocol, "timing-only");
        report.reverseTimingOnly = { fileName, pairedMeasurement: false, ...(await collect(protocol, await timedClick(protocol))) };
        assertTimingOnly(report.reverseTimingOnly, `${fileName} timing-only after Full`);
        assert.deepEqual(report.reverseTimingOnly.markers, report.laterFull.markers, `${fileName}: switching Full to timing-only changed accepted timing evidence.`);
        assert.equal(report.reverseTimingOnly.completedScope, "timing-only", "The reverse run completed with the wrong scope.");
        console.log(`${fileName}: switching Full to timing-only clears movement output and preserves exact timing`);
      }
    } finally { await closePage(protocol); }
  }
  assert.deepEqual(pair.runs["timing-only"].markers, pair.runs.full.markers, `${fileName}: accepted Start/Finish provenance differs between scopes.`);
  pair.parity = true;
  pair.differenceMs = pair.runs.full.durationMs - pair.runs["timing-only"].durationMs;
}

async function runWeakStart() {
  const protocol = await openPage();
  try {
    await upload(protocol, weakStartFile);
    await selectScope(protocol, "timing-only");
    const paused = await collect(protocol, await timedClick(protocol));
    assertTimingOnly(paused, "weak Start paused");
    assert(paused.suggestedStart, "The weak-Start fixture no longer pauses for manual Start review.");
    assert(paused.markers.every(marker => marker.acceptedRawTime === null), "Weak Start accepted timing before manual review.");
    await selectScope(protocol, "full");
    await protocol.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.includes('Review suggested start'));
      if (!button || button.disabled) throw new Error('Suggested Start review is unavailable.');
      button.click();
    })()`);
    await waitUntil(protocol.evaluate, `Boolean(document.querySelector('.timestamp-review .primary:not(:disabled)'))`, 20000, "decoded review frame");
    const reviewFrame = await protocol.evaluate(`({
      acceptLabel: document.querySelector('.timestamp-review .primary')?.textContent,
      provenance: document.querySelector('[data-frame-time-source]')?.dataset.frameTimeSource,
      rawTime: document.querySelector('video')?.currentTime
    })`);
    const resumed = await collect(protocol, await timedClick(protocol, ".timestamp-review .primary"));
    report.weakStart = { fileName: weakStartFile, isGroundTruthAnnotation: false, paused, reviewFrame, resumed };
    assertTimingOnly(resumed, "weak Start resumed");
    assert.equal(resumed.selectedScope, "full", "The selection must change while the original context remains timing-only.");
    assert.equal(resumed.completedScope, "timing-only", "Manual Start continuation lost its originally captured timing-only scope.");
    assert(resumed.markers[0].acceptedRawTime !== null, "Manual Start acceptance did not survive continuation.");
    assert.notEqual(resumed.markers[0].acceptanceMode, "automatic", "Automated review workflow was incorrectly labeled automatic Start detection.");
    console.log(`${weakStartFile}: paused Start resumed its captured timing-only scope`);
  } finally { await closePage(protocol); }
}

function summarizePairs() {
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  };
  return fileNames.map(fileName => {
    const completed = report.pairs.filter(pair => pair.fileName === fileName && pair.parity);
    if (!completed.length) return { fileName, completePairs: 0 };
    const full = completed.map(pair => pair.runs.full.durationMs);
    const timing = completed.map(pair => pair.runs["timing-only"].durationMs);
    return { fileName, completePairs: completed.length,
      fullMedianMs: median(full), timingOnlyMedianMs: median(timing),
      fullRangeMs: [Math.min(...full), Math.max(...full)], timingOnlyRangeMs: [Math.min(...timing), Math.max(...timing)],
      pairedDifferenceMedianMs: median(completed.map(pair => pair.differenceMs)),
    };
  });
}

try {
  for (const fileName of new Set([...fileNames, ...(skipWeakStart ? [] : [weakStartFile])])) report.sourceFingerprints[fileName] = await sourceFingerprint(fileName);
  await launch();
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
    for (let fileIndex = 0; fileIndex < fileNames.length; fileIndex += 1) {
      await runPair(fileNames[fileIndex], repeatIndex, repeatIndex + fileIndex);
    }
  }
  if (!skipWeakStart) await runWeakStart();
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(lastProtocol?.send); }
    catch (error) {
      report.errors.push(`Browser cleanup: ${error.stack ?? error}`);
      report.passed = false;
      process.exitCode = 1;
    }
  }
  for (const socket of openSockets) socket.close();
  report.finishedAt = new Date().toISOString();
  report.summary = summarizePairs();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? "PASS" : "FAIL"}: timing scope report ${reportPath}`);
}
