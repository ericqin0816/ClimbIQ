import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { auditDecodedSourceFrames } from "./frame-audit.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const sampleVideo = process.env.CLIMBIQ_E2E_VIDEO;
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const auditFrames = process.argv.includes("--frame-audit");
const port = 9333;
const profile = path.join(tmpdir(), `climbiq-e2e-${Date.now()}`);
let protocolSend;

const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error("Headless Chrome did not start.");
}

async function run() {
  if (!sampleVideo) {
    throw new Error("Set CLIMBIQ_E2E_VIDEO to an absolute path before running the upload smoke test.");
  }
  await waitForDebugger();
  const targetResponse = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`,
    { method: "PUT" },
  );
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const { send } = createProtocolClient(socket);
  protocolSend = send;
  const runtimeErrors = [];
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(message.params.exceptionDetails.text);
    }
  });

  const evaluate = async (expression, returnByValue = true) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return returnByValue ? response.result.value : response.result;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("document.readyState === 'complete'")) break;
    await delay(100);
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('.upload-dropzone input[type=file]'))")) break;
    await delay(100);
  }

  await evaluate("document.querySelector('.upload-dropzone')?.scrollIntoView({ block: 'center', behavior: 'instant' })");
  await delay(100);

  const hitTargetIsInput = await evaluate(`(() => {
    const zone = document.querySelector('.upload-dropzone');
    const input = zone?.querySelector('input[type="file"]');
    if (!zone || !input) return false;
    const box = zone.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input;
  })()`);
  if (!hitTargetIsInput) throw new Error("The upload target is not clickable across its full area.");

  const getInputObject = async () => {
    const result = await evaluate("document.querySelector('.upload-dropzone input[type=file]')", false);
    if (!result.objectId) throw new Error("Upload input was not rendered.");
    return result.objectId;
  };
  await send("DOM.setFileInputFiles", { files: [sampleVideo], objectId: await getInputObject() });

  let snapshot;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    snapshot = await evaluate(`(() => {
      const runButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Run full analysis'));
      return {
        fileName: document.querySelector('.upload-copy strong')?.textContent ?? '',
        ready: document.querySelector('.video-meta-line')?.textContent.includes('Ready') ?? false,
        runEnabled: Boolean(runButton && !runButton.disabled),
        videoMounted: Boolean(document.querySelector('#video-review video')),
        videoSource: document.querySelector('#video-review video')?.src ?? '',
        error: document.querySelector('.upload-error')?.textContent ?? '',
      };
    })()`);
    if (snapshot.ready || snapshot.error) break;
    await delay(100);
  }

  if (snapshot.fileName !== path.basename(sampleVideo)) throw new Error(`Wrong selected file state: ${snapshot.fileName}`);
  if (snapshot.error) throw new Error(snapshot.error);
  if (!snapshot.videoMounted || !snapshot.videoSource.startsWith("blob:")) throw new Error("Video player did not mount with its local blob URL.");
  if (!snapshot.ready || !snapshot.runEnabled) throw new Error(`Video metadata never became ready: ${JSON.stringify(snapshot)}`);

  await send("DOM.setFileInputFiles", { files: [sampleVideo], objectId: await getInputObject() });
  await delay(500);
  const retryReady = await evaluate("document.querySelector('.video-meta-line')?.textContent.includes('Ready') ?? false");
  if (!retryReady) throw new Error("Selecting the same file a second time did not recover to Ready.");
  const frameAudit = auditFrames ? await evaluate(`(${auditDecodedSourceFrames.toString()})()`) : undefined;
  if (runtimeErrors.length) throw new Error(`Browser runtime errors: ${runtimeErrors.join(' | ')}`);

  console.log(JSON.stringify({ status: "passed", hitTargetIsInput, ...snapshot, sameFileRetry: retryReady, frameAudit }, null, 2));
  await closeTestBrowser(chrome, send);
  socket.close();
}

try {
  await run();
} finally {
  await closeTestBrowser(chrome, protocolSend);
}
