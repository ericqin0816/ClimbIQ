/**
 * Exercise biomechanics control ownership with synthetic solid-color videos and
 * a manually populated workflow fixture. No private recordings or accuracy
 * labels are used. After blocked-control checks, real blank-video inference
 * verifies manual COM cancellation and publication of an 11-frame result.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startTestBrowser } from "./test-browser.mjs";
import { createProtocolClient } from "./cdp-client.mjs";

const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const output = process.argv.find(arg => arg.startsWith("--report="))?.slice(9)
  ?? "test-results/biomechanics-ownership.json";
const ffmpeg = process.env.CLIMBIQ_FFMPEG ?? (process.platform === "win32"
  ? path.resolve("node_modules/.climbiq-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe")
  : "ffmpeg");
const report = {
  url,
  startedAt: new Date().toISOString(),
  syntheticOnly: true,
  modelInference: false,
  observations: [],
  errors: [],
};
let browser, socket, send;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  browser = await startTestBrowser({ label: "biomechanics-ownership" });
  for (const [name, color] of [["red", "red"], ["blue", "blue"]]) {
    const directory = path.join(browser.temporaryRoot, name);
    await mkdir(directory);
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", `color=c=${color}:s=160x240:r=30:d=4`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", path.join(directory, "sample.mp4"),
      ], { windowsHide: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(Error("Synthetic encode failed.")));
    });
  }

  const marker = (id, rawTime) => ({
    id,
    label: id === "startSignal" ? "Start Signal" : "Finish Pad",
    rawTime,
    climbTime: rawTime - 1,
    source: "Manual",
    confidence: "Medium",
    acceptanceMode: "manual-entry",
  });
  const saved = {
    id: "ownership-fixture",
    attemptLineageId: "ownership-fixture",
    version: 1,
    name: "Synthetic ownership fixture",
    createdAt: "2026-09-22T00:00:00Z",
    updatedAt: "2026-09-22T00:00:00Z",
    date: "2026-09-22",
    notes: "Workflow only; no athlete or timing labels.",
    videoFileName: "sample.mp4",
    videoMetadata: {
      fileName: "sample.mp4", duration: 4, videoWidth: 160, videoHeight: 240, metadataLoaded: true,
    },
    zones: {},
    startLightCalibration: {},
    timestamps: [marker("startSignal", 1), marker("finishPad", 3)],
    settings: { startSearchStart: 0, startSearchEnd: 4 },
    biomechanics: {
      settings: {
        sampleFps: 5,
        minVisibility: .25,
        minMassCoverage: .75,
        smoothingWindowSeconds: .2,
        anthropometricModel: "athletevision-published-male-reference",
      },
      calibration: {
        version: 1,
        frameRawTime: 0,
        widthMeters: 3,
        heightMeters: 15,
        staticCameraConfirmed: true,
        source: "manual",
        confidence: "High",
        corners: [
          ["bottomLeft", .1, .9, 0, 0],
          ["bottomRight", .9, .9, 3, 0],
          ["topRight", .9, .1, 3, 15],
          ["topLeft", .1, .1, 0, 15],
        ].map(([id, x, y, xMeters, yMeters]) => ({
          id, label: id, image: { x, y }, wall: { xMeters, yMeters },
        })),
      },
    },
  };
  const sessionFile = path.join(browser.temporaryRoot, "session.json");
  await writeFile(sessionFile, JSON.stringify(saved));

  const target = await (await fetch(
    `http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  )).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  ({ send } = createProtocolClient(socket));
  await send("Runtime.enable");
  await send("Network.enable");
  const modelRequests = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent" &&
        /models\/|vision_wasm|\.task|poseInference.*worker/.test(message.params.request.url)) {
      modelRequests.push(message.params.request.url);
    }
  });

  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw Error("Timeout " + label);
  };
  const file = async (selector, filePath) => {
    const input = await send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    await send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [filePath] });
  };
  const click = async text => evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw Error('Control unavailable: ' + ${JSON.stringify(text)});
    button.click();
  })()`);
  const state = () => evaluate(`(() => {
    const panel = document.querySelector('.biomechanics-panel');
    const button = [...panel.querySelectorAll('button')]
      .find(button => /Analyze center of mass|Analyze selected range/.test(button.textContent));
    const label = [...panel.querySelectorAll('label')]
      .find(label => label.textContent.includes('Minimum landmark visibility'));
    return {
      comDisabled: button?.disabled,
      visibilityDisabled: label?.querySelector('select')?.disabled,
      visibility: Number(label?.querySelector('select')?.value),
      choice: Boolean(document.querySelector('[data-video-attachment-choice]')),
      opening: [...document.querySelectorAll('button')]
        .some(button => button.textContent.trim() === 'Cancel opening video'),
      fullDisabled: document.querySelector('#upload .analyze-button')?.disabled
    };
  })()`);
  const setVisibility = value => evaluate(`(() => {
    const label = [...document.querySelectorAll('.biomechanics-panel label')]
      .find(label => label.textContent.includes('Minimum landmark visibility'));
    const select = label.querySelector('select');
    select.value = ${JSON.stringify(String(value))};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const exportDataset = () => evaluate(`(() => {
    const original = navigator.clipboard.writeText;
    let value;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: async text => { value = text; }
    });
    try {
      [...document.querySelectorAll('button')]
        .find(button => button.textContent.trim() === 'Copy JSON').click();
      return JSON.parse(value);
    } finally {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: original });
    }
  })()`);
  const exportedVisibility = async () => (await exportDataset()).biomechanics.settings.minVisibility;

  await until("document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'", "library");
  await file(".upload-dropzone input[type=file]", path.join(browser.temporaryRoot, "red/sample.mp4"));
  await until("Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))", "red ready");
  await file("#saved-attempts input[type=file]", sessionFile);
  await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "attach saved fixture");
  await click("Attach to this attempt");
  await until(`Boolean(document.querySelector('#upload .analyze-button:not(:disabled)')) &&
    Boolean(document.querySelector('.biomechanics-panel'))`, "calibrated fixture");
  await evaluate("for (const details of document.querySelectorAll('#center-of-mass details')) details.open = true");

  const initial = await state();
  assert.equal(initial.comDisabled, false);
  await setVisibility(.35);
  assert.equal(await exportedVisibility(), .35);
  report.unblockedSettingsWork = true;
  await evaluate(`for (let parent = document.querySelector('#center-of-mass'); parent; parent = parent.parentElement)
    if (parent.tagName === 'DETAILS') parent.open = true`);
  await click("Edit calibration");
  await click("Capture current full-wall frame");
  await until("Boolean(document.querySelector('.wall-calibration-stage img')?.naturalWidth)", "calibration image");

  const point = (x, y) => evaluate(`(() => {
    const overlay = document.querySelector('.wall-calibration-overlay');
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) throw Error('Calibration image has no area');
    overlay.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: rect.left + rect.width * ${x}, clientY: rect.top + rect.height * ${y}
    }));
  })()`);
  const draft = () => evaluate(`
    [...document.querySelectorAll('.wall-corner-marker')]
      .map(marker => ({ left: marker.style.left, top: marker.style.top }))
  `);
  await point(.1, .9);
  assert.equal((await draft()).length, 1);

  await file(".upload-dropzone input[type=file]", path.join(browser.temporaryRoot, "blue/sample.mp4"));
  await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "pending attachment");
  const pending = await state();
  pending.draftBefore = await draft();
  await point(.9, .9);
  pending.draftAfterBlockedPointer = await draft();
  await setVisibility(.6);
  pending.exportedVisibilityAfterBlockedEdit = await exportedVisibility();
  report.observations.push({ phase: "pending-attachment", ...pending });
  await evaluate(`[...document.querySelectorAll('[data-video-attachment-choice] button')]
    .find(button => button.textContent.trim() === 'Cancel').click()`);
  await setVisibility(.35);
  await click("Start over");
  for (const [x, y] of [[.2, .8], [.8, .8], [.8, .2], [.2, .2]]) await point(x, y);
  assert.equal(await evaluate(`[...document.querySelectorAll('.biomechanics-panel button')]
    .find(button => button.textContent.trim() === 'Save wall calibration').disabled`), false);

  // Hold a detached preparation candidate while the existing calibration is open.
  await evaluate(`(() => {
    const create = document.createElement;
    window.__ownedOriginalCreate = create;
    document.createElement = function(tag, ...args) {
      const element = create.call(this, tag, ...args);
      if (tag === 'video') {
        let source = '';
        Object.defineProperty(element, 'src', { get: () => source, set: value => { source = value; } });
        element.load = () => {};
        window.__ownedStalledDecoder = element;
      }
      return element;
    };
  })()`);
  await file(".upload-dropzone input[type=file]", path.join(browser.temporaryRoot, "blue/sample.mp4"));
  await until(`[...document.querySelectorAll('button')]
    .some(button => button.textContent.trim() === 'Cancel opening video')`, "pending preparation");
  const opening = await state();
  opening.draftBefore = await draft();
  opening.saveCalibrationDisabled = await evaluate(`[...document.querySelectorAll('.biomechanics-panel button')]
    .find(button => button.textContent.trim() === 'Save wall calibration').disabled`);
  await evaluate(`(() => {
    const input = document.querySelector('.corner-coordinate-grid input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '45');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.biomechanics-panel button')]
      .find(button => button.textContent.trim() === 'Save wall calibration').click();
  })()`);
  opening.draftAfterBlockedCoordinate = await draft();
  await setVisibility(.6);
  opening.exportedVisibilityAfterBlockedEdit = await exportedVisibility();
  report.observations.push({ phase: "opening-video", ...opening });
  await evaluate(`document.createElement = window.__ownedOriginalCreate;
    [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Cancel opening video').click()`);

  report.blockedModelRequests = [...modelRequests];
  assert.deepEqual(modelRequests, [], "No inference is needed for this control-ownership check.");
  for (const observation of report.observations) {
    assert.equal(observation.fullDisabled, true);
    assert.equal(observation.comDisabled, true, observation.phase + ": manual COM remains launchable");
    assert.equal(observation.visibilityDisabled, true, observation.phase + ": tracking settings remain editable");
    assert.equal(observation.exportedVisibilityAfterBlockedEdit, .35, observation.phase + ": blocked handler changed saved settings");
  }
  assert.deepEqual(pending.draftAfterBlockedPointer, pending.draftBefore, "Blocked pointer changed draft wall corners.");
  assert.deepEqual(opening.draftAfterBlockedCoordinate, opening.draftBefore, "Blocked coordinate edit changed draft wall corners.");
  assert.equal(opening.saveCalibrationDisabled, true);

  await click("Save wall calibration");
  const savedCorners = (await exportDataset()).biomechanics.calibration.corners.map(corner => corner.image);
  const expectedCorners = [{ x: .2, y: .8 }, { x: .8, y: .8 }, { x: .8, y: .2 }, { x: .2, y: .2 }];
  assert.equal(savedCorners.length, 4);
  for (let index = 0; index < expectedCorners.length; index++) {
    for (const axis of ["x", "y"]) {
      assert(Math.abs(savedCorners[index][axis] - expectedCorners[index][axis]) <= 1e-6,
        `Saved corner ${index} ${axis} differs from the selected coordinate.`);
    }
  }
  report.unblockedCalibrationSaved = true;

  // Cancel the first real inference request through the visible manual COM control.
  await evaluate(`(() => {
    const Native = window.Worker;
    window.__ownershipWorkers = { created: 0, terminated: 0, frames: 0, cancelFirst: true, cancelEnabled: null };
    window.Worker = new Proxy(Native, {
      construct(target, args) {
        const worker = Reflect.construct(target, args), state = window.__ownershipWorkers;
        state.created++;
        const post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
        let ended = false;
        worker.terminate = () => {
          if (!ended) { ended = true; state.terminated++; }
          terminate();
        };
        worker.postMessage = (data, transfer) => {
          post(data, transfer);
          if (data.kind === 'detect') {
            state.frames++;
            if (state.cancelFirst) {
              state.cancelFirst = false;
              queueMicrotask(() => {
                const button = [...document.querySelectorAll('.biomechanics-panel button')]
                  .find(button => button.textContent.trim() === 'Cancel');
                state.cancelEnabled = Boolean(button && !button.disabled);
                button?.click();
              });
            }
          }
        };
        return worker;
      }
    });
  })()`);
  await click("Analyze center of mass");
  await until(`document.querySelector('.biomechanics-panel')?.getAttribute('aria-busy') === 'false' &&
    /cancelled/i.test(document.querySelector('.biomechanics-panel .status-message')?.textContent ?? '')`, "manual analysis cancellation");
  report.cancel = await evaluate(`({ ...window.__ownershipWorkers,
    status: document.querySelector('.biomechanics-panel .status-message')?.textContent })`);
  assert.equal(report.cancel.cancelEnabled, true);
  assert.equal(report.cancel.created, 1);
  assert.equal(report.cancel.terminated, 1);

  await click("Analyze center of mass");
  await until(`document.querySelector('.biomechanics-panel')?.getAttribute('aria-busy') === 'false' &&
    Boolean(document.querySelector('#biomechanics-results-heading'))`, "manual result publication");
  report.completed = await evaluate(`({ ...window.__ownershipWorkers,
    status: document.querySelector('.biomechanics-panel .status-message')?.textContent,
    fullEnabled: !document.querySelector('#upload .analyze-button').disabled })`);
  assert.equal(report.completed.created, 2);
  assert.equal(report.completed.terminated, 2);
  assert.equal(report.completed.fullEnabled, true);
  assert(report.completed.frames > report.cancel.frames);
  const completedDataset = await exportDataset();
  assert.equal(completedDataset.biomechanics.result.frames.length, 11);

  await file(".upload-dropzone input[type=file]", path.join(browser.temporaryRoot, "blue/sample.mp4"));
  await until("Boolean(document.querySelector('[data-video-attachment-choice]'))", "result ownership while choosing replacement");
  report.resultControls = await evaluate(`(() => {
    const clear = [...document.querySelectorAll('.biomechanics-panel button')]
      .find(button => button.textContent.trim() === 'Clear result');
    const jumps = [...document.querySelectorAll('.biomechanics-results button')]
      .filter(button => button.textContent.trim() === 'Jump');
    const cursor = document.querySelector('video').currentTime;
    clear.click();
    for (const button of jumps) button.click();
    return {
      clearDisabled: clear.disabled,
      jumpCount: jumps.length,
      jumpsDisabled: jumps.every(button => button.disabled),
      cursorBefore: cursor,
      cursorAfter: document.querySelector('video').currentTime
    };
  })()`);
  assert.equal(report.resultControls.clearDisabled, true);
  assert(report.resultControls.jumpCount > 0);
  assert.equal(report.resultControls.jumpsDisabled, true);
  assert.equal(report.resultControls.cursorAfter, report.resultControls.cursorBefore);
  assert.deepEqual((await exportDataset()).biomechanics.result, completedDataset.biomechanics.result,
    "Blocked Clear must retain the published result.");
  await evaluate(`[...document.querySelectorAll('[data-video-attachment-choice] button')]
    .find(button => button.textContent.trim() === 'Cancel').click()`);
  report.modelRequests = [...modelRequests];
  report.modelInference = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
  console.error(error.message ?? error);
} finally {
  try {
    await browser?.close(send);
  } catch (error) {
    report.passed = false;
    report.errors.push(`Browser cleanup failed: ${error.stack ?? String(error)}`);
    process.exitCode = 1;
    console.error(error);
  } finally {
    try {
      socket?.close();
    } catch (error) {
      report.passed = false;
      report.errors.push(`Socket cleanup failed: ${error.stack ?? String(error)}`);
      process.exitCode = 1;
      console.error(error);
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
