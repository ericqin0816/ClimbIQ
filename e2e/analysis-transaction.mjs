/**
 * A rejected/review-only rerun must not partly replace committed analysis.
 * Uses real local video and detectors. Imported manual markers/calibration are
 * deliberately synthetic workflow state, never event annotations or accuracy.
 * Run against a frozen production preview, e.g. CLIMBIQ_E2E_URL=http://127.0.0.1:4173/.
 * Default: weak fusion review and a real 0–0.5 s no-found search, both scopes.
 * Also cover a discovered lane rejected by the body audit with:
 *   node e2e/analysis-transaction.mjs --file=12.24.mov --start-offset=-2 --cases=review --report=test-results/analysis-transaction-audit.json
 * The deliberately early correction is a workflow stimulus, not a timing label.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProtocolClient } from "./cdp-client.mjs";
import { startTestBrowser } from "./test-browser.mjs";
import { readSessionLibraryJson } from "./session-library.mjs";

const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:4173/";
const videoDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const fileName = argument("file", "IMG_9075.MOV");
const startOffset = Number(argument("start-offset", "0"));
const cases = argument("cases", "review,no-found").split(",");
const scopes = argument("scopes", "full,timing-only").split(",");
const reportPath = path.resolve(argument("report", "test-results/analysis-transaction.json"));
assert(cases.length && cases.every(value => ["review", "no-found"].includes(value)), "--cases must contain review and/or no-found.");
assert(scopes.length && scopes.every(value => ["full", "timing-only"].includes(value)), "--scopes must contain full and/or timing-only.");
assert(Number.isFinite(startOffset) && Math.abs(startOffset) <= 2, "--start-offset must be within the real setting's −2 to 2 second range.");
const allowDev = process.argv.includes("--allow-dev");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const report = { startedAt: new Date().toISOString(), appUrl, fileName, startOffset, passed: false,
  methodology: { syntheticAcceptedState: true, independentAccuracyClaim: false, realDetectors: true,
    description: "Manual marker values and saved RGB calibration are workflow fixtures, not event labels. Review/no-found reruns must retain all committed evidence while displaying only a new unaccepted proposal.", allowDev },
  app: null, sourceFingerprint: null, cases: [], errors: [] };
let browser, lastSend;
const openSockets = new Set();

async function until(evaluate, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(expression);
    if (result) return result;
    await sleep(100);
  }
  const status = await evaluate(`({ analysis: document.querySelector('.quick-analysis-box .status-message')?.textContent,
    library: document.querySelector('#saved-attempts')?.textContent.slice(-1200), video: document.querySelector('.video-meta-line')?.textContent })`);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(status)}`);
}

async function openPage() {
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/new?about%3Ablank`, { method: "PUT" });
  assert(response.ok, "Could not open isolated browser page.");
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  openSockets.add(socket);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const { send } = createProtocolClient(socket);
  lastSend = send;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const requests = [], exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Page.navigate", { url: appUrl });
  await until(evaluate, `Boolean(document.querySelector('select[aria-label="Analysis scope"]')) && document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'`, "app and saved library");
  const app = await evaluate(`({ url:location.href, version:document.querySelector('[data-app-version]')?.dataset.appVersion,
    entryScripts:[...document.scripts].map(script=>script.src).filter(Boolean) })`);
  if (!allowDev) assert(!app.entryScripts.some(url => url.includes("@vite/client")), "Use an immutable production preview; --allow-dev is for workflow debugging only.");
  if (report.app) assert.deepEqual(app, report.app, "The served build changed between cases.");
  else report.app = app;
  return { send, evaluate, requests, exceptions, socket, targetId: target.id };
}

async function setFile(protocol, selector, filePath) {
  const input = await protocol.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
  assert(input.result.objectId, `Missing file input ${selector}.`);
  await protocol.send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [filePath] });
}

function seedSession(id, metadata, scenario) {
  assert(metadata.duration > 3, "Transaction fixture requires at least three seconds of video.");
  const marker = (markerId, label, rawTime) => ({ id: markerId, label, rawTime, climbTime: rawTime - 1,
    detectedRawTime: rawTime, offsetApplied: 0, source: "Manual", confidence: "Medium", acceptanceMode: "manual-entry",
    note: "Synthetic prior accepted workflow state; not an event annotation." });
  return { id, attemptLineageId: id, version: 1, name: `Transaction fixture ${id}`,
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    date: "2026-09-22", climberName: "", location: "Local workflow test", attemptType: "Training",
    notes: "Retain this saved note and calibration. All seeded marker values are synthetic workflow state, never timing truth.",
    videoFileName: fileName, videoMetadata: { ...metadata, fileName, metadataLoaded: true }, zones: {},
    startLightCalibration: { beforeStartRGB: { r: 17, g: 91, b: 33 }, afterStartRGB: { r: 19, g: 29, b: 117 },
      calibrationFrameBeforeTime: 0.1, calibrationFrameAfterTime: 0.2 },
    timestamps: [marker("startSignal", "Start Signal", 1), marker("finishPad", "Finish Pad", Math.min(metadata.duration - 1, 8))],
    settings: { startSearchStart: 0, startSearchEnd: scenario === "no-found" ? 0.5 : 12,
      startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto", reactionTimeOffset: 0.2,
      startSignalOffset: startOffset, movementSensitivity: "medium", firstMovementDefinition: "earliest",
      committedLaunchMinDelay: 0.1, firstMovementOffset: 0, officialTotalTime: "" } };
}

async function exportDataset({ evaluate }) {
  return evaluate(`(() => {
    const original=navigator.clipboard.writeText;let text;
    Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async value=>{text=value;}});
    try { const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Copy JSON');
      if(!button||button.disabled)throw new Error('Dataset export unavailable.');
      for(let parent=button.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
      button.click();return JSON.parse(text);
    } finally { Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:original}); }
  })()`);
}

function committedSnapshot(dataset) {
  return { session: dataset.session, markers: dataset.acceptedTimestamps, zones: dataset.zones,
    calibration: dataset.calibration, settings: dataset.settings, biomechanics: dataset.biomechanics,
    sourceFrameTimingAudit: dataset.sourceFrameTimingAudit, hold10Evidence: dataset.hold10SecondPassEvidence };
}

async function runCase(scenario, scope, index) {
  const result = { scenario, scope, passed: false };
  report.cases.push(result);
  let protocol;
  try {
    protocol = await openPage();
    const { evaluate } = protocol;
    await setFile(protocol, '.upload-dropzone input[type="file"]', path.resolve(videoDirectory, fileName));
    await until(evaluate, `Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))`, "uploaded video ready");
    const metadata = await evaluate(`(() => {const video=document.querySelector('video');return {duration:video.duration,videoWidth:video.videoWidth,videoHeight:video.videoHeight};})()`);
    const seed = seedSession(`transaction-${scenario}-${scope}-${index}`, metadata, scenario);
    const seedPath = path.join(browser.temporaryRoot, `${seed.id}.json`);
    await writeFile(seedPath, JSON.stringify(seed));
    await setFile(protocol, '#saved-attempts input[type="file"]', seedPath);
    await until(evaluate, `Boolean(document.querySelector('[data-video-attachment-choice]'))`, "imported saved session needs explicit source association");
    await evaluate(`(() => {const button=[...document.querySelectorAll('[data-video-attachment-choice] button')].find(button=>button.textContent.trim()==='Attach to this attempt');if(!button)throw new Error('Attach control unavailable.');button.click();})()`);
    await until(evaluate, `Boolean(document.querySelector('#upload .analyze-button:not(:disabled)')) && document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState==='ready'`, "saved analysis reattached to decoded video");
    await evaluate(`(() => {const select=document.querySelector('select[aria-label="Analysis scope"]');select.value=${JSON.stringify(scope)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(evaluate, `document.querySelector('select[aria-label="Analysis scope"]')?.value===${JSON.stringify(scope)}`, "scope selected");
    await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Review finish / mark pad');
      if(!button||button.disabled)throw new Error('Existing Finish review unavailable.');button.click();})()`);
    await until(evaluate, `Boolean(document.querySelector('.timestamp-review .primary:not(:disabled)')) && !document.querySelector('video').seeking`, "prior Finish review decoded");
    result.priorReview = await evaluate(`({ label:document.querySelector('.timestamp-review')?.textContent, cursor:document.querySelector('video').currentTime })`);
    assert.match(result.priorReview.label, /Set reviewed finish/, "Fixture did not open its prior Finish callback.");
    result.before = committedSnapshot(await exportDataset(protocol));
    assert.equal(result.before.session.notes, seed.notes, "Fixture notes were not imported.");
    assert.equal(result.before.markers.find(marker => marker.markerId === "finishPad")?.acceptedRawTime, seed.timestamps[1].rawTime, "Fixture Finish was not imported.");
    const savedBefore = await readSessionLibraryJson(evaluate);
    protocol.requests.length = 0;
    await evaluate(`document.querySelector('#upload .analyze-button').click()`);
    await until(evaluate, `document.querySelector('[data-analysis-running]')?.dataset.analysisRunning==='true'`, "rerun starts");
    await until(evaluate, `document.querySelector('[data-analysis-running]')?.dataset.analysisRunning==='false' && Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))`, "rerun finishes or pauses", 180000);
    const dataset = await exportDataset(protocol);
    result.after = committedSnapshot(dataset);
    result.changedCommittedFields = Object.keys(result.before).filter(key => {
      try { assert.deepEqual(result.after[key], result.before[key]); return false; } catch { return true; }
    });
    result.status = await evaluate(`document.querySelector('.quick-analysis-box .status-message')?.textContent.trim()`);
    result.reviewButton = await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Review suggested start'))?.textContent.trim() ?? null`);
    result.reviewAfter = await evaluate(`({ label:document.querySelector('.timestamp-review')?.textContent ?? null, cursor:document.querySelector('video').currentTime })`);
    result.proposalCandidates = dataset.candidates.startSignal;
    result.modelRequests = protocol.requests.filter(url => /\/models\/|\.task(?:\?|$)|vision_wasm|poseInference[.-]worker|\/wasm\//i.test(url));
    result.exceptions = [...protocol.exceptions];
    if (scenario === "review") {
      assert(result.reviewButton, "Fixture did not pause with a fresh Start review proposal.");
      assert(result.proposalCandidates.length > 0, "Review proposal candidates are missing.");
      assert.match(result.status, /Start (?:evidence|cues).*review/i, "Fixture did not enter the expected review branch.");
      assert(!result.reviewAfter.label?.includes("Set reviewed finish"), "The old Finish acceptance callback remained visible at the new Start proposal cursor.");
    } else {
      assert.match(result.status, /Start could not be confirmed/i, "Fixture did not enter the expected no-found branch.");
      assert.equal(result.reviewButton, null, "No-found rerun unexpectedly retained a Start proposal.");
      assert(Math.abs(result.reviewAfter.cursor - result.priorReview.cursor) < 0.002, "No-found rerun did not restore the prior review cursor.");
    }
    assert.deepEqual(result.after, result.before, "Uncommitted rerun partly replaced previous accepted analysis.");
    assert.equal(await readSessionLibraryJson(evaluate), savedBefore, "Rerun changed the saved library without Save.");
    assert.deepEqual(result.modelRequests, [], "Uncommitted Start must not start pose/model work.");
    assert.deepEqual(result.exceptions, [], "Browser raised an uncaught exception.");
    result.passed = true;
    console.log(`PASS ${scenario}/${scope}: committed analysis retained; ${scenario === "review" ? "fresh proposal visible" : "no Start committed"}.`);
  } catch (error) {
    result.error = error.stack ?? String(error);
    report.errors.push(`${scenario}/${scope}: ${result.error}`);
    console.error(`FAIL ${scenario}/${scope}: ${error.message ?? error}`);
  } finally {
    if (protocol) {
      await fetch(`http://127.0.0.1:${browser.port}/json/close/${protocol.targetId}`).catch(() => undefined);
      protocol.socket.close(); openSockets.delete(protocol.socket);
    }
  }
}

try {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path.resolve(videoDirectory, fileName))) { hash.update(chunk); bytes += chunk.length; }
  report.sourceFingerprint = { bytes, sha256: hash.digest("hex") };
  browser = await startTestBrowser({ label: "analysis-transaction", args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
  for (const scenario of cases) for (const scope of scopes) await runCase(scenario, scope, report.cases.length);
  report.passed = report.cases.length > 0 && report.cases.every(result => result.passed);
} catch (error) {
  report.errors.push(error.stack ?? String(error));
} finally {
  if (browser) try { await browser.close(lastSend); } catch (error) { report.errors.push(`Browser cleanup: ${error.stack ?? error}`); report.passed = false; }
  for (const socket of openSockets) socket.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!report.passed) process.exitCode = 1;
  console.log(`${report.passed ? "PASS" : "FAIL"}: ${reportPath}`);
}
