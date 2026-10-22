/**
 * Repeat real Full analyses on the same loaded recording and document.
 * Run against a frozen production preview with locally supplied original clips.
 * Exact repeated output is a regression check, not independent accuracy evidence.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { startTestBrowser } from "./test-browser.mjs";
import { createProtocolClient } from "./cdp-client.mjs";

const option = (name, fallback) => process.argv
  .find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:4173/";
const reportPath = path.resolve(option("report", `test-results/pose-repeatability-${Date.now()}.json`));
const repeats = Number(option("repeats", "2"));
const fileNames = option("files", "12.24.mov,IMG_9199.MOV")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const videoDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");

if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5) {
  throw new Error("--repeats must be an integer from 2 to 5.");
}
if (!fileNames.length || fileNames.some(value => path.basename(value) !== value)) {
  throw new Error("--files requires local recording basenames.");
}

const report = {
  url,
  startedAt: new Date().toISOString(),
  repeats,
  interpretation: "Repeated real Full analyses on the same loaded recording and document, fresh model tracker per pass. Exact output repeatability, not independent accuracy.",
  outcomes: [],
  errors: [],
  browserExceptions: [],
};
const digest = value => createHash("sha256")
  .update(typeof value === "string" || ArrayBuffer.isView(value) ? value : JSON.stringify(value))
  .digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, send;

try {
  browser = await startTestBrowser({
    label: "app-pose-repeat",
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const target = await (await fetch(
    `http://127.0.0.1:${browser.port}/json/new?about%3Ablank`,
    { method: "PUT" },
  )).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  ({ send } = createProtocolClient(socket, { timeoutMs: 60000 }));
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      report.browserExceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  report.browser = await send("Browser.getVersion");

  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };
  const until = async (expression, label, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch (error) {
        if (!/context|navigat/.test(String(error))) throw error;
      }
      await sleep(100);
    }
    throw new Error("Timeout " + label);
  };

  for (const fileName of fileNames) {
    await send("Page.navigate", { url });
    await until(`
      Boolean(document.querySelector('#upload .analyze-button')) &&
      document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState === 'ready'
    `, "loaded app");
    const app = await evaluate(`({
      version: document.querySelector('[data-app-version]')?.dataset.appVersion,
      entry: [...document.scripts].map(script => script.src).filter(Boolean)
    })`);
    if (app.entry.some(value => value.includes("@vite/client"))) {
      throw new Error("Use a frozen production build.");
    }
    if (report.app && JSON.stringify(report.app) !== JSON.stringify(app)) {
      throw new Error("The served application changed between recordings.");
    }
    report.app = app;

    const filePath = path.resolve(videoDirectory, fileName);
    const sourceSha256 = digest(await readFile(filePath));
    const reference = JSON.parse(await readFile("benchmarks/pose-performance-2026-09-22.json", "utf8"))
      .outcomes.find(item => item.fileName === fileName);
    if (sourceSha256 !== reference?.sourceSha256) {
      throw new Error("Original video checksum mismatch.");
    }
    const item = { fileName, sourceSha256, runs: [] };
    report.outcomes.push(item);

    const input = await send("Runtime.evaluate", {
      expression: "document.querySelector('.upload-dropzone input[type=file]')",
    });
    await send("DOM.setFileInputFiles", {
      objectId: input.result.objectId,
      files: [filePath],
    });
    await until("Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))", "video ready");

    for (let repeat = 0; repeat < repeats; repeat++) {
      await evaluate("document.querySelector('#upload .analyze-button').click()");
      await until("document.querySelector('[data-analysis-running]')?.dataset.analysisRunning === 'true'", "Full starts");
      await until(`
        document.querySelector('[data-analysis-running]')?.dataset.analysisRunning === 'false' &&
        Boolean(document.querySelector('#upload .analyze-button:not(:disabled)'))
      `, "Full finishes", 180000);
      const dataset = await evaluate(`(() => {
        const original = navigator.clipboard.writeText;
        let text;
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async value => { text = value; }
        });
        try {
          const button = [...document.querySelectorAll('button')]
            .find(button => button.textContent.trim() === 'Copy JSON');
          for (let parent = button.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
          }
          button.click();
          return JSON.parse(text);
        } finally {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: original
          });
        }
      })()`);
      const pose = dataset.biomechanics?.result;
      if (!pose?.frames?.length || pose.metrics.validFrames < 3) {
        throw new Error(fileName + ": insufficient pose results for a complete-recording repeatability check.");
      }
      const result = {
        markers: dataset.acceptedTimestamps,
        calibration: dataset.biomechanics.calibration,
        identityZone: pose.identityZone,
        frames: pose.frames,
        metrics: pose.metrics,
        sourceFrameTimingAudit: dataset.sourceFrameTimingAudit,
        settings: pose.settings,
        frameHash: digest(pose.frames),
        markerHash: digest(dataset.acceptedTimestamps),
        calibrationHash: digest(dataset.biomechanics.calibration),
      };
      item.runs.push(result);
      console.log(`${fileName} Full ${repeat + 1}: ${result.metrics.validFrames}/${result.metrics.requestedFrames}; frames ${result.frameHash}`);
    }

    item.identical = {
      frames: item.runs.every(run => run.frameHash === item.runs[0].frameHash),
      markers: item.runs.every(run => run.markerHash === item.runs[0].markerHash),
      calibration: item.runs.every(run => run.calibrationHash === item.runs[0].calibrationHash),
      identityZone: item.runs.every(run => digest(run.identityZone) === digest(item.runs[0].identityZone)),
      samplingAudit: item.runs.every(run => digest(run.sourceFrameTimingAudit) === digest(item.runs[0].sourceFrameTimingAudit)),
    };
    console.log(JSON.stringify({ fileName, identical: item.identical }));
    if (!Object.values(item.identical).every(Boolean)) {
      throw new Error(fileName + ": repeated App results differed.");
    }
  }
  if (report.browserExceptions.length) throw new Error("The application raised an uncaught browser exception.");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
  console.error(error);
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
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log("Report " + reportPath);
}
