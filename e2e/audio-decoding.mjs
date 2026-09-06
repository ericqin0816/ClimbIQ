import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Tests the browser's real codec/resampling path, not a mocked AudioContext.
// This imports source modules from a local Vite server; it is not a production
// deployment test or an independent labeled accuracy evaluation.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const port = 9337;
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-audio-${Date.now()}`)}`, "about:blank"],
{ stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sendCommand;

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Headless audio test browser did not start.");
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error("Could not open the local test app.");
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const { send } = createProtocolClient(socket);
  sendCommand = send;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("document.readyState === 'complete' && Boolean(document.querySelector('main[data-app-version]'))")) break;
    if (attempt === 99) throw new Error("The local app did not load.");
    await delay(100);
  }
  const report = await evaluate(`(${browserAudioStudy.toString()})()`);
  console.log(JSON.stringify({ appUrl, isGroundTruthLabel: false, ...report }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await closeTestBrowser(chrome, sendCommand);
  socket?.close();
}

async function browserAudioStudy() {
  const { detectAudioStartSignal } = await import("/src/lib/detectAudioStartSignal.ts");
  const NativeContext = window.AudioContext;
  const requests = [];
  window.AudioContext = new Proxy(NativeContext, { construct(target, args) {
    requests.push(args[0]?.sampleRate ?? null);
    return Reflect.construct(target, args);
  } });
  const scenarios = [
    { id: "native-8khz", rate: 8000, channels: 1, expected: 4 },
    { id: "mono-44khz", rate: 44100, channels: 1, expected: 4 },
    { id: "stereo-48khz", rate: 48000, channels: 2, expected: 4 },
    { id: "absolute-window-offset", rate: 44100, channels: 1, searchStart: 1.25, expected: 4 },
    { id: "out-of-band-alias-trap", rate: 44100, channels: 1, frequencies: [8554, 8554, 9108], expected: null },
    { id: "same-pitch-is-not-official", rate: 48000, channels: 2, frequencies: [554, 554, 554], expected: null },
    { id: "silence", rate: 44100, channels: 1, silence: true, expected: null },
    { id: "invalid-codec", invalid: true, expected: null },
  ];
  try {
    const outcomes = [];
    for (const scenario of scenarios) {
      requests.length = 0;
      const encoded = scenario.invalid ? new Uint8Array([0, 1, 2, 3]) : wave(scenario);
      const result = await detectAudioStartSignal({ file: new File([encoded], `${scenario.id}.wav`, { type: "audio/wav" }),
        searchStart: scenario.searchStart ?? 0, searchEnd: 5 });
      const accepted = result.found && result.confidence === "High";
      const passed = requests.length === 1 && requests[0] === 8000 && (scenario.expected === null
        ? !accepted : accepted && Math.abs(result.rawTime - scenario.expected) <= 0.03);
      outcomes.push({ id: scenario.id, requestedContextRates: [...requests], found: result.found,
        rawTime: result.rawTime, confidence: result.confidence, pattern: result.matchedPattern,
        expectedSyntheticOnset: scenario.expected, passed });
    }
    return { version: document.querySelector('main[data-app-version]')?.dataset.appVersion,
      passed: outcomes.every(outcome => outcome.passed), outcomes };
  } finally { window.AudioContext = NativeContext; }

  function wave({ rate, channels, frequencies = [554, 554, 1108], silence = false }) {
    const frames = rate * 5, byteLength = frames * channels * 2;
    const bytes = new ArrayBuffer(44 + byteLength), data = new DataView(bytes);
    const word = (offset, value) => { for (let index = 0; index < value.length; index++) data.setUint8(offset + index, value.charCodeAt(index)); };
    word(0, 'RIFF'); data.setUint32(4, 36 + byteLength, true); word(8, 'WAVE'); word(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, channels, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * channels * 2, true);
    data.setUint16(32, channels * 2, true); data.setUint16(34, 16, true); word(36, 'data'); data.setUint32(40, byteLength, true);
    if (!silence) for (let index = 0; index < frames; index++) {
      const time = index / rate;
      let sample = 0;
      for (let beep = 0; beep < 3; beep++) {
        const t = time - (beep + 2);
        if (t >= 0 && t < 0.14) sample += 0.7 * Math.min(1, t / 0.005, (0.14 - t) / 0.005) * Math.sin(2 * Math.PI * frequencies[beep] * t);
      }
      for (let channel = 0; channel < channels; channel++) data.setInt16(44 + (index * channels + channel) * 2, Math.round(sample * 32767), true);
    }
    return bytes;
  }
}
