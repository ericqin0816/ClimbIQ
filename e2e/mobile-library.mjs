import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";
import { readSessionLibraryJson, waitForSessionLibraryChange } from "./session-library.mjs";

// Synthetic JSON only: this suite never opens private video or user browser data.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "climbiq-mobile-library-"));
const profile = path.join(temporaryRoot, "profile");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { status: "running", appUrl, checks: [] };
let socket;
let peerSocket;
let sendCommand;
let spawnError;
const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore", windowsHide: true });
chrome.once("error", error => { spawnError = error; });

function session(id, name, finishTime = 6.2, updatedAt = "2026-09-01T00:00:00.000Z") {
  const marker = (markerId, label, rawTime) => ({
    id: markerId, label, rawTime, climbTime: rawTime - 1,
    detectedRawTime: rawTime, offsetApplied: 0, source: "Manual", confidence: "High",
    acceptanceMode: "frame-review", observationIntervalSeconds: 1 / 30,
  });
  return {
    id, version: 1, name, createdAt: "2026-09-01T00:00:00.000Z", updatedAt,
    climberName: "Synthetic tester", date: "2026-09-01", location: "Synthetic fixture", attemptType: "Training", notes: "No real athlete or recording.",
    videoFileName: "synthetic-run.mp4",
    videoMetadata: { fileName: "synthetic-run.mp4", duration: 8, videoWidth: 640, videoHeight: 480, metadataLoaded: true },
    zones: {}, startLightCalibration: {},
    timestamps: [marker("startSignal", "Start Signal", 1), marker("firstMovement", "Earliest Visible Motion", 1.25), marker("finishPad", "Finish Pad", finishTime)],
    settings: {
      startSearchStart: 0, startSearchEnd: 8, startSensitivity: "medium", startLightVisibility: "clear",
      startDetectionProfile: "auto", reactionTimeOffset: 0.2, startSignalOffset: 0,
      movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: 0.1,
      firstMovementOffset: 0, officialTotalTime: "",
    },
  };
}

try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    try {
      port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
      if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* The isolated Chrome process is still starting. */ }
    await delay(100);
  }
  if (!port) throw new Error("The isolated Chrome debugger did not start.");
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error("Could not open the application in the test browser.");
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const { send } = createProtocolClient(socket);
  sendCommand = send;
  const runtimeErrors = [];
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const until = async (expression, label, timeoutMs = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(80);
    }
    const status = await evaluate("({state:document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState,status:document.querySelector('#saved-attempts .library-transfer .status-message')?.textContent,alert:document.querySelector('#saved-attempts [role=alert]')?.textContent})");
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(status)}`);
  };
  const libraryReady = () => until("document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'", "saved library to be ready");
  const fileInput = "document.querySelector('#saved-attempts input[type=file]')";
  const importFixture = async filename => {
    await until(`Boolean(${fileInput} && !${fileInput}.disabled)`, "import control enabled");
    const input = await send("Runtime.evaluate", { expression: fileInput });
    assert.ok(input.result.objectId, "Import file input must exist.");
    await send("DOM.setFileInputFiles", { files: [filename], objectId: input.result.objectId });
  };
  const clickMobileDestination = async id => {
    const point = await evaluate(`(() => {
      const link = document.querySelector('.mobile-workflow a[href="#${id}"]');
      if (!link) throw new Error('Mobile destination is unavailable: ${id}');
      const rect = link.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) throw new Error('Mobile target is smaller than 44px.');
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await until(`location.hash === '#${id}' && (() => {
      const section = document.getElementById('${id}')?.getBoundingClientRect();
      const nav = document.querySelector('.mobile-workflow')?.getBoundingClientRect();
      return section && nav && section.top >= -1 && section.top < nav.top;
    })()`, `visible ${id} destination`);
  };

  await libraryReady();
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const width of [390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("window.scrollTo({top:0,behavior:'instant'})");
    await clickMobileDestination("saved-attempts");
    const empty = await evaluate(`({
      text: document.querySelector('#saved-attempts')?.textContent,
      reviewDisabled: Boolean(document.querySelector('.mobile-workflow button[aria-label^="Review:"]')?.disabled),
      resultsDisabled: Boolean(document.querySelector('.mobile-workflow button[aria-label^="Results:"]')?.disabled),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    })`);
    assert.match(empty.text, /Your training history starts with one run/);
    assert.equal(empty.reviewDisabled, true);
    assert.equal(empty.resultsDisabled, true);
    assert.equal(empty.overflow, false, `Unexpected horizontal overflow at ${width}px.`);
    report.checks.push(`empty library reachable at ${width}px with 44px navigation targets`);
  }

  const original = session("mobile-legacy", "Legacy single attempt");
  const legacyJson = JSON.stringify([original]);
  await evaluate(`localStorage.setItem('climbiq.analysisSessions.v1', ${JSON.stringify(legacyJson)})`);
  await send("Page.reload", { ignoreCache: true });
  await until("document.querySelector('#saved-attempts .saved-session-list')?.textContent.includes('Legacy single attempt')", "migrated session visible");
  await libraryReady();
  // Read IndexedDB directly so a fallback to the legacy key cannot pass migration.
  const committedMigration = await evaluate(`(async () => {
    const database = await new Promise((resolve,reject) => { const request=indexedDB.open('climbiq');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error); });
    try { return await new Promise((resolve,reject) => { const transaction=database.transaction('session-libraries','readonly');const request=transaction.objectStore('session-libraries').get('analysisSessions.v1');transaction.oncomplete=()=>resolve(request.result);transaction.onabort=()=>reject(transaction.error); }); }
    finally { database.close(); }
  })()`);
  assert.equal(JSON.parse(committedMigration)[0].id, original.id);
  assert.equal(await evaluate("localStorage.getItem('climbiq.analysisSessions.v1')"), legacyJson, "Migration must retain the original legacy backup.");
  report.checks.push("legacy library migrated to IndexedDB with original backup preserved");

  await evaluate("document.querySelector('#saved-attempts .saved-session-list button').click()");
  await until("document.querySelector('#results .summary-primary-metric strong')?.textContent === '5.200s'", "saved total without a video");
  await clickMobileDestination("results");
  const restored = await evaluate(`({
    playerPresent: Boolean(document.querySelector('#video-review video')),
    readyBadge: Boolean(document.querySelector('.video-meta-line')),
    analyzeDisabled: Boolean(document.querySelector('#upload .analyze-button')?.disabled),
    reviewDisabled: Boolean(document.querySelector('.mobile-workflow button[aria-label^="Review:"]')?.disabled),
    resultsEnabled: Boolean(document.querySelector('.mobile-workflow a[href="#results"]')),
  })`);
  assert.deepEqual(restored, { playerPresent: false, readyBadge: false, analyzeDisabled: true, reviewDisabled: true, resultsEnabled: true });
  report.checks.push("one restored attempt displays its total while video analysis stays disabled");

  const localOnly = session("mobile-local-only", "Local-only attempt", 6.8);
  const localOnlyFile = path.join(temporaryRoot, "local-only.climbiq-session.json");
  await writeFile(localOnlyFile, JSON.stringify(localOnly));
  let previous = await readSessionLibraryJson(evaluate);
  await importFixture(localOnlyFile);
  await waitForSessionLibraryChange(evaluate, previous);
  await until("document.querySelector('#results .summary-primary-metric strong')?.textContent === '5.800s'", "single-session import opened");
  const localOnlyStored = JSON.parse(await readSessionLibraryJson(evaluate)).find(item => item.id === localOnly.id);

  const updated = session(original.id, "Newer imported attempt", 5.9, "2027-01-01T00:00:00.000Z");
  const additional = session("mobile-new", "Additional imported attempt", 6.5);
  const backupFile = path.join(temporaryRoot, "newer-library.json");
  await writeFile(backupFile, JSON.stringify({ format: "climbiq-session-library", version: 1, exportedAt: "2027-01-01T00:00:00.000Z", sessions: [updated, additional] }));
  previous = await readSessionLibraryJson(evaluate);

  // Keep file reading pending to exercise the gap before a storage write starts.
  await evaluate(`(() => {
    const originalText = File.prototype.text;
    window.__mobileLibraryImportStarted = false;
    File.prototype.text = function () {
      File.prototype.text = originalText;
      const file = this;
      window.__mobileLibraryImportStarted = true;
      return new Promise((resolve,reject) => { window.__releaseMobileLibraryImport = () => originalText.call(file).then(resolve,reject); });
    };
  })()`);
  await importFixture(backupFile);
  await until("window.__mobileLibraryImportStarted && document.querySelector('.upload-dropzone input')?.disabled", "pending import locks video replacement");
  assert.equal(await readSessionLibraryJson(evaluate), previous, "Pending file reading must not mutate durable storage.");
  await evaluate(`(() => {
    const input = document.querySelector('.upload-dropzone input');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['synthetic invalid video'], 'replacement.mp4', {type:'video/mp4'}));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  assert.equal(await evaluate("Boolean(document.querySelector('#video-review video'))"), false, "A programmatic replacement must also be blocked while import is pending.");
  await evaluate("window.__releaseMobileLibraryImport()");
  const imported = JSON.parse(await waitForSessionLibraryChange(evaluate, previous));
  assert.deepEqual(imported.map(item => item.id).sort(), [original.id, localOnly.id, additional.id].sort());
  assert.equal(imported.find(item => item.id === original.id).name, updated.name);
  assert.deepEqual(imported.find(item => item.id === localOnly.id), localOnlyStored, "Import must preserve the local-only attempt exactly.");
  await until("!document.querySelector('.upload-dropzone input')?.disabled", "video replacement unlocks after import");
  report.checks.push("delayed import blocks replacement, updates newer copies, and preserves local-only attempts");

  for (const [filename, content, expectedError] of [
    ["malformed.json", '{"broken":', /JSON|Unexpected|position|property/i],
    ["unsupported.json", JSON.stringify({ version: 999, name: "Unsupported" }), /not a ClimbIQ analysis session/i],
  ]) {
    const fixturePath = path.join(temporaryRoot, filename);
    await writeFile(fixturePath, content);
    const before = await readSessionLibraryJson(evaluate);
    const oldStatus = await evaluate("document.querySelector('#saved-attempts .library-transfer .status-message')?.textContent ?? ''");
    await importFixture(fixturePath);
    const status = await until(`(() => {
      const status = document.querySelector('#saved-attempts .library-transfer .status-message')?.textContent;
      return status && status !== ${JSON.stringify(oldStatus)} && !${fileInput}.disabled ? status : false;
    })()`, `visible rejection of ${filename}`);
    assert.match(status, expectedError);
    assert.equal(await readSessionLibraryJson(evaluate), before, "Rejected imports must not change durable storage.");
  }
  report.checks.push("malformed and unsupported imports show errors and preserve the committed library");

  await send("Page.reload", { ignoreCache: true });
  await until("document.querySelector('#saved-attempts .saved-session-list')?.textContent.includes('Newer imported attempt')", "committed import survives reload");
  await libraryReady();
  assert.equal(JSON.parse(await readSessionLibraryJson(evaluate)).length, 3);
  // Search and filtering must leave the persisted library unchanged.
  const beforeSearch = await readSessionLibraryJson(evaluate);
  await evaluate(`(() => {
    const input = document.querySelector('.attempt-library-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'newer');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await until("document.querySelectorAll('.attempt-library-list button').length === 1", "search narrows the library");
  assert.match(await evaluate("document.querySelector('.attempt-library-list')?.textContent"), /Newer imported attempt/);
  await evaluate(`(() => {
    const select = document.querySelector('.attempt-library-tools select');
    select.value = 'review'; select.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await until("document.querySelector('.attempt-library-empty')?.textContent.includes('No attempts match')", "timing filter empty state");
  await evaluate("[...document.querySelectorAll('.attempt-library-empty button')].find(button => button.textContent.includes('Clear search')).click()");
  await until("document.querySelectorAll('.attempt-library-list button').length === 3", "clearing filters restores all attempts");
  assert.equal(await readSessionLibraryJson(evaluate), beforeSearch, "Searching must not alter saved attempts.");
  assert.equal(await evaluate("document.documentElement.scrollWidth > window.innerWidth"), false, "Filtered library must fit the narrow phone viewport.");
  report.checks.push("search and timing filters expose matching attempts without changing stored data");

  await evaluate("document.querySelector('.attempt-library-list button').click()");
  await until("Boolean(document.querySelector('#save-analysis')) && Boolean(document.querySelector('#coaching-review'))", "saved editing and coaching without video");
  await until("[...document.querySelectorAll('#coaching-review button')].some(button => button.textContent === 'Review my run')", "saved-review panel finished loading");
  await evaluate("[...document.querySelectorAll('#coaching-review button')].find(button => button.textContent === 'Review my run').click()");
  await until("Boolean(document.querySelector('.coaching-result'))", "local review from saved measurements");
  assert.equal(await evaluate("[...document.querySelectorAll('.coaching-result button')].some(button => button.textContent.startsWith('View '))"), false, "A saved-only review must not offer source-video seek links.");
  const beforeDelete = await readSessionLibraryJson(evaluate);
  await evaluate("document.querySelector('.session-details').open = true");
  await evaluate("[...document.querySelectorAll('#save-analysis button')].find(button => button.textContent === 'Delete Session').click()");
  const afterDelete = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeDelete));
  assert.equal(afterDelete.length, 2);
  await evaluate("[...document.querySelectorAll('#saved-attempts button')].find(button => button.textContent === 'Undo last deletion').click()");
  const restoredLibrary = JSON.parse(await waitForSessionLibraryChange(evaluate, JSON.stringify(afterDelete)));
  const byId = values => [...values].sort((a,b) => a.id.localeCompare(b.id));
  assert.deepEqual(byId(restoredLibrary), byId(JSON.parse(beforeDelete)), "Undo must restore exact saved measurements, without replacing other attempts.");
  report.checks.push("saved-only coaching hides video links and undo restores exact deleted measurements");

  // Two independently loaded app instances must never silently replace each
  // other's library. Keep the unsaved editor available after reloading storage.
  const editedId = restoredLibrary[0].id;
  const chooseAttempt = id => `(() => { const buttons = [...document.querySelectorAll('.attempt-library-list button')];
    const wanted = ${JSON.stringify(restoredLibrary)}.find(session => session.id === ${JSON.stringify(id)});
    const button = buttons.find(button => button.querySelector('strong')?.textContent === wanted.name);
    if (!button) throw new Error('Saved attempt is missing'); button.click(); })()`;
  await evaluate(chooseAttempt(editedId));
  const peerTargetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  const peerTarget = await peerTargetResponse.json();
  peerSocket = new WebSocket(peerTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    peerSocket.addEventListener("open", resolve, { once: true });
    peerSocket.addEventListener("error", reject, { once: true });
  });
  const peer = createProtocolClient(peerSocket);
  const evaluatePeer = async expression => {
    const response = await peer.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  for (let wait = 0; wait < 150; wait++) {
    if (await evaluatePeer("document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'")) break;
    if (wait === 149) throw new Error("Second tab did not open the saved library.");
    await delay(80);
  }
  await evaluatePeer(chooseAttempt(editedId));
  const notesExpression = text => `(() => { const input = document.querySelector('#save-analysis textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', {bubbles:true})); })()`;
  await evaluate(notesExpression("Unsaved notes from the first tab"));
  await evaluatePeer(notesExpression("Newer notes saved by the second tab"));
  const saveButton = "document.querySelector('#save-analysis .session-save-summary button')";
  const beforePeerSave = await readSessionLibraryJson(evaluate);
  await evaluatePeer(`${saveButton}.click()`);
  const peerSaved = JSON.parse(await waitForSessionLibraryChange(evaluate, beforePeerSave));
  const peerAttempt = peerSaved.find(session => session.id === editedId);
  assert.equal(peerAttempt.notes, "Newer notes saved by the second tab");
  await evaluate(`${saveButton}.click()`);
  await until("document.querySelector('#saved-attempts [role=alert]')?.textContent.includes('another tab')", "stale write conflict");
  assert.equal(await evaluate(`${saveButton}.disabled`), true, "Conflict must disable stale writes until reload.");
  assert.equal(await evaluate("document.querySelector('#save-analysis textarea').value"), "Unsaved notes from the first tab");
  assert.deepEqual(JSON.parse(await readSessionLibraryJson(evaluate)), peerSaved, "Conflict must preserve the other tab's exact committed data.");
  assert.equal(await evaluate("[...document.querySelectorAll('#save-analysis button')].find(button => button.textContent === 'Export current session').disabled"), false, "The unsaved analysis must remain exportable after conflict.");
  await evaluate("document.querySelector('#saved-attempts [role=alert] button').click()");
  await libraryReady();
  assert.equal(await evaluate("document.querySelector('.session-load-row select').value"), "", "Reload must detach the stale editor from the newer saved attempt.");
  assert.equal(await evaluate("document.querySelector('#save-analysis textarea').value"), "Unsaved notes from the first tab");
  assert.equal(await evaluate("Boolean(document.querySelector('#results')) && Boolean(document.querySelector('#coaching-review'))"), true, "The detached saved-only draft must remain visible without a video.");
  const beforeDraftSave = await readSessionLibraryJson(evaluate);
  await evaluate(`${saveButton}.click()`);
  const withDraft = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeDraftSave));
  const preserved = withDraft.find(session => session.id === editedId);
  const draft = withDraft.find(session => session.notes === "Unsaved notes from the first tab");
  assert.deepEqual(preserved, peerAttempt, "Saving the draft after reload must not overwrite the other editor's attempt.");
  assert.ok(draft && draft.id !== editedId);
  assert.equal(draft.attemptLineageId, peerAttempt.attemptLineageId ?? editedId, "Detached copies must retain their attempt identity.");
  report.checks.push("two tabs preserve newer saves, retain the unsaved draft, and save it as a separate copy after reload");

  const beforeDuplicate = await readSessionLibraryJson(evaluate);
  await evaluate("[...document.querySelectorAll('#save-analysis button')].find(button => button.textContent === 'Duplicate Session').click()");
  const withDuplicate = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeDuplicate));
  const duplicate = withDuplicate.find(session => !withDraft.some(previous => previous.id === session.id));
  assert.equal(duplicate.attemptLineageId, draft.attemptLineageId);
  await evaluate(`(() => { const create = URL.createObjectURL; URL.createObjectURL = function(blob) {
    if (blob.type === 'application/json') window.__libraryExport = blob.text(); return create.call(this, blob); }; })()`);
  await evaluate("[...document.querySelectorAll('#save-analysis button')].find(button => button.textContent === 'Export current session').click()");
  await until("Boolean(window.__libraryExport)", "current session export");
  const exported = await evaluate("(async () => JSON.parse(await window.__libraryExport))()");
  assert.equal(exported.attemptLineageId, draft.attemptLineageId);
  const exportedPath = path.join(temporaryRoot, "lineage-roundtrip.json");
  await writeFile(exportedPath, JSON.stringify({ ...exported, id: "roundtrip-lineage-copy" }));
  const beforeRoundtrip = await readSessionLibraryJson(evaluate);
  await importFixture(exportedPath);
  const roundtrip = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeRoundtrip));
  assert.equal(roundtrip.find(session => session.id === "roundtrip-lineage-copy").attemptLineageId, draft.attemptLineageId);
  report.checks.push("duplicate, session export, and import retain the original attempt lineage");

  const datasetPath = path.join(temporaryRoot, "lineage-dataset-roundtrip.json");
  await writeFile(datasetPath, JSON.stringify({ appVersion: "0.29.0", exportTimestamp: exported.updatedAt,
    session: { sessionId: "dataset-lineage-copy", sessionName: "Dataset lineage copy", attemptLineageId: exported.attemptLineageId },
    video: exported.videoMetadata, settings: exported.settings,
    acceptedTimestamps: exported.timestamps.map(marker => ({ markerId: marker.id, acceptedRawTime: marker.rawTime,
      source: marker.source, confidence: marker.confidence, acceptanceMode: marker.acceptanceMode, observationIntervalSeconds: marker.observationIntervalSeconds })),
  }));
  const beforeDataset = await readSessionLibraryJson(evaluate);
  await importFixture(datasetPath);
  const withDataset = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeDataset));
  assert.equal(withDataset.find(session => session.id === "dataset-lineage-copy").attemptLineageId, draft.attemptLineageId);
  const invalidLineagePath = path.join(temporaryRoot, "invalid-lineage.json");
  await writeFile(invalidLineagePath, JSON.stringify({ ...exported, id: "invalid-lineage-copy", attemptLineageId: "bad\u0000identity" }));
  const beforeInvalidLineage = await readSessionLibraryJson(evaluate);
  await importFixture(invalidLineagePath);
  const withInvalidLineage = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeInvalidLineage));
  assert.equal(withInvalidLineage.find(session => session.id === "invalid-lineage-copy").attemptLineageId, undefined,
    "Import must drop malformed lineage rather than normalize it into another attempt's identity.");
  report.checks.push("dataset import preserves lineage and malformed lineage is discarded without truncation");

  const legacyCopyPath = path.join(temporaryRoot, "legacy-copy-update.json");
  await writeFile(legacyCopyPath, JSON.stringify({ ...exported, id: "roundtrip-lineage-copy", attemptLineageId: undefined,
    videoMetadata: null, notes: "Legacy edit of the same copied attempt" }));
  const beforeLegacyCopy = await readSessionLibraryJson(evaluate);
  await importFixture(legacyCopyPath);
  const legacyCopyLibrary = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeLegacyCopy));
  const updatedCopy = legacyCopyLibrary.find(session => session.id === "roundtrip-lineage-copy");
  assert.equal(updatedCopy.attemptLineageId, draft.attemptLineageId, "A legacy same-ID session import must not erase established lineage.");
  const newerLibraryPath = path.join(temporaryRoot, "newer-copy-library.json");
  await writeFile(newerLibraryPath, JSON.stringify({ format: "climbiq-session-library", version: 1,
    exportedAt: "2099-01-01T00:00:00.000Z", sessions: [{ ...updatedCopy, attemptLineageId: "conflicting-imported-lineage",
      updatedAt: "2099-01-01T00:00:00.000Z", notes: "Newer measurements from another device" }] }));
  const beforeNewerLibrary = await readSessionLibraryJson(evaluate);
  await importFixture(newerLibraryPath);
  const newerLibrary = JSON.parse(await waitForSessionLibraryChange(evaluate, beforeNewerLibrary));
  assert.equal(newerLibrary.find(session => session.id === updatedCopy.id).attemptLineageId, draft.attemptLineageId,
    "A conflicting imported lineage cannot reassign a known saved attempt.");
  assert.equal(await evaluate("document.querySelector('.session-load-row select').value"), "", "A normalized newer import must still detach the open stale editor.");
  assert.equal(await evaluate("document.querySelector('#save-analysis textarea').value"), updatedCopy.notes,
    "Importing a newer library must preserve the current unsaved editor.");
  report.checks.push("legacy and conflicting same-ID imports preserve established lineage and keep the open editor detached");
  assert.deepEqual(runtimeErrors, [], "Unexpected browser runtime exceptions.");
  report.checks.push("saved attempts survive reload without runtime exceptions");
  report.status = "passed";
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (chrome.pid) await closeTestBrowser(chrome, sendCommand);
  socket?.close();
  peerSocket?.close();
  // Only remove the isolated temporary directory created by this invocation.
  const resolved = path.resolve(temporaryRoot);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("climbiq-mobile-library-")) {
    throw new Error(`Refusing to remove unexpected test directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
