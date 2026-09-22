import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Isolates pose setup/sampling with the exact reviewed workflow's calibration.
// Source recordings stay local; this does not label timing or establish accuracy.
const args = process.argv.slice(2);
const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const referencePath = option("reference", "test-results/pose-performance-baseline-full.json");
const outputPath = option("report", `test-results/pose-performance-${Date.now()}.json`);
const repeats = Number(option("repeats", "3"));
const profiling = args.includes("--profile");
const pixelProbe = args.includes("--pixel-probe");
const poseModule = option("module", "/src/lib/poseAnalysis.ts");
const executionMode = option("execution", "main-thread");
if (!["main-thread", "worker", "auto"].includes(executionMode)) throw new Error("Choose main-thread, worker or auto execution.");
if (!poseModule.startsWith("/") || poseModule.startsWith("//") || poseModule.includes("..")) throw new Error("Use a local source-module path.");
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Choose 1–10 repeats.");
const names = args.filter(arg => !arg.startsWith("--"));
const reference = JSON.parse(await readFile(referencePath, "utf8"));
const inputs = reference.outcomes.filter(outcome => !names.length || names.includes(outcome.fileName));
if (!inputs.length) throw new Error("No matching reference outcomes.");
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const videoDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const port = Number(process.env.CLIMBIQ_E2E_PORT ?? 9341);
const profile = path.join(tmpdir(), `climbiq-pose-performance-${Date.now()}`);
const chrome = spawn(chromePath, ["--headless=new", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, send;
const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  appUrl, referencePath, poseModule, executionMode, profiling, pixelProbe, interpretation: "Local desktop Chrome direct-pose performance; identical fixed inputs, fresh pose tracker per repeat. Pixel probing forces extra readback and must not be compared with normal timings. Not native iPhone performance or independent accuracy validation.", outcomes: [] };

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
    if (attempt >= 100) throw new Error("Headless Chrome did not start.");
    await delay(100);
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  ({ send } = createProtocolClient(socket, { timeoutMs: 300000 }));
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  report.browser = await send("Browser.getVersion");
  for (const input of inputs) {
    if (!input.workflow?.trackingDiagnostics?.calibration) throw new Error(`${input.fileName}: full workflow calibration missing.`);
    const filePath = path.join(videoDirectory, path.basename(input.fileName));
    const sourceSha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
    if (sourceSha256 !== input.sourceSha256) throw new Error(`${input.fileName}: original recording checksum differs.`);
    await send("Page.navigate", { url: appUrl });
    for (let attempt = 0; ; attempt++) {
      try { if (await evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('main'))`)) break; } catch { /* navigation */ }
      if (attempt >= 100) throw new Error("App did not load.");
      await delay(100);
    }
    await evaluate(`(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'pose-benchmark-file';
      const video = document.createElement('video'); video.id = 'pose-benchmark-video'; video.muted = true; video.playsInline = true;
      input.onchange = () => { video.src = URL.createObjectURL(input.files[0]); video.load(); };
      document.body.append(input, video);
      input.hidden = true; video.style.cssText = 'width:1px;height:1px;position:fixed;bottom:0';
    })()`);
    const fileInput = await send("Runtime.evaluate", { expression: `document.querySelector('#pose-benchmark-file')`, returnByValue: false });
    await send("DOM.setFileInputFiles", { files: [filePath], objectId: fileInput.result.objectId });
    await evaluate(`new Promise((resolve, reject) => {
      const video = document.querySelector('#pose-benchmark-video');
      if (video.readyState >= 2) return resolve();
      video.addEventListener('loadeddata', resolve, { once: true }); video.addEventListener('error', () => reject(new Error('Video load failed')), { once: true });
    })`);
    const options = { startRawTime: parseFloat(input.start.rawTime), endRawTime: parseFloat(input.finish.rawTime),
      calibration: input.workflow.trackingDiagnostics.calibration, identityZone: input.workflow.trackingDiagnostics.identityZone };
    const outcome = { fileName: input.fileName, sourceSha256, repeats: [] };
    for (let repeat = 0; repeat < repeats; repeat++) {
      if (profiling && repeat === 0) { await send("Profiler.enable"); await send("Profiler.start"); }
      const result = await evaluate(`(async () => {
        const { analyzePoseVideo } = await import(${JSON.stringify(poseModule)});
        const { DEFAULT_BIOMECHANICS_SETTINGS } = await import('/src/lib/biomechanics.ts');
        const video = document.querySelector('#pose-benchmark-video');
        const pixelSamples = [];
        const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
        if (${pixelProbe}) CanvasRenderingContext2D.prototype.drawImage = function(...args) {
          originalDraw.apply(this,args);
          if(args.length===9 && args[0]===video) {
            const pixels=this.getImageData(0,0,this.canvas.width,this.canvas.height);
            pixelSamples.push({rawTime:video.currentTime,crop:args.slice(1),width:this.canvas.width,height:this.canvas.height,
              digest:crypto.subtle.digest('SHA-256',pixels.data.buffer).then(buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join(''))});
          }
        };
        const longTasks = []; const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({startTime:e.startTime,duration:e.duration}))));
        observer.observe({type:'longtask', buffered:false});
        const progress = []; let backendSelection;
        let previousTick = performance.now(), maxEventLoopDelayMs = 0;
        const heartbeat = setInterval(() => { const now=performance.now(); maxEventLoopDelayMs=Math.max(maxEventLoopDelayMs,now-previousTick-20); previousTick=now; },20);
        const started = performance.now();
        try {
          const result = await analyzePoseVideo({ video, ...${JSON.stringify(options)}, settings:DEFAULT_BIOMECHANICS_SETTINGS,
            executionMode:${JSON.stringify(executionMode)},onBackendSelected:value=>{backendSelection=value;},
            onProgress: value => progress.push({...value,elapsedMs:performance.now()-started}) });
          const elapsedMs=performance.now()-started;
          await new Promise(resolve => setTimeout(resolve,40));
          return {elapsedMs,backendSelection,firstSampleMs:progress.find(p=>p.phase==='analyzing')?.elapsedMs,progress,maxEventLoopDelayMs,
            pixelSamples:await Promise.all(pixelSamples.map(async sample=>({...sample,digest:await sample.digest}))),
            longTaskCount:longTasks.length,longTaskMs:longTasks.reduce((sum,e)=>sum+e.duration,0),maxLongTaskMs:Math.max(0,...longTasks.map(e=>e.duration)),
            modelFetchCount:performance.getEntriesByType('resource').filter(e=>e.name.includes('pose_landmarker_full.task')).length,
            heap:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null,
            metrics:result.metrics,warnings:result.warnings,frames:result.frames};
        } finally { clearInterval(heartbeat);observer.disconnect();CanvasRenderingContext2D.prototype.drawImage=originalDraw; }
      })()`);
      result.frameFingerprint = createHash("sha256").update(JSON.stringify(result.frames)).digest("hex");
      outcome.repeats.push(result);
      if (profiling && repeat === 0) {
        const { profile: cpu } = await send("Profiler.stop");
        const profilePath = `${outputPath}.${path.basename(input.fileName)}.cpuprofile`;
        await mkdir(path.dirname(path.resolve(profilePath)), { recursive: true });
        await writeFile(profilePath, JSON.stringify(cpu), { flag: "wx" });
        outcome.cpuProfilePath = profilePath;
        const selfTime = new Map();
        cpu.samples?.forEach((id, index) => selfTime.set(id, (selfTime.get(id) ?? 0) + (cpu.timeDeltas?.[index] ?? 0) / 1000));
        outcome.topCpuSelfTime = cpu.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url, milliseconds: selfTime.get(node.id) ?? 0 }))
          .sort((a,b)=>b.milliseconds-a.milliseconds).slice(0,20);
      }
      console.log(`${input.fileName} repeat ${repeat + 1}: ${Math.round(result.elapsedMs)} ms; ${result.metrics.validFrames}/${result.metrics.requestedFrames} COM; max event-loop delay ${Math.round(result.maxEventLoopDelayMs)} ms`);
    }
    report.outcomes.push(outcome);
  }
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(`Performance report: ${outputPath}`);
} finally {
  await closeTestBrowser(chrome, send);
  socket?.close();
}
