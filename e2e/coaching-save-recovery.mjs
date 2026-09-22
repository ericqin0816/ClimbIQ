// Real App save/import/conflict workflow; all hosted coaching responses are mocked.
// Synthetic session JSON only. No video, model, paid provider, or user browser data.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProtocolClient } from "./cdp-client.mjs";
import { startTestBrowser } from "./test-browser.mjs";
import { readSessionLibraryJson, saveCurrentSession, waitForSessionLibraryChange } from "./session-library.mjs";

const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const reportPath = path.resolve(process.argv.find(value => value.startsWith("--report="))?.slice(9) ?? "test-results/coaching-save-recovery.json");
const report = { appUrl, passed: false, synthetic: true, provider: "Mocked; no live provider calls", checks: [], requests: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
let main;
const sockets = [];

function session(id, name, finishTime) {
  const marker = (markerId, label, rawTime) => ({ id: markerId, label, rawTime, climbTime: rawTime - 1,
    detectedRawTime: rawTime, offsetApplied: 0, source: "Manual", confidence: "High", acceptanceMode: "frame-review", observationIntervalSeconds: 1 / 30 });
  return { id, attemptLineageId: id, version: 1, name, climberName: "Synthetic athlete", date: "2026-09-22",
    location: "Synthetic fixture", attemptType: "Training", notes: "No real recording or athlete.",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", videoFileName: `${id}.mp4`,
    videoMetadata: { fileName: `${id}.mp4`, duration: 10, videoWidth: 320, videoHeight: 480, metadataLoaded: false },
    zones: {}, startLightCalibration: {},
    timestamps: [marker("startSignal", "Start Signal", 1), marker("firstMovement", "Earliest Visible Motion", 1.25), marker("finishPad", "Finish Pad", finishTime)],
    settings: { startSearchStart: 0, startSearchEnd: 10, startSensitivity: "medium", startLightVisibility: "clear", startDetectionProfile: "auto",
      reactionTimeOffset: .2, startSignalOffset: 0, movementSensitivity: "medium", firstMovementDefinition: "earliest",
      committedLaunchMinDelay: .1, firstMovementOffset: 0, officialTotalTime: "" } };
}

const current = session("coaching-current", "Current fixture", 6.2);
const baseline = session("coaching-baseline", "Baseline fixture", 6.8);
const unrelated = session("coaching-unrelated", "Unrelated fixture", 6.5);
const backup = sessions => ({ format: "climbiq-session-library", version: 1, exportedAt: "2099-01-01T00:00:00.000Z", sessions });

async function wait(evaluate, expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function openPage() {
  const targetResponse = await fetch(`http://127.0.0.1:${browser.port}/json/new?about%3Ablank`, { method: "PUT" });
  assert(targetResponse.ok, "Could not create an owned browser page.");
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const { send } = createProtocolClient(socket);
  const exceptions = [];
  const hostedNetworkRequests = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Network.requestWillBeSent" && new URL(message.params.request.url).pathname === "/api/coaching")
      hostedNetworkRequests.push(message.params.request.url);
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const realFetch = window.fetch;
    window.__coachingCalls = []; window.__coachingSignals = []; window.__releaseCoaching = [];
    window.fetch = (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (requestUrl.pathname !== '/api/coaching') {
        if (requestUrl.origin !== location.origin) throw new Error('Unexpected external fetch in local-only test: ' + requestUrl.origin);
        return realFetch(input, init);
      }
      if (requestUrl.searchParams.get('status') === '1') return Promise.resolve(Response.json({enabled: true}));
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body); window.__coachingCalls.push(body); window.__coachingSignals.push(init.signal);
        // Deliberately ignore abort so late responses exercise the ownership guard.
        return new Promise(resolve => window.__releaseCoaching.push(async () => {
          const {buildCoachingCatalog} = await import('/src/lib/coachingPolicy.ts');
          resolve(Response.json({id:'abcdefghijklmnopqrstu', status:'complete', packet:body.packet, plan:buildCoachingCatalog(body.packet).defaultPlan}));
        }));
      }
      return Promise.resolve(Response.json({error:'No archived fixture requested.'}, {status:404}));
    };
  })();` });
  await send("Page.navigate", { url: appUrl });
  await wait(evaluate, "document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'", "application and saved library hydration");
  assert(await evaluate("[...document.scripts].some(script=>script.src.includes('@vite/client'))"), "This component-instrumented regression requires the local Vite development server.");
  return { send, evaluate, exceptions, hostedNetworkRequests };
}

async function click(protocol, text) {
  await protocol.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(text)});
    for (let element = button.parentElement; element; element = element.parentElement) if (element.tagName === 'DETAILS') element.open = true;
    button.click();
  })()`);
}

async function importFixture(protocol, value, name) {
  const fixturePath = path.join(browser.temporaryRoot, `${name}.json`);
  await writeFile(fixturePath, JSON.stringify(value));
  const before = await readSessionLibraryJson(protocol.evaluate);
  const reference = await protocol.send("Runtime.evaluate", { expression: "document.querySelector('#saved-attempts input[type=file]')" });
  assert(reference.result.objectId, "The session import input is missing.");
  assert(await protocol.evaluate("!document.querySelector('#saved-attempts input[type=file]').disabled"), "Import must be available while hosted review waits.");
  await protocol.send("DOM.setFileInputFiles", { objectId: reference.result.objectId, files: [fixturePath] });
  await waitForSessionLibraryChange(protocol.evaluate, before);
}

async function localReview(protocol, baselineId = "") {
  await wait(protocol.evaluate, "!!document.querySelector('.coaching-hosted input[type=password]')", "mocked hosted capability");
  await protocol.evaluate(`(() => {
    const select = document.querySelectorAll('.coaching-controls select')[1];
    select.value = ${JSON.stringify(baselineId)}; select.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  if (baselineId) {
    await wait(protocol.evaluate, "!!document.querySelector('.coaching-panel > label.coaching-check input')", "baseline comparison confirmation");
    await protocol.evaluate("(() => { const input=document.querySelector('.coaching-panel > label.coaching-check input'); if (!input.checked) input.click(); })()");
  }
  await click(protocol, "Review my run");
  await wait(protocol.evaluate, "!!document.querySelector('.coaching-result')", "local evidence review");
  await protocol.evaluate(`(() => {
    document.querySelector('.coaching-hosted').open = true;
    const input = document.querySelector('.coaching-hosted input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'mock-workspace-code');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    const consent = document.querySelector('.coaching-hosted input[type=checkbox]'); if (!consent.checked) consent.click();
  })()`);
}

async function startHosted(protocol) {
  const count = await protocol.evaluate("window.__coachingCalls.length");
  await click(protocol, "Prioritize with NIM");
  await wait(protocol.evaluate, `window.__coachingCalls.length === ${count + 1} && document.body.innerText.includes('Stop waiting')`, "pending hosted request");
  return count;
}

async function assertPending(protocol, index, label) {
  const state = await protocol.evaluate(`({aborted:window.__coachingSignals[${index}].aborted,
    evidence:!!document.querySelector('.coaching-result'), stop:document.body.innerText.includes('Stop waiting'),
    requestCount:window.__coachingCalls.length, mode:document.querySelector('.coaching-mode')?.textContent})`);
  assert.equal(state.aborted, false, `${label}: the owned request was aborted.`);
  assert.equal(state.evidence, true, `${label}: local evidence was lost.`);
  assert.equal(state.stop, true, `${label}: pending-request control was lost.`);
  assert.equal(state.requestCount, index + 1, `${label}: an extra hosted request started without an explicit retry.`);
  assert.match(state.mode, /Local evidence review/, `${label}: an old response replaced the local review.`);
}

async function release(protocol, index) {
  await protocol.evaluate(`window.__releaseCoaching[${index}]()`);
  await delay(80);
}

try {
  browser = await startTestBrowser({ label: "coaching-save-recovery" });
  main = await openPage();
  await importFixture(main, current, "current");
  await importFixture(main, backup([baseline, unrelated]), "baselines");
  await localReview(main);
  const first = await startHosted(main);
  await saveCurrentSession(main.evaluate);
  await assertPending(main, first, "Save Session during hosted review");
  report.checks.push("saving unchanged current evidence preserves local review and its pending request");

  await click(main, "Stop waiting");
  const retry = await startHosted(main);
  const retryIdentity = await main.evaluate(`({before:window.__coachingCalls[${first}].requestId,after:window.__coachingCalls[${retry}].requestId,
    samePacket:JSON.stringify(window.__coachingCalls[${first}].packet)===JSON.stringify(window.__coachingCalls[${retry}].packet)})`);
  assert.equal(retryIdentity.after, retryIdentity.before, "Saving/retrying changed the generation idempotency key.");
  assert.equal(retryIdentity.samePacket, true, "Saving changed the numeric evidence packet.");
  await release(main, first);
  await assertPending(main, retry, "Old response after save/stop/retry");
  await release(main, retry);
  await wait(main.evaluate, "document.body.innerText.includes('AI-prioritized review')", "replacement request completion");
  report.checks.push("save then stop/retry keeps the same request ID; the aborted response cannot replace the retry");

  await localReview(main, baseline.id);
  const comparison = await startHosted(main);
  await importFixture(main, backup([{ ...unrelated, notes: "Unrelated edit", updatedAt: "2099-01-01T00:00:00.000Z" }]), "unrelated-update");
  await assertPending(main, comparison, "Unrelated library import");
  report.checks.push("unrelated library changes preserve the selected baseline review and pending request");

  const editedBaseline = { ...baseline, updatedAt: "2099-01-02T00:00:00.000Z", timestamps: baseline.timestamps.map(marker => marker.id === "finishPad"
    ? { ...marker, rawTime: 7.2, climbTime: 6.2, detectedRawTime: 7.2 } : marker) };
  await importFixture(main, backup([editedBaseline]), "selected-baseline-update");
  await wait(main.evaluate, `window.__coachingSignals[${comparison}].aborted && !document.querySelector('.coaching-result')`, "changed baseline to invalidate its review");
  assert.match(await main.evaluate("document.querySelector('.coaching-panel > [role=status]').textContent"), /attempt or baseline changed/i);
  await release(main, comparison);
  assert.equal(await main.evaluate("!!document.querySelector('.coaching-result')"), false, "A late response restored the edited baseline's old evidence.");
  report.checks.push("selected baseline edits invalidate its evidence and reject the late response");

  await localReview(main, baseline.id);
  const deletedBaselineRequest = await startHosted(main);
  assert.notEqual(await main.evaluate(`window.__coachingCalls[${comparison}].requestId`), await main.evaluate(`window.__coachingCalls[${deletedBaselineRequest}].requestId`),
    "Reviewing changed baseline evidence must start a new logical request.");
  const peer = await openPage();
  await peer.evaluate(`(() => {
    const button=[...document.querySelectorAll('.attempt-library-row')].find(button=>button.querySelector('strong')?.textContent===${JSON.stringify(baseline.name)});
    if(!button)throw new Error('Baseline fixture is missing in the second tab');button.click();
  })()`);
  await wait(peer.evaluate, `document.querySelector('.session-load-row select')?.value===${JSON.stringify(baseline.id)}`, "second tab opens baseline");
  const beforeDelete = await readSessionLibraryJson(peer.evaluate);
  await click(peer, "Delete Session");
  const deleted = JSON.parse(await waitForSessionLibraryChange(peer.evaluate, beforeDelete));
  assert(!deleted.some(item => item.id === baseline.id), "The second tab did not delete the selected baseline.");
  await click(main, "Save Session");
  await wait(main.evaluate, "!!document.querySelector('#saved-attempts [role=alert]')", "first tab detects the concurrent deletion");
  await click(main, "Reload latest saved attempts");
  await wait(main.evaluate, `document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState==='ready'
    && window.__coachingSignals[${deletedBaselineRequest}].aborted && !document.querySelector('.coaching-result')`, "reloaded deletion to invalidate pending evidence");
  await release(main, deletedBaselineRequest);
  assert.equal(await main.evaluate("!!document.querySelector('.coaching-result')"), false, "A deleted baseline's late response restored old evidence.");
  assert.equal(await main.evaluate(`!![...document.querySelectorAll('.coaching-controls select option')].find(option=>option.value===${JSON.stringify(baseline.id)})`), false, "Deleted baseline remains selectable.");
  report.checks.push("second-tab baseline deletion plus conflict/reload detaches the draft, invalidates evidence, and rejects the late response");

  assert.equal(await main.evaluate("document.querySelector('.session-load-row select').value"), "", "Conflict/reload must leave a detached draft for the first-save check.");
  await main.evaluate(`(() => {
    const input=[...document.querySelectorAll('#save-analysis label')].find(label=>label.textContent.trim()==='Session name')?.querySelector('input');
    if (!input) throw new Error('Session name input is missing.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'   ');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await localReview(main);
  const draftRequest = await startHosted(main);
  const beforeDraftSave = JSON.parse(await readSessionLibraryJson(main.evaluate));
  const afterDraftSave = JSON.parse(await saveCurrentSession(main.evaluate));
  assert.equal(afterDraftSave.length, beforeDraftSave.length + 1, "The first draft save must create a separate saved attempt.");
  const newDraft = afterDraftSave.find(item => !beforeDraftSave.some(previous => previous.id === item.id));
  assert.equal(newDraft?.attemptLineageId, current.attemptLineageId, "Saving a detached draft must retain its original lineage.");
  assert(newDraft?.name.trim(), "An empty draft name must receive the normal display-name fallback.");
  await assertPending(main, draftRequest, "First save of an unnamed detached draft");
  await click(main, "Stop waiting");
  const draftRetry = await startHosted(main);
  assert.equal(await main.evaluate(`window.__coachingCalls[${draftRequest}].requestId`), await main.evaluate(`window.__coachingCalls[${draftRetry}].requestId`),
    "Normalizing the draft name and assigning its saved ID changed the retry key.");
  await release(main, draftRequest);
  await assertPending(main, draftRetry, "Late response after first draft save");
  await release(main, draftRetry);
  await wait(main.evaluate, "document.body.innerText.includes('AI-prioritized review')", "first-saved draft retry completion");
  report.checks.push("first save of an unnamed detached draft preserves the request controller and retry key while normalizing its display name");
  assert.deepEqual(main.exceptions, [], "Unexpected main-page exception.");
  assert.deepEqual(peer.exceptions, [], "Unexpected second-page exception.");
  assert.deepEqual(main.hostedNetworkRequests, [], "A hosted coaching request escaped the local mock.");
  assert.deepEqual(peer.hostedNetworkRequests, [], "The second tab made a real hosted coaching request.");
  report.requests = await main.evaluate("window.__coachingCalls.map(({requestId,packet})=>({requestId,packetVersion:packet.version,hasBaseline:!!packet.baseline}))");
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(main?.send); }
  catch (error) { report.errors.push(`Cleanup: ${error}`); report.passed = false; process.exitCode = 1; }
  for (const socket of sockets) socket.close();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
