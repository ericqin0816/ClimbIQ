import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";

const defaultChromePath = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "/usr/bin/google-chrome";
const chromePath = process.env.CLIMBIQ_CHROME ?? defaultChromePath;
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const videoDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const fullWorkflow = process.argv.includes("--full");
const fpsArgument = process.argv.find(value => value.startsWith("--fps="));
const poseFps = fpsArgument ? Number(fpsArgument.slice(6)) : undefined;
if (poseFps !== undefined && ![5, 10, 15].includes(poseFps)) throw new Error("--fps must be 5, 10, or 15.");
const commandLineFiles = process.argv.slice(2).filter((value) => value !== "--full" && !value.startsWith("--fps=")).map((value) => value.trim()).filter(Boolean);
const environmentFiles = process.env.CLIMBIQ_BENCHMARK_FILES?.split(",").map((value) => value.trim()).filter(Boolean);
const requestedFiles = commandLineFiles.length ? commandLineFiles : environmentFiles;
const port = 9334;
const profile = path.join(process.env.TMPDIR ?? process.env.TEMP ?? tmpdir(), `climbiq-timing-${Date.now()}`);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

async function waitForDebugger() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Browser is still starting.
    }
    await delay(100);
  }
  throw new Error("Headless Chrome did not start.");
}

async function openProtocol() {
  await waitForDebugger();
  const targetResponse = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`,
    { method: "PUT" },
  );
  if (!targetResponse.ok) throw new Error(`Could not open ${appUrl}. Start the development server first.`);
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const { send } = createProtocolClient(socket);
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { socket, send, evaluate };
}

async function waitUntil(evaluate, predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evaluate(predicate);
      if (value) return value;
    } catch (error) {
      // Read-only readiness polling can straddle a deliberate page reload.
      // Retry only transient document replacement; never repeat UI mutations.
      if (!/context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(String(error))) throw error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function uploadFile(protocol, filePath) {
  const { send, evaluate } = protocol;
  await waitUntil(
    evaluate,
    `(() => { const input = document.querySelector('.upload-dropzone input[type="file"]'); return Boolean(input && !input.disabled); })()`,
    20000,
    "the previous video task to release the upload input",
  );
  // Resolve the input by reference for DOM.setFileInputFiles.
  const reference = await send("Runtime.evaluate", {
    expression: `document.querySelector('.upload-dropzone input[type="file"]')`,
    returnByValue: false,
  });
  if (!reference.result.objectId) throw new Error("Video upload input could not be addressed.");
  await send("DOM.setFileInputFiles", { files: [filePath], objectId: reference.result.objectId });
  const expectedName = path.basename(filePath);
  await waitUntil(
    evaluate,
    `document.querySelector('.upload-copy strong')?.textContent.trim() === ${JSON.stringify(expectedName)} && (document.querySelector('.video-meta-line')?.textContent.includes('Ready') || Boolean(document.querySelector('.upload-error')))`,
    15000,
    `${expectedName} metadata`,
  );
  const error = await evaluate(`document.querySelector('.upload-error')?.textContent ?? ''`);
  if (error) throw new Error(error);
}

async function runTiming(protocol, fileName) {
  const { evaluate } = protocol;
  await uploadFile(protocol, path.join(videoDirectory, fileName));
  if (poseFps !== undefined) {
    await evaluate(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('5 fps')));
      if (!select) throw new Error('Pose sampling control was not found.');
      select.value = ${JSON.stringify(String(poseFps))};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }
  await evaluate(`([...document.querySelectorAll('button')].find((button) => button.textContent.includes('Run full analysis'))).click()`);
  await waitUntil(
    evaluate,
    `([...document.querySelectorAll('button')].some((button) => button.textContent.includes('Analyzing climb') && button.disabled))`,
    5000,
    `${fileName} analysis start`,
  );
  const started = Date.now();
  let cancelledAfterTiming = false;
  let completed = false;
  while (Date.now() - started < (fullWorkflow ? 300000 : 95000)) {
    const state = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const run = buttons.find((button) => button.textContent.includes('Run full analysis') || button.textContent.includes('Analyzing climb'));
      const cancel = buttons.find((button) => button.textContent.trim() === 'Cancel');
      const reviewStart = buttons.find((button) => button.textContent.includes('Review suggested start'));
      const finishRow = [...document.querySelectorAll('tbody tr')].find((row) => row.firstElementChild?.textContent.trim() === 'Finish Pad');
      const finishAccepted = finishRow && !finishRow.textContent.includes('Not set');
      return {
        done: Boolean(run && !run.disabled && !run.textContent.includes('Analyzing')),
        cancelVisible: Boolean(cancel && !cancel.disabled),
        finishAccepted: Boolean(finishAccepted),
        reviewStart: reviewStart?.textContent.trim() ?? '',
        timingFinished: /Timing finished|Camera looks stable|Registering the 20|Following the climber/.test(document.querySelector('.quick-analysis-box .status-message')?.textContent ?? ''),
      };
    })()`);
    // This runner measures timing only. Once an accepted finish exists, stop
    // the expensive pose stage while preserving accepted marker state.
    if (!fullWorkflow && !cancelledAfterTiming && (state.finishAccepted || state.timingFinished) && state.cancelVisible) {
      await evaluate(`([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Cancel'))?.click()`);
      cancelledAfterTiming = true;
    }
    if (state.done || (state.reviewStart && !state.cancelVisible)) {
      completed = true;
      break;
    }
    await delay(350);
  }
  if (!completed) throw new Error(`${fileName}: analysis did not finish within the workflow timeout.`);

  const outcome = await evaluate(`(() => {
    const marker = (name) => {
      const row = [...document.querySelectorAll('tbody tr')].find((entry) => entry.firstElementChild?.textContent.trim() === name);
      if (!row) return null;
      const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim());
      return { rawTime: cells[1], climbTime: cells[2], source: cells[3], confidence: cells[4] };
    };
    const buttons = [...document.querySelectorAll('button')];
    const reviewStart = buttons.find((button) => button.textContent.includes('Review suggested start'))?.textContent.trim() ?? null;
    const finishSuggestion = [...document.querySelectorAll('.suggestion-card')]
      .find((card) => card.querySelector('h3')?.textContent.trim() === 'Detected lane-light finish');
    const finishStatus = [...document.querySelectorAll('.status-line')]
      .map((line) => line.textContent.trim())
      .find((text) => /finish|upper timing/i.test(text)) ?? '';
    return {
      start: marker('Start Signal'),
      firstMovement: marker('Earliest Visible Motion'),
      finish: marker('Finish Pad'),
      reviewStart,
      finishStatus,
      finishSuggestion: finishSuggestion?.innerText ?? '',
      status: document.querySelector('.quick-analysis-box .status-message')?.textContent.trim() ?? '',
      summary: document.querySelector('.run-summary')?.innerText ?? '',
    };
  })()`);
  const workflow = fullWorkflow ? await verifySavedWorkflow(protocol) : undefined;
  return { fileName, elapsedMs: Date.now() - started, cancelledAfterTiming, ...outcome, workflow };
}

async function verifySavedWorkflow({ evaluate, send }) {
  const secondPass = await evaluate(`(() => {
    const panel = document.querySelector('.hold10-second-pass');
    const marker = [...document.querySelectorAll('tbody tr')].find(r => r.firstElementChild?.textContent.trim() === 'Hold 10');
    const images = [...document.querySelectorAll('.hold10-evidence-frames img')];
    return { available: Boolean(panel), text: panel?.innerText ?? '', previewCount: images.length,
      targetSource: panel?.dataset.targetSource, kind: panel?.dataset.evidenceKind,
      previewsLoaded: images.length > 0 && images.every(i => i.complete && i.naturalWidth > 0),
      acceptedHold10: marker?.querySelectorAll('td')[1]?.textContent.trim() ?? 'Not set' };
  })()`);
  // This runner owns its temporary Chrome profile. Exercise the real save,
  // duplicate and reload controls without touching a user's browser sessions.
  await waitUntil(evaluate, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save Session');
    return Boolean(button && button.getClientRects().length && !button.disabled);
  })()`, 20000, "visible Save Session and released video tasks");
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save Session');
    if (!button || !button.getClientRects().length || button.disabled) throw new Error('Save Session is not visibly available.');
    button.click();
  })()`);
  const saved = await evaluate(`JSON.parse(localStorage.getItem('climbiq.analysisSessions.v1') ?? '[]')[0]`);
  if (!saved) throw new Error("Full workflow failed to save the analysis.");
  const hasFinish = saved.timestamps.some(marker => marker.id === "finishPad" && marker.rawTime !== null);
  const validFrames = saved.biomechanics?.result?.metrics?.validFrames ?? 0;
  if (hasFinish && poseFps !== undefined && saved.biomechanics?.result?.settings?.sampleFps !== poseFps) {
    throw new Error("Full workflow did not use the requested pose sample rate.");
  }
  if (hasFinish && validFrames < 3) throw new Error("Full workflow produced accepted timing but fewer than three usable COM frames.");
  await evaluate(`(() => {
    const details = document.querySelector('.session-details');
    if (details && !details.open) details.querySelector('summary').click();
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Duplicate Session');
    if (!button?.getClientRects().length) throw new Error('Duplicate Session is hidden after opening session management.');
    button.click();
  })()`);
  await evaluate(`window.__climbiqReloadSentinel = true`);
  await send("Page.reload");
  await waitUntil(evaluate, `window.__climbiqReloadSentinel !== true && document.readyState === 'complete' && Boolean(document.querySelector('.comparison-card'))`, 15000, "saved workflow reload");
  if (hasFinish) {
    await waitUntil(evaluate, `Boolean(document.querySelector('.comparison-details'))`, 10000, "reloaded comparison");
    await evaluate(`document.querySelector('.comparison-details').open = true`);
  }
  const restored = await evaluate(`(() => {
    const sessions = JSON.parse(localStorage.getItem('climbiq.analysisSessions.v1') ?? '[]');
    return { sessions, comparison: document.querySelector('.comparison-content')?.innerText ?? '',
      gainLossClaims: document.querySelectorAll('.comparison-row.gained, .comparison-row.lost').length };
  })()`);
  const original = restored.sessions.find(session => session.id === saved.id);
  if (!original || JSON.stringify(original.timestamps) !== JSON.stringify(saved.timestamps)) {
    throw new Error("Full workflow changed accepted timestamps after save/reload.");
  }
  if (hasFinish && (!restored.comparison.includes("Below threshold") || restored.gainLossClaims)) {
    throw new Error("Identical saved attempts did not compare as below threshold after reload.");
  }
  let secondPassRetryPassed;
  let manualReviewWorkflow;
  if (secondPass.available && saved.videoFileName) {
    await uploadFile({ evaluate, send }, path.join(videoDirectory, saved.videoFileName));
    await evaluate(`(() => {
      const select = document.querySelector('.session-load-row select');
      if (!select) throw new Error('Saved-session picker is missing.');
      const details = select.closest('details');
      if (details && !details.open) details.querySelector('summary').click();
      select.value = ${JSON.stringify(saved.id)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const inspectReady = `([...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Inspect Hold 10 more closely' && !b.disabled))`;
    await waitUntil(evaluate, inspectReady, 15000, "restored Hold 10 inspection control");
    const priorTime = await evaluate(`document.querySelector('video').currentTime`);
    await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Inspect Hold 10 more closely')).click()`);
    await waitUntil(evaluate, `([...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel closer scan'))`, 10000, "second-pass cancellation control");
    await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel closer scan')).click()`);
    await waitUntil(evaluate, inspectReady, 15000, "cancelled second pass to release the video");
    const afterCancel = await evaluate(`document.querySelector('video').currentTime`);
    if (Math.abs(afterCancel - priorTime) > 0.01) throw new Error("Second-pass cancellation did not restore the video position.");
    await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Inspect Hold 10 more closely')).click()`);
    await waitUntil(evaluate, `document.querySelectorAll('.hold10-evidence-frames img').length === 3 && ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel closer scan')`, 60000, "second-pass retry evidence");
    const hold10AfterRetry = await evaluate(`([...document.querySelectorAll('tbody tr')].find(r => r.firstElementChild?.textContent.trim() === 'Hold 10'))?.querySelectorAll('td')[1]?.textContent.trim()`);
    if (hold10AfterRetry !== 'Not set') throw new Error("Second-pass retry accepted an unreviewed Hold 10 marker.");
    const retryTargetSource = await evaluate(`document.querySelector('.hold10-second-pass')?.dataset.targetSource`);
    if (secondPass.targetSource === 'visual-alignment' && retryTargetSource !== 'visual-alignment') {
      throw new Error("Second-pass retry lost the registered Hold 10 target after saved-session reload.");
    }
    secondPassRetryPassed = true;
    manualReviewWorkflow = await verifyHold10Review({ evaluate }, saved);
  }
  return { savedAndReloaded: true, identicalComparisonPassed: hasFinish,
    secondPass,
    secondPassRetryPassed,
    manualReviewWorkflow,
    validFrames, requestedFrames: saved.biomechanics?.result?.metrics?.requestedFrames ?? 0,
    sampleFps: saved.biomechanics?.result?.settings?.sampleFps,
    comparison: restored.comparison };
}

async function verifyHold10Review({ evaluate }, saved) {
  const savedLibrary = await evaluate(`localStorage.getItem('climbiq.analysisSessions.v1')`);
  await evaluate(`document.querySelectorAll('.hold10-evidence-frames button')[1].click()`);
  await waitUntil(evaluate, `([...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Set Hold 10 at ') && !b.disabled))`, 10000, "Hold 10 frame acceptance control");
  await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play / pause')).click()`);
  await waitUntil(evaluate, `Boolean(document.querySelector('.timestamp-review-actions button.primary')?.disabled)`, 5000, "review acceptance disabled during playback");
  await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play / pause')).click()`);
  await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Return to suggestion')).click()`);
  await waitUntil(evaluate, `!document.querySelector('video').seeking && [...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Set Hold 10 at ') && !b.disabled)`, 10000, "paused, decoded Hold 10 frame");
  await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Set Hold 10 at '))).click()`);
  await waitUntil(evaluate, `Boolean(document.querySelector('.hold10-phase-grid'))`, 10000, "contact-defined race phases");
  const accepted = await evaluate(`(() => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.firstElementChild?.textContent.trim() === 'Hold 10');
    const cells = [...row.querySelectorAll('td')].map(c => c.textContent.trim());
    return { rawTime: parseFloat(cells[1]), source: cells[3],
      phases: [...document.querySelectorAll('.hold10-phase-grid .metric strong')].map(e => parseFloat(e.textContent)) };
  })()`);
  const start = saved.timestamps.find(m => m.id === 'startSignal').rawTime;
  const finish = saved.timestamps.find(m => m.id === 'finishPad').rawTime;
  if (accepted.source !== 'Manual' || accepted.phases.length !== 2 ||
      Math.abs(accepted.phases[0] - (accepted.rawTime - start)) > 0.001 ||
      Math.abs(accepted.phases[1] - (finish - accepted.rawTime)) > 0.001 ||
      Math.abs(accepted.phases[0] + accepted.phases[1] - (finish - start)) > 0.001) {
    throw new Error('Reviewed Hold 10 did not produce consistent bottom/top race phases.');
  }
  await evaluate(`(() => {
    const details = document.querySelector('.results-details');
    if (!details.open) details.querySelector('summary').click();
    const input = document.querySelector('input[aria-label="Start Signal raw video time"]');
    input.focus(); input.value = ${JSON.stringify(String(start + 0.07))}; input.blur();
  })()`);
  await waitUntil(evaluate, `!document.querySelector('.hold10-second-pass') && !document.querySelector('.hold10-phase-grid')`, 10000, "stale Hold 10 evidence and phases to clear after Start edit");
  const draftCleared = await evaluate(`document.querySelector('input[aria-label="Start Signal raw video time"]').value === ''`);
  if (!draftCleared) throw new Error('The committed marker input retained stale text.');
  if (await evaluate(`localStorage.getItem('climbiq.analysisSessions.v1')`) !== savedLibrary) {
    throw new Error('Unsaved frame review unexpectedly overwrote the saved library.');
  }
  return { passed: true, isGroundTruthLabel: false, acceptedRawTime: accepted.rawTime,
    startToHold10Seconds: accepted.phases[0], hold10ToFinishSeconds: accepted.phases[1], staleEvidenceCleared: true };
}

async function main() {
  const expectations = JSON.parse(await readFile(new URL("../benchmarks/real-video-results.json", import.meta.url), "utf8"));
  const publicResearch = JSON.parse(await readFile(new URL("../benchmarks/public-broadcast-results.json", import.meta.url), "utf8"));
  const privateTrials = expectations.trials ?? [];
  const expectedById = new Map([
    ...privateTrials.map((trial) => [trial.id, { trial, baselineStatus: "compared" }]),
    ...(publicResearch.trials ?? []).map((trial) => [trial.id, { trial, baselineStatus: "research-compared" }]),
  ]);
  const available = (await readdir(videoDirectory))
    .filter((fileName) => /\.(mov|mp4|m4v)$/i.test(fileName))
    .sort();
  // Extra exploratory clips can live beside the private regression set without
  // silently becoming required benchmarks. Explicit file arguments still run
  // them and report their observations as unbaselined.
  const files = requestedFiles?.length ? requestedFiles : privateTrials.map((trial) => trial.id);
  if (!files.length) throw new Error(`No benchmark videos found in ${videoDirectory}.`);
  const missing = files.filter((fileName) => !available.includes(fileName));
  if (missing.length) throw new Error(`Benchmark videos not found: ${missing.join(", ")}`);
  const protocol = await openProtocol();
  try {
    await waitUntil(protocol.evaluate, `document.readyState === 'complete' && Boolean(document.querySelector('.upload-dropzone'))`, 15000, "app load");
    const outcomes = [];
    for (const fileName of files) outcomes.push(await runTiming(protocol, fileName));
    const assertions = outcomes.map((outcome) => {
      const expected = expectedById.get(outcome.fileName);
      return validateOutcome(outcome, expected?.trial, expected?.baselineStatus);
    });
    const failures = assertions.flatMap((assertion) => assertion.errors.map((error) => `${assertion.fileName}: ${error}`));
    console.log(JSON.stringify({ appUrl, videoDirectory, fullWorkflow, passed: failures.length === 0, assertions, outcomes }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    protocol.socket.close();
  }
}

function validateOutcome(outcome, expected, baselineStatus = "unbaselined") {
  const errors = [];
  if (!expected) return { fileName: outcome.fileName, baselineStatus: "unbaselined", errors };
  if (outcome.workflow && Number.isFinite(expected.com?.fullWorkflowMinimumValidCoverage)) {
    const coverage = outcome.workflow.requestedFrames > 0 ? outcome.workflow.validFrames / outcome.workflow.requestedFrames : 0;
    if (coverage < expected.com.fullWorkflowMinimumValidCoverage) {
      errors.push(`Full COM workflow retained ${(coverage * 100).toFixed(1)}% usable frames; expected at least ${(expected.com.fullWorkflowMinimumValidCoverage * 100).toFixed(1)}%.`);
    }
  }
  if (outcome.workflow && expected.hold10?.fullWorkflowRequiresSecondPass) {
    const evidence = outcome.workflow.secondPass;
    if (!evidence?.available || evidence.previewCount !== 3 || !evidence.previewsLoaded) {
      errors.push("Full workflow did not produce three loaded Hold 10 second-pass previews.");
    }
    if (evidence?.acceptedHold10 !== 'Not set') errors.push("Second-pass evidence incorrectly accepted Hold 10 without frame review.");
    if (expected.hold10.fullWorkflowRequiresRegisteredHold && evidence?.targetSource !== 'visual-alignment') {
      errors.push("Full workflow did not recover the visibly registered Hold 10 target.");
    }
  }
  const acceptedStart = parseTime(outcome.start?.rawTime);
  const reviewStart = parseFirstTime(outcome.reviewStart);
  if (expected.start?.status === "accepted") {
    compareTime(errors, "accepted Start", acceptedStart, expected.start.rawTime);
    compareText(errors, "accepted Start source", outcome.start?.source, expected.start.source);
    compareText(errors, "accepted Start confidence", outcome.start?.confidence, expected.start.confidence);
    if (Number.isFinite(expected.start.firstMovementRawTime)) {
      compareTime(errors, "accepted First Movement", parseTime(outcome.firstMovement?.rawTime), expected.start.firstMovementRawTime);
      compareText(errors, "accepted First Movement confidence", outcome.firstMovement?.confidence, expected.start.firstMovementConfidence);
    }
  } else if (expected.start?.status === "review") {
    if (acceptedStart !== null) errors.push(`Start was automatically accepted at ${acceptedStart.toFixed(3)}s but review was expected.`);
    compareTime(errors, "review Start candidate", reviewStart, expected.start.rawTime);
  }

  // Finish is only reachable in this automatic timing run when Start itself is
  // accepted. Reviewed-start continuation is covered manually in the benchmark.
  if (expected.start?.status === "accepted") {
    const acceptedFinish = parseTime(outcome.finish?.rawTime);
    if (expected.finish?.status === "accepted") {
      compareTime(errors, "accepted Finish", acceptedFinish, expected.finish.rawTime);
      compareText(errors, "accepted Finish source", outcome.finish?.source, expected.finish.source);
      compareText(errors, "accepted Finish confidence", outcome.finish?.confidence, expected.finish.confidence);
    } else if (expected.finish?.status === "review") {
      if (acceptedFinish !== null) errors.push(`Finish was automatically accepted at ${acceptedFinish.toFixed(3)}s but review was expected.`);
      compareTime(errors, "review Finish boundary", parseFirstTime(outcome.status.match(/finish[^.]*?(\d+\.\d+)s/i)?.[0]), expected.finish.rawTime);
    } else if (expected.finish?.status === "not-found-after-scene-cut-guard") {
      if (acceptedFinish !== null) errors.push(`Finish was automatically accepted at ${acceptedFinish.toFixed(3)}s after a moving-camera finish should have been rejected.`);
      const reviewBoundary = parseFirstTime(outcome.finishStatus) ??
        parseFirstTime(outcome.status.match(/finish[^.]*?(\d+\.\d+)s/i)?.[0]);
      if (reviewBoundary !== null) errors.push(`Finish supplied a ${reviewBoundary.toFixed(3)}s review boundary after the scene-cut guard should have rejected it.`);
    }
  }
  return { fileName: outcome.fileName, baselineStatus, errors };
}

function parseTime(value) {
  if (typeof value !== "string" || value === "Not set") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFirstTime(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(\d+(?:\.\d+)?)s/);
  return match ? Number(match[1]) : null;
}

function compareTime(errors, label, actual, expected, tolerance = 0.04) {
  if (!Number.isFinite(actual)) {
    errors.push(`${label} was missing; expected ${expected.toFixed(3)}s.`);
  } else if (Math.abs(actual - expected) > tolerance) {
    errors.push(`${label} was ${actual.toFixed(3)}s; expected ${expected.toFixed(3)}s ± ${tolerance.toFixed(3)}s.`);
  }
}

function compareText(errors, label, actual, expected) {
  if (expected === undefined) return;
  if (actual !== expected) errors.push(`${label} was ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
}

try {
  await main();
} finally {
  chrome.kill();
}
