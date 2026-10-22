import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5175/";
const videoPath = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos", "IMG_9199.MOV");
const reportPath = process.argv.find(arg => arg.startsWith("--report="))?.slice(9) ?? `test-results/worker-pointer-${Date.now()}.json`;
const port = Number(process.env.CLIMBIQ_E2E_PORT ?? 9342);
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-worker-pointer-${Date.now()}`)}`, "about:blank"], { stdio: "ignore", windowsHide: true });
let send, socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await readFile(videoPath);
  for (let index = 0; ; index++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
    if (index >= 100) throw new Error("Chrome did not start."); await delay(100);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  ({ send } = createProtocolClient(socket));
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) { if (await evaluate(expression)) return; await delay(25); }
    throw new Error(`${label}: ${await evaluate(`document.querySelector('.quick-analysis-box .status-message')?.textContent`)}; ${await evaluate(`JSON.stringify(window.__workerPointer)`)}`);
  };
  await send("Runtime.enable");
  await until(`Boolean(document.querySelector('input[accept="video/*"]'))`, "App load");
  await evaluate(`(() => {
    const NativeWorker=window.Worker;
    window.__workerPointer={created:0,terminated:0,frames:0,pending:0,pointerDownAt:null,clickAt:null,pendingAtPointerDown:null};
    window.Worker=new Proxy(NativeWorker,{construct(target,args){
      const worker=Reflect.construct(target,args);window.__workerPointer.created++;
      const post=worker.postMessage.bind(worker),terminate=worker.terminate.bind(worker);const pending=new Set();
      worker.postMessage=(data,transfer)=>{if(data.kind==='detect'){pending.add(data.id);window.__workerPointer.frames++;window.__workerPointer.pending++;}post(data,transfer);};
      worker.addEventListener('message',event=>{if(pending.delete(event.data.id))window.__workerPointer.pending--;});
      let ended=false;worker.terminate=()=>{if(!ended){ended=true;window.__workerPointer.terminated++;window.__workerPointer.pending-=pending.size;pending.clear();}terminate();};
      return worker;
    }});
  })()`);
  const input = await send("Runtime.evaluate", { expression: `document.querySelector('input[accept="video/*"]')`, returnByValue: false });
  await send("DOM.setFileInputFiles", { files: [videoPath], objectId: input.result.objectId });
  await until(`document.querySelector('.video-meta-line')?.textContent.includes('Ready')`, "Video readiness");
  await evaluate(`(()=>{document.querySelector('video').currentTime=2.5;})()`);
  await until(`!document.querySelector('video').seeking`, "Initial cursor");
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Run full analysis')).click()`);
  await until(`window.__workerPointer.frames>=3 && window.__workerPointer.pending>0`, "Actual worker frame in flight", 150000);
  const before = await evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel');
    if(!button || button.disabled)throw new Error('Cancel button unavailable during worker analysis');
    button.scrollIntoView({block:'center',behavior:'instant'});
    button.addEventListener('pointerdown',()=>{window.__workerPointer.pointerDownAt=Date.now();window.__workerPointer.pendingAtPointerDown=window.__workerPointer.pending;},{once:true});
    button.addEventListener('click',()=>{window.__workerPointer.clickAt=Date.now();},{once:true});
    const rect=button.getBoundingClientRect();
    const markers=[...document.querySelectorAll('tbody tr')].filter(r=>['Start Signal','Finish Pad'].includes(r.firstElementChild?.textContent.trim())).map(r=>r.textContent);
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,markers};
  })()`);
  // Wait again after scrolling/handler setup so the input reaches the document
  // during a real inference, rather than only between worker frames.
  await until(`window.__workerPointer.pending>0`, "Worker frame before pointer input");
  const pointerSentAt = Date.now();
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.x, y: before.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.x, y: before.y, button: "left", clickCount: 1 });
  await until(`/cancelled/i.test(document.querySelector('.quick-analysis-box .status-message')?.textContent ?? '') && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Run full analysis')&&!b.disabled)`, "Pointer cancellation acknowledged", 10000);
  const acknowledgedAt = Date.now();
  const after = await evaluate(`({worker:window.__workerPointer,cursor:document.querySelector('video').currentTime,paused:document.querySelector('video').paused,
    markers:[...document.querySelectorAll('tbody tr')].filter(r=>['Start Signal','Finish Pad'].includes(r.firstElementChild?.textContent.trim())).map(r=>r.textContent),
    status:document.querySelector('.quick-analysis-box .status-message')?.textContent})`);
  const pointerHandlerLatencyMs = after.worker.pointerDownAt - pointerSentAt;
  const cancellationAcknowledgedMs = acknowledgedAt - pointerSentAt;
  if (after.worker.pointerDownAt === null || after.worker.clickAt === null || pointerHandlerLatencyMs < 0 || pointerHandlerLatencyMs > 250) throw new Error(`Pointer handler latency ${pointerHandlerLatencyMs} ms`);
  if (after.worker.pendingAtPointerDown < 1) throw new Error("Pointer missed the inference interval; rerun this test.");
  if (after.worker.created !== after.worker.terminated || after.worker.pending) throw new Error("Cancellation left an active worker.");
  if (!after.paused || Math.abs(after.cursor - 2.5) > 0.002 || JSON.stringify(before.markers) !== JSON.stringify(after.markers)) throw new Error("Cancellation changed accepted timing or failed to restore the video.");
  await delay(350);
  if (await evaluate(`window.__workerPointer.pending>0 || !/cancelled/i.test(document.querySelector('.quick-analysis-box .status-message')?.textContent ?? '')`)) throw new Error("Stale worker published after cancellation.");
  const report = { appUrl, passed: true, fileName: path.basename(videoPath), pointerHandlerLatencyMs, cancellationAcknowledgedMs, ...after, interpretation: "Actual desktop-browser pointer input while worker inference was pending; not an iPhone or timing-accuracy measurement." };
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally { await closeTestBrowser(chrome, send); socket?.close(); }
