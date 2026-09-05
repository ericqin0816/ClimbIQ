import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const disableNative = process.env.CLIMBIQ_E2E_DISABLE_VIDEO_FRAME === "1";
const directory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? "node_modules/.climbiq-private-videos");
const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const port = 9336;
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-finish-review-${Date.now()}`)}`, "about:blank"], { stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { appUrl: url, isGroundTruthLabel: false, disableNative };
let socket; let send;
try {
  let connected = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch {}
    await delay(100);
  }
  if (!connected) throw new Error("Chrome did not start.");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(disableNative ? "about:blank" : url)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  send = createProtocolClient(socket).send;
  const errors = [];
  socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text); });
  await send("Runtime.enable");
  if (disableNative) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(window, 'VideoFrame', { value: undefined, configurable: true });" });
    await send("Page.navigate", { url });
  }
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const until = async (expression, label, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Timed out: ${label}. ${await evaluate("document.querySelector('.quick-analysis-box')?.textContent ?? ''")}`);
  };
  const button = name => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)})`;
  const click = name => evaluate(`(() => { const b = ${button(name)}; if (!b || b.disabled) throw new Error('Unavailable control: '+${JSON.stringify(name)}); b.click(); })()`);
  const upload = async name => {
    const node = await send("Runtime.evaluate", { expression: "document.querySelector('input[accept=\"video/*\"]')" });
    await send("DOM.setFileInputFiles", { files: [path.join(directory, name)], objectId: node.result.objectId });
    await until(`document.querySelector('.upload-copy strong')?.textContent === ${JSON.stringify(name)} && document.querySelector('.video-meta-line')?.textContent.includes('Ready')`, "video ready");
  };
  const markers = "JSON.stringify([...document.querySelectorAll('#results tbody tr')].map(r => [...r.querySelectorAll('td')].slice(0,5).map(c => c.textContent)))";
  const ready = `${button("Rescan near current frame")} && !${button("Rescan near current frame")}.disabled`;
  await until("Boolean(document.querySelector('input[accept=\"video/*\"]'))", "app");
  report.version = await evaluate("document.querySelector('main').dataset.appVersion");
  await upload("IMG_9199.MOV"); await click("Run full analysis");
  await until(`${button("Run full analysis")} && !${button("Run full analysis")}.disabled`, "full analysis", 180000);
  const before = await evaluate(markers);
  await click("Review finish / mark pad");
  await until("Boolean(document.querySelector('.finish-closeup img')?.naturalWidth)", "synchronized close-up");
  await click("Mark finish pad");
  await evaluate(`(() => { const image = document.querySelector('.finish-pad-image'); const r = image.getBoundingClientRect();
    image.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:r.left+.45*r.width,clientY:r.top+.075*r.height})); })()`);
  await until("document.querySelector('.finish-pad-selection [role=status]')?.textContent.includes('First corner set')", "first corner");
  await evaluate(`(() => { const image = document.querySelector('.finish-pad-image'); const r = image.getBoundingClientRect();
    image.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:r.left+.60*r.width,clientY:r.top+.30*r.height})); })()`);
  await until("!document.querySelector('.finish-pad-corner')", "two-corner marking");
  const drawn = await evaluate("[...document.querySelectorAll('.finish-pad-coordinates input')].map(i => Number(i.value))");
  // MouseEvent screen coordinates may be rounded to whole CSS pixels.
  if (drawn.some((value, index) => Math.abs(value - [45, 3, 60, 12][index]) > 0.3)) throw new Error(`Upper-wall selection mapped to wrong source coordinates: ${drawn}`);
  report.zoomedMarkingCoordinates = true;
  // Arbitrary small test area: this exercises geometry/workflow, not pad labels.
  await evaluate(`(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const values = ['45','3','60','12']; [...document.querySelectorAll('.finish-pad-coordinates input')].forEach((input,i) => {
      setter.call(input,values[i]); input.dispatchEvent(new Event('input',{bubbles:true})); }); })()`);
  await click("Use this pad area"); await until(ready, "marked pad ready");
  const priorCursor = await evaluate("document.querySelector('video').currentTime");
  await click("Rescan near current frame");
  await until("document.querySelectorAll('.finish-review-filmstrip img').length >= 3", "finish filmstrip", 40000);
  await until(ready, "scan settled");
  if (await evaluate(markers) !== before) throw new Error("Rescan changed accepted timing.");
  if (Math.abs(await evaluate("document.querySelector('video').currentTime") - priorCursor) > 0.002) throw new Error("Rescan failed to restore the cursor.");
  if (!(await evaluate("[...document.querySelectorAll('.finish-review-filmstrip img')].every(img => img.complete && img.naturalWidth)"))) throw new Error("Filmstrip images did not load.");
  await evaluate("document.querySelector('.finish-review-filmstrip button').click()");
  await until("Boolean(document.querySelector('.finish-closeup img')?.naturalWidth) && !document.querySelector('video').seeking", "thumbnail navigation");
  if (await evaluate(markers) !== before) throw new Error("Thumbnail navigation accepted a finish.");
  report.rescanAndThumbnailKeptTiming = true;

  await mkdir("test-results", { recursive: true });
  report.screenshots = [];
  for (const [layout, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(layout === "desktop" ? "document.getElementById('video-review').scrollIntoView({block:'start'})"
      : "document.querySelector('.finish-review-tools').scrollIntoView({block:'center'})");
    if (await evaluate("document.documentElement.scrollWidth > innerWidth + 1")) throw new Error(`${layout}: finish review overflows horizontally.`);
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    const filename = path.resolve(`test-results/guided-finish-${report.version}-${disableNative ? 'fallback' : 'native'}-${layout}.png`);
    await writeFile(filename, Buffer.from(screenshot.data, "base64"));
    report.screenshots.push(filename);
  }

  await click("Rescan near current frame");
  await until(`Boolean(${button("Cancel finish rescan")})`, "cancellation control");
  if (!(await evaluate("document.querySelector('.timestamp-review-actions .primary').disabled"))) throw new Error("Acceptance was enabled during a scan.");
  await click("Close review");
  await until(`${button("Review finish / mark pad")} && !${button("Review finish / mark pad")}.disabled`, "close cancels scan");
  await delay(250);
  if (await evaluate("Boolean(document.querySelector('[data-finish-review-tools]'))") || await evaluate(markers) !== before) throw new Error("Closed scan published stale results or altered markers.");
  report.closeCancelsWithoutStaleResults = true;

  await click("Save Session");
  const saved = await evaluate("JSON.parse(localStorage.getItem('climbiq.analysisSessions.v1'))[0]");
  if (saved.zones.finishPad?.x1 !== 0.45 || saved.zones.finishPad?.y2 !== 0.12) throw new Error("Pad area was not saved separately.");
  await evaluate("window.__finishReviewReload = true"); await send("Page.reload");
  await until("!window.__finishReviewReload && Boolean(document.querySelector('input[accept=\"video/*\"]'))", "reload");
  await upload("IMG_9199.MOV");
  await evaluate(`(() => { const s = document.querySelector('.session-load-row select'); s.value = ${JSON.stringify(saved.id)}; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`${button("Review finish / mark pad")} && !${button("Review finish / mark pad")}.disabled`, "restored session");
  await click("Review finish / mark pad"); await until(ready, "restored pad region");
  report.padAreaSurvivesReload = true;
  await evaluate(`(() => { const create = URL.createObjectURL; URL.createObjectURL = function(blob) {
    if (blob.type === 'application/json') window.__finishDataset = blob.text(); return create.call(this, blob); }; })()`);
  await click("Download data");
  const exported = await evaluate("(async () => JSON.parse(await window.__finishDataset))()");
  if (exported.zones.finishPadZone?.x1 !== 0.45 || exported.zones.finishPadZone?.y2 !== 0.12) throw new Error("Dataset export lost the separate pad area.");
  report.datasetPadAreaPreserved = true;
  await evaluate(`(() => { const input = document.querySelector('input[accept="application/json,.json"]'); const files = new DataTransfer();
    files.items.add(new File([${JSON.stringify(JSON.stringify(exported))}], 'finish-review.json', {type:'application/json'}));
    input.files = files.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`!document.querySelector('[data-finish-review-tools]') && ${button("Review finish / mark pad")} && !${button("Review finish / mark pad")}.disabled`, "dataset import");
  await click("Review finish / mark pad"); await until(ready, "imported pad area");
  report.datasetPadAreaImported = true;
  await evaluate("document.querySelector('.timestamp-review-actions .primary').click()");
  await click("Save Session");
  const reviewed = await evaluate("JSON.parse(localStorage.getItem('climbiq.analysisSessions.v1'))[0].timestamps.find(m => m.id === 'finishPad')");
  if (reviewed.acceptanceMode !== "frame-review" || !reviewed.note.includes("user-marked finish-pad area")) throw new Error("Manual acceptance lost pad-review provenance.");
  report.explicitAcceptanceProvenance = true;
  await upload("IMG_9076.MOV");
  if (await evaluate("Boolean(document.querySelector('[data-finish-review-tools]'))")) throw new Error("Old finish review leaked to a replacement video.");
  await click("Save Session");
  if (await evaluate("Boolean(JSON.parse(localStorage.getItem('climbiq.analysisSessions.v1'))[0].zones.finishPad)")) throw new Error("Pad area leaked to a different video.");
  report.replacementClearsPadArea = true;
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join(', ')}`);
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally { await closeTestBrowser(chrome, send); socket?.close(); chrome.kill(); console.log(JSON.stringify(report, null, 2)); }
