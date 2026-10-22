import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const ffmpeg = process.env.CLIMBIQ_FFMPEG ?? (process.platform === "win32" ? path.resolve("node_modules/.climbiq-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe") : "ffmpeg");
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "climbiq-video-attachment-"));
const fixtures = path.join(temporaryRoot, "fixtures");
const profile = path.join(temporaryRoot, "profile");
const report = { appUrl, synthetic: true, observations: {} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, spawnError, socket, send;

try {
  for (const [folder, color, size, duration] of [["red", "0xCC2222", "160x240", 8], ["blue", "0x2222CC", "160x240", 8], ["green", "0x22CC22", "256x144", 4]]) {
    await mkdir(path.join(fixtures, folder), { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=30:d=${duration}`, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-y", path.join(fixtures, folder, "same-name.mp4")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", chunk => error += chunk);
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(error || `ffmpeg exited ${code}`)));
    });
  }
  await mkdir(path.join(fixtures, "broken"), { recursive: true });
  for (const name of ["broken.mp4", "same-name.mp4"]) await writeFile(path.join(fixtures, "broken", name), "Nonempty, valid extension, but no decodable video.");
  const marker = (id, label, rawTime) => ({ id, label, rawTime, climbTime: rawTime - 1, detectedRawTime: rawTime, offsetApplied: 0, source: "Manual", confidence: "High", acceptanceMode: "frame-review" });
  const saved = {
    id: "synthetic-identity-red", attemptLineageId: "synthetic-identity-red", version: 1, name: "Original red recording", climberName: "Synthetic", date: "2026-09-22", location: "Synthetic fixture", attemptType: "Training", notes: "No real athlete or private footage.", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", videoFileName: "same-name.mp4",
    videoMetadata: { fileName: "same-name.mp4", duration: 8, videoWidth: 160, videoHeight: 240, metadataLoaded: true }, zones: { finishPad: { id: "finishPad", label: "Saved pad area", x1: .45, y1: .03, x2: .6, y2: .12 } }, startLightCalibration: {}, timestamps: [marker("startSignal", "Start Signal", 1), marker("firstMovement", "Earliest Visible Motion", 1.25), marker("finishPad", "Finish Pad", 6.2)],
    settings: { startSearchStart: 0, startSearchEnd: 8, startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto", reactionTimeOffset: .2, startSignalOffset: 0, movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: .1, firstMovementOffset: 0, officialTotalTime: "" },
  };
  const sessionPath = path.join(fixtures, "original.climbiq-session.json");
  await writeFile(sessionPath, JSON.stringify(saved));
  report.sourceHashes = Object.fromEntries(await Promise.all(["red", "blue", "green"].map(async key => [key, createHash("sha256").update(await readFile(path.join(fixtures, key, "same-name.mp4"))).digest("hex")])));
  assert.notEqual(report.sourceHashes.red, report.sourceHashes.blue);

  chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.once("error", error => { spawnError = error; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    try {
      port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
      if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* Own fresh Chrome profile has not published its debugger yet. */ }
    await delay(100);
  }
  if (!port) throw new Error("Fresh Chrome debugger unavailable");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  send = createProtocolClient(socket).send;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  };
  const inputFile = async (selector, file) => {
    const element = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!element.result.objectId) throw new Error(`Missing ${selector}`);
    await send("DOM.setFileInputFiles", { files: [file], objectId: element.result.objectId });
  };
  const choose = (folder, name = "same-name.mp4") => inputFile('input[accept="video/*"]', path.join(fixtures, folder, name));
  const clickChoice = async label => {
    await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "attachment decision");
    await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-video-attachment-choice] button')].find(button=>button.textContent===${JSON.stringify(label)});if(!button)throw new Error('Missing attachment choice');button.click();})()`);
  };
  const waitReady = oldSource => until(`(()=>{const video=document.querySelector('#video-review video');return video?.readyState>=2 && document.querySelector('.video-meta-line')?.textContent.includes('Ready') && !document.querySelector('[data-video-attachment-choice]') ${oldSource ? `&& video.src!==${JSON.stringify(oldSource)}` : ""};})()`, "new visible recording ready");
  const snapshot = () => evaluate(`(async()=>{const v=document.querySelector('#video-review video');let pixel=null;if(v?.readyState>=2){const target=Math.min(1,v.duration/2);if(v.seeking||Math.abs(v.currentTime-target)>.0001)await new Promise((resolve,reject)=>{const done=()=>{if(v.seeking||v.readyState<2)return;cleanup();resolve();};const cleanup=()=>{clearTimeout(timeout);v.removeEventListener('seeked',done);v.removeEventListener('loadeddata',done);};const timeout=setTimeout(()=>{cleanup();reject(new Error('Synthetic frame seek timed out'));},4000);v.addEventListener('seeked',done);v.addEventListener('loadeddata',done);v.currentTime=target;});const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(v,0,0,1,1);pixel=[...x.getImageData(0,0,1,1).data];}return {source:v?.src??null,video:v?{duration:Number.isFinite(v.duration)?v.duration:null,width:v.videoWidth,height:v.videoHeight}:null,pixel,error:document.querySelector('.upload-error')?.textContent??null,activeSession:document.querySelector('.session-load-row select')?.value??null,choice:Boolean(document.querySelector('[data-video-attachment-choice]')),markers:[...document.querySelectorAll('#timing-markers tbody tr')].filter(row=>['Start Signal','Finish Pad'].includes(row.firstElementChild?.textContent.trim())).map(row=>[...row.querySelectorAll('td')].slice(0,5).map(cell=>cell.textContent.trim())),total:document.querySelector('#results .summary-primary-metric strong')?.textContent??null};})()`);
  const assertColor = (state, channel) => assert.ok(state.pixel && state.pixel[channel] > 150 && state.pixel[(channel + 1) % 3] < 70, `Wrong decoded frame: ${JSON.stringify(state)}`);
  const loadSaved = async () => {
    await evaluate("(()=>{const select=document.querySelector('.session-load-row select');select.value='synthetic-identity-red';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await until("document.querySelector('#results .summary-primary-metric strong')?.textContent==='5.200s'", "saved timing restored");
  };
  const enterMarker = async (label, value) => {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(`input[aria-label="${label} raw video time"]`)});for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;input.focus();input.select();})()`);
    await send("Input.insertText", { text: String(value) });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const exportCurrent = async () => {
    await evaluate("window.__attachmentExport=null;[...document.querySelectorAll('#save-analysis button')].find(button=>button.textContent==='Export current session').click()");
    await until("Boolean(window.__attachmentExport)", "current draft export");
    return evaluate("(async()=>JSON.parse(await window.__attachmentExport))()");
  };
  const playerReadiness = () => evaluate("({ready:document.querySelector('.video-meta-line')?.textContent.includes('Ready')??false,runDisabled:[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Run full analysis'))?.disabled??null,error:document.querySelector('.upload-error')?.textContent??null})");

  await until("document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState==='ready'", "saved library ready");
  // Observe public Blob URL ownership and exported data without inspecting React state.
  await evaluate(`(()=>{const create=URL.createObjectURL,revoke=URL.revokeObjectURL;window.__attachmentUrls=[];
    URL.createObjectURL=function(blob){const url=create.call(this,blob);window.__attachmentUrls.push({url,revoked:false,type:blob.type});if(blob.type==='application/json')window.__attachmentExport=blob.text();return url;};
    URL.revokeObjectURL=function(url){const entry=window.__attachmentUrls.find(entry=>entry.url===url);if(entry)entry.revoked=true;return revoke.call(this,url);};})()`);
  await choose("red");
  await waitReady();
  const ordinaryUpload = await snapshot();
  assertColor(ordinaryUpload, 0);
  assert.equal(ordinaryUpload.choice, false, "An ordinary new recording should not ask about a saved attempt");
  await enterMarker("Start Signal", 1);
  await enterMarker("Finish Pad", 6.2);
  await until("document.querySelector('#results .summary-primary-metric strong')?.textContent==='5.200s'", "known unsaved run markers");
  const unsavedBefore = await exportCurrent();
  assert.ok(!(await snapshot()).activeSession);
  await choose("red");
  await clickChoice("Attach to this attempt");
  await waitReady(ordinaryUpload.source);
  const unsavedAfter = await exportCurrent();
  assert.equal(unsavedAfter.attemptLineageId, unsavedBefore.attemptLineageId, "Reattaching an unsaved measured run must retain its lineage");
  assert.deepEqual(unsavedAfter.timestamps, unsavedBefore.timestamps, "Reattaching an unsaved measured run must retain its accepted markers");
  report.observations.unsavedRunReattachment = { activeSession: (await snapshot()).activeSession, lineageRetained: true, total: (await snapshot()).total };
  await inputFile('#saved-attempts input[type="file"]', sessionPath);
  await clickChoice("Attach to this attempt");
  await waitReady();
  const original = report.observations.confirmedOriginal = await snapshot();
  assert.equal(original.total, "5.200s");
  assertColor(original, 0);
  await loadSaved();
  assert.equal((await snapshot()).choice, false, "A confirmed same-recording lineage should re-open without another question");

  await choose("blue");
  await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "same-metadata replacement must be reviewed");
  const pending = report.observations.pendingDifferentPixels = await snapshot();
  assert.equal(pending.source, original.source, "Candidate must not replace the confirmed recording before a decision");
  assertColor(pending, 0);
  await until("document.querySelector('[data-video-attachment-choice] img')?.complete", "candidate preview decoded");
  pending.previewPixel = await evaluate("(()=>{const image=document.querySelector('[data-video-attachment-choice] img');const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);return [...context.getImageData(0,0,1,1).data];})()");
  assertColor({ pixel: pending.previewPixel }, 2);
  const pendingUrl = await evaluate("window.__attachmentUrls.at(-1).url");
  await clickChoice("Cancel");
  assert.equal((await snapshot()).source, original.source);
  assert.equal(await evaluate(`window.__attachmentUrls.find(entry=>entry.url===${JSON.stringify(pendingUrl)}).revoked`), true, "Cancelling the attachment choice must release its prepared URL");
  assert.equal(await evaluate(`window.__attachmentUrls.find(entry=>entry.url===${JSON.stringify(original.source)}).revoked`), false, "Cancelling must retain the confirmed player's URL");
  await choose("blue");
  await clickChoice("Analyze as a new attempt");
  await waitReady(original.source);
  const newAttempt = report.observations.newRecording = await snapshot();
  assertColor(newAttempt, 2);
  assert.ok(!newAttempt.activeSession, "New recording must detach the saved ID");
  assert.ok(newAttempt.markers.every(row => row.includes("Not set")), "New recording must not inherit accepted markers");
  assert.notEqual(newAttempt.total, "5.200s");

  await loadSaved();
  await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "loading a saved attempt over an unrelated matching recording");
  const unknownAttachment = report.observations.savedOverDifferentRecording = await snapshot();
  assert.notEqual(unknownAttachment.source, newAttempt.source, "Unconfirmed current recording must detach from saved marker playback");
  await until("[...document.querySelectorAll('#coaching-review button')].some(button=>button.textContent==='Review my run')", "review UI ready");
  unknownAttachment.reviewDisabled = await evaluate("[...document.querySelectorAll('#coaching-review button')].find(button=>button.textContent==='Review my run').disabled");
  unknownAttachment.seekButtons = await evaluate("[...document.querySelectorAll('.coaching-result button')].filter(button=>button.textContent.startsWith('View ')).map(button=>({text:button.textContent,enabled:!button.disabled}))");
  assert.equal(unknownAttachment.reviewDisabled, true, "Resolve the pending attachment before reviewing");
  assert.ok(unknownAttachment.seekButtons.every(button => !button.enabled), "Unconfirmed recording must not enable saved-marker seek links");
  await clickChoice("Cancel");
  await evaluate("[...document.querySelectorAll('#save-analysis button')].find(button=>button.textContent==='Delete Session').click()");
  await until("document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState==='ready'&&!document.querySelector('.session-load-row select')?.value", "saved-only draft detached from deleted library entry");
  const detachedBefore = await exportCurrent();
  const detachedState = await snapshot();
  assert.equal(detachedState.source, null);
  assert.ok(!detachedState.activeSession);
  assert.equal(detachedBefore.attemptLineageId, saved.attemptLineageId);
  // The detached preparer decodes through the native src property. Hold only
  // React's adopted player's src attribute to reproduce a slow visible decoder.
  await evaluate(`(()=>{const create=document.createElement;window.__attachmentBeforeVisibleHold=create;document.createElement=function(tag,...args){const element=create.call(this,tag,...args);if(tag==='video'){const set=element.setAttribute;element.setAttribute=function(name,value){if(name==='src'){window.__attachmentHeldVisible={element,value,set};return;}return set.call(this,name,value);};}return element;};})()`);
  await choose("red");
  await clickChoice("Attach to this attempt");
  await until("Boolean(window.__attachmentHeldVisible)&&Boolean(document.querySelector('#video-review video'))", "adopted visible decoder held");
  const delayedReadiness = report.observations.delayedVisibleDecoder = {
    beforeDecode: await playerReadiness(),
    reviewDisabledBeforeDecode: await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Review finish / mark pad')?.disabled"),
  };
  assert.equal(delayedReadiness.beforeDecode.ready, false, "Prepared metadata must not certify the adopted player before it decodes");
  assert.equal(delayedReadiness.reviewDisabledBeforeDecode, true, "Finish review must not seek an unready player with an unknown duration");
  await evaluate("document.createElement=window.__attachmentBeforeVisibleHold;delete window.__attachmentBeforeVisibleHold;const held=window.__attachmentHeldVisible;held.element.setAttribute=held.set;held.set.call(held.element,'src',held.value);window.__attachmentHeldVisible=null;");
  await waitReady();
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Review finish / mark pad').click()");
  await until("[...document.querySelectorAll('button')].some(button=>button.textContent==='Rescan near current frame'&&!button.disabled)", "restored marked pad ready after visible decoding");
  delayedReadiness.afterDecode = await evaluate("({currentTime:document.querySelector('video').currentTime,readyState:document.querySelector('video').readyState,rescanEnabled:[...document.querySelectorAll('button')].some(button=>button.textContent==='Rescan near current frame'&&!button.disabled)})");
  assert.equal(delayedReadiness.afterDecode.currentTime, 6.2, "Review must seek the saved finish after the visible decoder is ready");
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Close review').click()");
  const detachedAfter = await exportCurrent();
  assert.equal(detachedAfter.attemptLineageId, detachedBefore.attemptLineageId, "Attaching a saved-only detached draft must retain its lineage");
  assert.deepEqual(detachedAfter.timestamps, detachedBefore.timestamps);
  report.observations.detachedSavedDraftReattachment = { lineageRetained: true, total: (await snapshot()).total };
  await enterMarker("Finish Pad", 6.5);
  await until("document.querySelector('#results .summary-primary-metric strong')?.textContent==='5.500s'", "unsaved timing edit");
  const beforeCorrupt = report.observations.beforeCorruptReplacement = await snapshot();
  for (const name of ["broken.mp4", "same-name.mp4"]) {
    await choose("broken", name);
    await until("Boolean(document.querySelector('.upload-error')?.textContent)", "decode failure");
    const failed = report.observations[`corrupt-${name}`] = await snapshot();
    assert.equal(failed.source, beforeCorrupt.source, "A damaged replacement must not revoke the open recording");
    assert.equal(failed.total, "5.500s", "A damaged replacement must retain the unsaved edit");
    assert.deepEqual(failed.markers, beforeCorrupt.markers);
    assert.equal(failed.activeSession, beforeCorrupt.activeSession);
    assertColor(failed, 0);
  }

  // Hold only the detached candidate before native decoding, then simulate late events
  // after cancellation and a successful replacement. The mounted player is untouched.
  await evaluate(`(()=>{const create=document.createElement;window.__attachmentOriginalCreate=create;document.createElement=function(tag,...args){const element=create.call(this,tag,...args);if(tag==='video'){let source='';Object.defineProperty(element,'src',{get:()=>source,set:value=>{source=value;}});const remove=element.removeAttribute;element.removeAttribute=function(name){if(name==='src')source='';return remove.call(this,name);};element.load=()=>{};window.__attachmentStalledDecoder=element;}return element;};})()`);
  await choose("blue");
  await until("[...document.querySelectorAll('button')].some(button=>button.textContent==='Cancel opening video')", "preflight cancellation control");
  const stalledUrl = await evaluate("window.__attachmentUrls.at(-1).url");
  await evaluate("document.createElement=window.__attachmentOriginalCreate;delete window.__attachmentOriginalCreate;[...document.querySelectorAll('button')].find(button=>button.textContent==='Cancel opening video').click()");
  await until("![...document.querySelectorAll('button')].some(button=>button.textContent==='Cancel opening video')", "candidate cancelled");
  const cancelled = report.observations.cancelledPreparation = await snapshot();
  assert.equal(cancelled.source, beforeCorrupt.source);
  assert.equal(cancelled.total, "5.500s");
  assert.equal(await evaluate(`window.__attachmentUrls.find(entry=>entry.url===${JSON.stringify(stalledUrl)}).revoked`), true, "Cancelled decoder candidate must release its URL");
  await evaluate("window.__attachmentOldPlayer=document.querySelector('#video-review video');void 0");

  await choose("green");
  await waitReady(beforeCorrupt.source);
  const differentShape = report.observations.afterFailureDifferentDimensions = await snapshot();
  assertColor(differentShape, 1);
  assert.equal(differentShape.video.width, 256);
  assert.equal(differentShape.video.duration, 4);
  assert.ok(differentShape.markers.every(row => row.includes("Not set")), "A failed earlier selection must not wildcard saved dimensions or duration");
  assert.ok(!differentShape.activeSession);
  await evaluate("Object.defineProperties(window.__attachmentStalledDecoder,{readyState:{value:2},duration:{value:8},videoWidth:{value:160},videoHeight:{value:240}});for(const type of ['loadedmetadata','loadeddata','error'])window.__attachmentStalledDecoder.dispatchEvent(new Event(type))");
  await delay(50);
  const afterLateEvents = await snapshot();
  assert.equal(afterLateEvents.source, differentShape.source, "Late cancelled decode completion must never adopt the abandoned candidate");
  assert.deepEqual(afterLateEvents.markers, differentShape.markers);
  assert.equal(afterLateEvents.error, null, "Late errors from cancelled candidates must not poison the new recording");
  report.observations.cancelledCandidateCleanup = { preparedChoiceUrlRevoked: true, cancelledDecoderUrlRevoked: true, lateCompletionIgnored: true };
  await evaluate("window.__attachmentOldPlayer.dispatchEvent(new Event('error'))");
  await delay(50);
  const afterStaleError = report.observations.staleVisibleDecoderError = await playerReadiness();
  assert.equal(afterStaleError.ready, true);
  assert.equal(afterStaleError.runDisabled, false, "An error from an old player node must not disable the new recording");
  assert.equal(afterStaleError.error, null);
  await evaluate("document.querySelector('#video-review video').dispatchEvent(new Event('error'))");
  await until("Boolean(document.querySelector('.upload-error')?.textContent)", "active player decoder failure");
  const afterActiveError = report.observations.activeVisibleDecoderError = await playerReadiness();
  assert.equal(afterActiveError.ready, false, "A player error after readiness must invalidate Ready");
  assert.notEqual(afterActiveError.runDisabled, false, "A failed active decoder must hide or disable full analysis");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (chrome) await closeTestBrowser(chrome, send);
  socket?.close();
  chrome?.kill();
  const resolved = path.resolve(temporaryRoot), relative = path.relative(path.resolve(tmpdir()), resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(resolved).startsWith("climbiq-video-attachment-")) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/video-attachment.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
