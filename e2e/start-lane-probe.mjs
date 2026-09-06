import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Diagnostic only: compare every discovered patch with lane-local motion.
// Imports source modules from Vite; no timestamp is accepted or labeled here.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const files = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const reportFile = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
const finishWindow = process.argv.find(arg=>arg.startsWith("--finish-window="))?.slice(16).split(",").map(Number);
if (finishWindow && (finishWindow.length!==2 || !finishWindow.every(Number.isFinite) || finishWindow[0]<0 || finishWindow[1]<=finishWindow[0])) throw new Error("--finish-window requires two increasing raw times.");
if (!files.length) throw new Error("Provide local video paths and optional --report=PATH.");
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32"
  ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const port = 9338;
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-lanes-${Date.now()}`)}`, "about:blank"],
{ stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, send;
const report = { appUrl, isGroundTruthLabel: false, outcomes: [] };
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Lane probe browser did not start.");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  send = createProtocolClient(socket).send;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("Boolean(document.querySelector('main[data-app-version]'))")) break;
    if (attempt === 99) throw new Error("App did not load.");
    await delay(100);
  }
  report.version = await evaluate("document.querySelector('main').dataset.appVersion");
  await evaluate("(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'lane-probe-input'; document.body.append(i); })()");
  const input = (await send("Runtime.evaluate", { expression: "document.getElementById('lane-probe-input')" })).result.objectId;
  for (const file of files) {
    await send("DOM.setFileInputFiles", { objectId: input, files: [path.resolve(file)] });
    const outcome = await evaluate(`(${probe.toString()})(${process.argv.includes("--detail")}, ${process.argv.includes("--source-timing")}, ${process.argv.includes("--finish")}, ${JSON.stringify(finishWindow??null)})`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    report.outcomes.push({ fileName: path.basename(file), sourceSha256: hash.digest("hex"), ...outcome });
    console.log(JSON.stringify({ fileName: path.basename(file), audio: outcome.audio, lanes: outcome.lanes.map(lane => ({
      zone: lane.zone, cue: lane.result.rawTime, confidence: lane.result.confidence, movement: lane.movement.rawTime, audit: lane.audit,
      sourceTiming: lane.sourceTiming?.summary, finish: lane.finish ? {rawTime:lane.finish.rawTime,confidence:lane.finish.confidence,reason:lane.finish.reason} : undefined,
      finishScales:lane.finishScales?.map(item=>({scale:item.scale,rawTime:item.rawTime,confidence:item.confidence,
        blueSupport:item.blueSupport,colorDelta:item.calibration.colorDelta})),
      chromaticAudit:lane.chromaticAudit,
    })) }, null, 2));
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  await closeTestBrowser(chrome, send); socket?.close();
  if (reportFile) { await mkdir(path.dirname(path.resolve(reportFile)), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2)); }
  if (!report.passed) console.error(report.error);
}

async function probe(detailPass, sourceTiming, inspectFinish, finishWindow) {
  const { detectAudioStartSignal } = await import("/src/lib/detectAudioStartSignal.ts");
  const { detectAutomaticStartLight } = await import("/src/lib/detectAutomaticStartLight.ts");
  const { detectFirstMovement } = await import("/src/lib/detectFirstMovement.ts");
  const { deriveAutomaticStartBodyZone } = await import("/src/lib/startRegion.ts");
  const { assessAutomaticStartBodyAudit } = await import("/src/lib/startBodyAudit.ts");
  const { seekTo, sampleZoneOpponentColor, computeColorDistance } = await import("/src/lib/videoFrameSampler.ts");
  const { readDecodedVideoFrameTime } = await import("/src/lib/decodedVideoFrame.ts");
  const { detectFinishSignal } = await import("/src/lib/detectFinishSignal.ts");
  const {findVerifiedGreenDeparture}=await import("/src/lib/detectStartSignal.ts");
  const file = document.getElementById("lane-probe-input").files[0];
  const url = URL.createObjectURL(file), video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.src = url; document.body.append(video);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Video loading timed out.")), 15000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("Video decode failed.")); };
    });
    const searchEnd = Math.min(12, video.duration);
    const audio = await detectAudioStartSignal({ file, searchStart: 0, searchEnd });
    const discovery = await detectAutomaticStartLight({ video, searchStart: 0, searchEnd, expectedStartTime: audio.searchHintTime, detailPass });
    const lanes = [];
    for (let index = 0; index < (discovery.laneCandidates?.length ?? 0); index++) {
      const lane = discovery.laneCandidates[index], result = discovery.laneResults[index];
      const body = deriveAutomaticStartBodyZone(lane.zone);
      const movement = await detectFirstMovement({ video, zone: body, startSignalRawTime: result.rawTime, sensitivity: "medium" });
      let timing, finish, finishScales;
      if (sourceTiming) {
        const frames = [];
        for (const sample of result.debug.samples) {
          const cursor = sample.cursorTime ?? sample.time;
          await seekTo(video, cursor, {exact:true});
          const decoded = readDecodedVideoFrameTime(video);
          frames.push({sampleTime:sample.time,cursorTime:cursor,sourceTime:decoded?.mediaTime,duration:decoded?.durationSeconds});
        }
        const native = frames.filter(f=>f.sourceTime!==undefined);
        timing = {frames,summary:{sampled:frames.length,native:native.length,
          uniqueNative:new Set(native.map(f=>f.sourceTime)).size,
          maximumCursorOffset:native.length?Math.max(...native.map(f=>f.cursorTime-f.sourceTime)):undefined,
          eventFrame:frames.find(f=>Math.abs(f.sampleTime-result.rawTime)<.001)}};
      }
      if (inspectFinish && Number.isFinite(result.rawTime) &&
          (audio.rawTime === undefined || Math.abs(result.rawTime-audio.rawTime)<.5)) {
        finish = await detectFinishSignal({video,zone:lane.zone,startSignalRawTime:result.rawTime,calibration:lane.calibration});
      }
      if (finishWindow && Number.isFinite(result.rawTime) &&
          (audio.rawTime===undefined || Math.abs(result.rawTime-audio.rawTime)<.5)) {
        finishScales=[];
        const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
        const medianRgb=colors=>Object.fromEntries(['r','g','b'].map(c=>[c,median(colors.map(rgb=>rgb[c]))]));
        for(const scale of [1,2,4]) {
          const cx=(lane.zone.x1+lane.zone.x2)/2,cy=(lane.zone.y1+lane.zone.y2)/2;
          const hw=(lane.zone.x2-lane.zone.x1)*scale/2,hh=(lane.zone.y2-lane.zone.y1)*scale/2;
          const zone=scale===1?lane.zone:{...lane.zone,x1:Math.max(0,cx-hw),x2:Math.min(1,cx+hw),y1:Math.max(0,cy-hh),y2:Math.min(1,cy+hh)};
          const before=[],after=[];
          for(const offset of [-.45,-.35,-.25,-.15])before.push((await sampleZoneOpponentColor(video,Math.max(0,result.rawTime+offset),zone)).averageRgb);
          for(const offset of [.15,.25,.35,.45,.55,.65,.75,.85,.95,1.05,1.15])after.push((await sampleZoneOpponentColor(video,result.rawTime+offset,zone)).averageRgb);
          const beforeRgb=medianRgb(before),afterRgb=medianRgb(after);
          const calibration={beforeStartRGB:beforeRgb,afterStartRGB:afterRgb,colorDelta:computeColorDistance(beforeRgb,afterRgb)};
          const blueSupport=after.filter(rgb=>rgb.b-rgb.g>=2).length/after.length;
          const candidate=await detectFinishSignal({video,zone,startSignalRawTime:result.rawTime,calibration,
            minimumClimbSeconds:finishWindow[0]-result.rawTime,maximumClimbSeconds:finishWindow[1]-result.rawTime});
          finishScales.push({scale,zone,calibration,blueSupport,rawTime:candidate.rawTime,confidence:candidate.confidence,reason:candidate.reason});
        }
      }
      const chromatic=findVerifiedGreenDeparture(result.debug.samples,result.debug.calibration??lane.calibration,2,true,2/30);
      const chromaticAudit=chromatic?{rawTime:result.debug.samples[chromatic.onsetIndex].time,blueTime:result.debug.samples[chromatic.confirmationIndex].time}:undefined;
      lanes.push({ zone: lane.zone, body, calibration: lane.calibration, result, movement,chromaticAudit,
        sourceTiming:timing,finish,finishScales,
        audit: assessAutomaticStartBodyAudit(movement, result.rawTime) });
    }
    return { audio: { rawTime: audio.rawTime, searchHintTime: audio.searchHintTime, confidence: audio.confidence }, lanes };
  } finally { video.remove(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
