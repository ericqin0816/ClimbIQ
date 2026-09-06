import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Synthetic encoded clocks, not labels for human climbing footage.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const directory = path.resolve("node_modules/.climbiq-synthetic");
const ffmpeg =
  process.env.CLIMBIQ_FFMPEG ??
  (process.platform === "win32"
    ? "node_modules/.climbiq-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
    : "ffmpeg");
const chromePath =
  process.env.CLIMBIQ_CHROME ??
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
await mkdir(directory, { recursive: true });
const fixtures = [
  {
    name: "recovery-start-dimming-before-blue-30fps.mp4", fps:30, base:"0x14D218", event:"0x1426DC",
    enable:"gte(n,60)",preludeColor:"0x0A690C",preludeEnable:"between(n,45,59)",kind:"start",expected:2,chromaticRecovery:true,
  },
  {
    name: "recovery-start-brightening-before-blue-30fps.mp4", fps:30, base:"0x14D218", event:"0x1426DC",
    enable:"gte(n,60)",preludeColor:"0x28E62C",preludeEnable:"between(n,45,59)",kind:"start",expected:2,chromaticRecovery:true,
  },
  {
    name: "start-single-frame-10fps.mp4",
    fps: 10,
    base: "0x14D218",
    event: "0x1426DC",
    enable: "eq(n,10)+gte(n,20)",
    kind: "start",
    expected: 2,
  },
  {
    name: "start-short-glitch-60fps.mp4",
    fps: 60,
    base: "0x14D218",
    event: "0x1426DC",
    enable: "between(n,60,61)+gte(n,120)",
    kind: "start",
    expected: 2,
  },
  {
    name: "finish-first-flash-30fps.mp4",
    fps: 30,
    base: "0x145ADC",
    event: "0x149618",
    enable: "eq(n,31)+gte(n,33)",
    kind: "finish",
    expected: 31 / 30,
  },
];
for (const fixture of fixtures) {
  await new Promise((resolve, reject) => {
    const prelude=fixture.preludeColor?`,drawbox=x=48:y=48:w=16:h=16:color=${fixture.preludeColor}:t=fill:enable='${fixture.preludeEnable}'`:"";
    const filter = `drawbox=x=48:y=48:w=16:h=16:color=${fixture.base}:t=fill${prelude},drawbox=x=48:y=48:w=16:h=16:color=${fixture.event}:t=fill:enable='${fixture.enable}'`;
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x404040:s=128x128:r=${fixture.fps}:d=3`,
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-crf",
        "10",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-y",
        path.join(directory, fixture.name),
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr)),
    );
  });
}
const port = 9342;
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmpdir(), `climbiq-source-frames-${Date.now()}`)}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  appUrl,
  synthetic: true,
  isRealVideoAccuracyClaim: false,
  outcomes: [],
};
let socket, send;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Synthetic test browser did not start.");
  const target = await (
    await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`,
      { method: "PUT" },
    )
  ).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  send = createProtocolClient(socket).send;
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      );
    return r.result.value;
  };
  await send("Runtime.enable");
  for (let i = 0; i < 100; i++) {
    if (
      await evaluate(
        "Boolean(document.querySelector('main[data-app-version]'))",
      )
    )
      break;
    if (i === 99) throw new Error("App did not load.");
    await delay(100);
  }
  report.version = await evaluate(
    "document.querySelector('main').dataset.appVersion",
  );
  await evaluate(
    "(()=>{const i=document.createElement('input');i.type='file';i.id='source-frame-input';document.body.append(i);})()",
  );
  const input = (
    await send("Runtime.evaluate", {
      expression: "document.getElementById('source-frame-input')",
    })
  ).result.objectId;
  for (const fixture of fixtures) {
    await send("DOM.setFileInputFiles", {
      objectId: input,
      files: [path.join(directory, fixture.name)],
    });
    const outcome = await evaluate(
      `(${inspect.toString()})(${JSON.stringify(fixture)})`,
    );
    report.outcomes.push({ fixture: fixture.name, ...outcome });
    if (!outcome.passed)
      throw new Error(
        `Synthetic ${fixture.kind} timing failed: ${JSON.stringify(outcome)}`,
      );
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await closeTestBrowser(chrome, send);
  socket?.close();
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/source-frame-refinement.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

async function inspect(fixture) {
  const { detectStartSignal, findVerifiedGreenDeparture } = await import(
    "/src/lib/detectStartSignal.ts"
  );
  const { detectFinishSignal } = await import("/src/lib/detectFinishSignal.ts");
  const {
    sampleZoneOpponentColor,
    computeColorDistance,
    seekTo,
    sampleFramesInRange,
  } = await import("/src/lib/videoFrameSampler.ts");
  const { readDecodedVideoFrameTime } = await import(
    "/src/lib/decodedVideoFrame.ts"
  );
  const { scanSourceFrames } = await import("/src/lib/sourceFrameScan.ts");
  const file = document.getElementById("source-frame-input").files[0],
    url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.preload = "auto";
  document.body.append(video);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Synthetic video did not load")),
        15000,
      );
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Synthetic video decode failed"));
      };
    });
    const zone = {
      id: "startLight",
      label: "Synthetic lamp",
      x1: 48 / 128,
      y1: 48 / 128,
      x2: 64 / 128,
      y2: 64 / 128,
    };
    const initial = (await sampleZoneOpponentColor(video, 0.5, zone))
      .averageRgb;
    const final = (await sampleZoneOpponentColor(video, 2.5, zone)).averageRgb;
    const calibration = {
      beforeStartRGB: fixture.kind === "start" ? initial : final,
      afterStartRGB: fixture.kind === "start" ? final : initial,
      colorDelta: computeColorDistance(initial, final),
    };
    const runDetector = async (start,sensitivity="medium") =>
      fixture.kind === "start"
        ? await detectStartSignal({
            video,
            zone,
            searchStart: start,
            searchEnd: 2.9,
            fps: 30,
            sensitivity,
            profile: "calibrated",
            calibration,
            colorSamplingMode: "opponent",
            requireChromaticDeparture: Boolean(fixture.chromaticRecovery),
          })
        : await detectFinishSignal({
            video,
            zone,
            startSignalRawTime: 0,
            minimumClimbSeconds: start,
            maximumClimbSeconds: 2.9,
            calibration,
          });
    const result = await runDetector(0.3);
    const phases = [];
    for (const phase of [0, 0.001, 0.005, 0.016, 0.025]) {
      const times = [];
      const summary = await scanSourceFrames({
        video,
        start: 0.3 + phase,
        end: 2.7,
        onFrame: (f) => {
          times.push(f.rawTime);
        },
      });
      const containsExpected = times.some(
        (t) => Math.abs(t - fixture.expected) < 0.001,
      );
      const detection = await runDetector(0.3 + phase);
      const sensitivities=[];
      if(fixture.kind==="start")for(const sensitivity of ["low","high"]){
        const tested=await runDetector(.3+phase,sensitivity);
        sensitivities.push({sensitivity,rawTime:tested.rawTime,matched:tested.detected&&Math.abs(tested.rawTime-fixture.expected)<.001});
      }
      phases.push({
        phase,
        summary,
        containsExpected,
        detectedRawTime: detection.rawTime,
        sensitivities,
        detectorMatched:
          detection.detected &&
          Math.abs(detection.rawTime - fixture.expected) < 0.001 && sensitivities.every(s=>s.matched),
      });
    }
    const legacy = [];
    const legacyColors = [];
    for (const time of sampleFramesInRange(0.3, 2.7, 30).filter(time=>time<2.7)) {
      await seekTo(video, time);
      legacy.push(readDecodedVideoFrameTime(video)?.mediaTime);
      const color = (await sampleZoneOpponentColor(video, time, zone))
        .averageRgb;
      legacyColors.push({
        time,
        averageRgb: color,
        colorDistance: computeColorDistance(color, calibration.beforeStartRGB),
        distanceToBefore: computeColorDistance(
          color,
          calibration.beforeStartRGB,
        ),
        distanceToAfter: computeColorDistance(color, calibration.afterStartRGB),
        greenScore: color.g - Math.max(color.r, color.b),
        blueScore: color.b - Math.max(color.r, color.g),
      });
    }
    const legacyDeparture =
      fixture.kind === "start"
        ? findVerifiedGreenDeparture(legacyColors, calibration, 2)
        : undefined;
    return {
      rawTime: result.rawTime,
      confidence: result.confidence,
      ...(!result.detected ? { failure: {
        reason: result.reason,
        debugReason: result.debug.failureReason,
        calibration,
        browser: navigator.userAgent,
        candidates: result.candidates,
        samples: result.debug.samples,
      } } : {}),
      expected: fixture.expected,
      chromaticRecovery: Boolean(fixture.chromaticRecovery),
      uniqueDetectorFrames: new Set(result.debug.samples.map((s) => s.time))
        .size,
      detectorSamples: result.debug.samples.length,
      legacyRequested: legacy.length,
      legacyUnique: new Set(legacy).size,
      phases,
      legacyGridDeparture: legacyDeparture
        ? legacyColors[legacyDeparture.onsetIndex].time
        : undefined,
      passed:
        result.detected &&
        Math.abs(result.rawTime - fixture.expected) < 0.001 &&
        phases.every(
          (p) =>
            p.containsExpected &&
            p.detectorMatched &&
            p.summary.nativeFrames === p.summary.observations,
        ),
    };
  } finally {
    video.remove();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
