import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

// Strict production-worker plumbing check. The frames are synthetic blank
// canvases; an array response proves execution, never pose/timing accuracy.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const match = /^--(build-dir|url|report)(?:=(.*))?$/.exec(process.argv[index]);
  if (!match) throw new Error("Usage: node e2e/pose-worker-build-smoke.mjs [--build-dir dist] [--url http://127.0.0.1:4173/] [--report path.json]");
  const value = match[2] ?? process.argv[++index];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${match[1]} value.`);
  options[match[1]] = value;
}
const buildDir = path.resolve(root, options["build-dir"] ?? "dist");
const reportPath = path.resolve(root, options.report ?? `test-results/pose-worker-build-smoke-${Date.now()}.json`);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const buildOrigin = "http://climbiq-build.invalid/";

function buildPath(publicUrl) {
  const url = new URL(publicUrl, buildOrigin);
  if (url.origin !== new URL(buildOrigin).origin) throw new Error("Worker smoke requires locally bundled assets.");
  const resolved = path.resolve(buildDir, `.${decodeURIComponent(url.pathname)}`);
  const relative = path.relative(buildDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Built asset points outside the selected build directory.");
  return resolved;
}

const html = await readFile(path.join(buildDir, "index.html"));
const scripts = [...html.toString().matchAll(/<script\b([^>]*)>/g)].flatMap(([, attributes]) => {
  if (!/\btype=["']module["']/.test(attributes)) return [];
  const src = /\bsrc=["']([^"']+)["']/.exec(attributes)?.[1];
  return src ? [new URL(src, buildOrigin)] : [];
});
if (!scripts.length) throw new Error("No built module entry in index.html. Run npm run build first.");

// Follow actual ESM entry/import edges, then require a Worker constructor in a
// reachable module. Merely finding an old worker filename somewhere in dist is
// not sufficient evidence that the current application references it.
const queue = [...scripts], visited = new Map();
let workerReference;
while (queue.length) {
  const url = queue.shift();
  if (visited.has(url.href)) continue;
  if (visited.size >= 64) throw new Error("Unexpectedly large built module graph; inspect the smoke-test entry traversal.");
  const bytes = await readFile(buildPath(url));
  const source = bytes.toString();
  visited.set(url.href, { bytes, url });
  for (const match of source.matchAll(/new\s+Worker\(\s*new\s+URL\(\s*["']([^"']+)["']/g)) {
    const candidate = new URL(match[1], url);
    if (/\/poseInference\.worker-[^/]+\.js$/.test(candidate.pathname)) workerReference = { url: candidate, importer: url };
  }
  for (const match of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+\.js(?:\?[^"']*)?)["']/g)) {
    const imported = new URL(match[1], url);
    if (imported.origin === new URL(buildOrigin).origin) queue.push(imported);
  }
}
if (!workerReference) throw new Error("No emitted pose worker constructor is reachable from the built app entry.");
const workerBytes = await readFile(buildPath(workerReference.url));
const modelPath = "/models/pose_landmarker_full.task";
const modelBytes = await readFile(buildPath(modelPath));
const wasmPaths = ["/mediapipe/wasm/vision_wasm_module_internal.js", "/mediapipe/wasm/vision_wasm_module_internal.wasm"];
const wasmAssets = await Promise.all(wasmPaths.map(async publicPath => ({ publicPath, bytes: await readFile(buildPath(publicPath)) })));

let previewServer, chrome, socket, send, temporaryRoot, spawnError;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  let appUrl = options.url;
  if (!appUrl) {
    previewServer = await preview({ root, configFile: false, logLevel: "error", build: { outDir: buildDir }, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
    const address = previewServer.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Could not discover the owned preview server's ephemeral port.");
    appUrl = `http://127.0.0.1:${address.port}/`;
  }
  const origin = new URL(appUrl);
  if (!/^https?:$/.test(origin.protocol)) throw new Error("Preview URL must use HTTP or HTTPS.");
  const assets = [
    { url: appUrl, bytes: html },
    ...[...visited.values()].map(item => ({ url: new URL(item.url.pathname, origin).href, bytes: item.bytes })),
    { url: new URL(workerReference.url.pathname, origin).href, bytes: workerBytes },
    { url: new URL(modelPath, origin).href, bytes: modelBytes },
    ...wasmAssets.map(item => ({ url: new URL(item.publicPath, origin).href, bytes: item.bytes })),
  ];
  for (const asset of assets) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || digest(new Uint8Array(await response.arrayBuffer())) !== digest(asset.bytes)) {
      throw new Error(`Preview does not serve the selected build asset: ${new URL(asset.url).pathname}`);
    }
  }

  temporaryRoot = await mkdtemp(path.join(tmpdir(), "climbiq-worker-smoke-"));
  const profile = path.join(temporaryRoot, "profile");
  const chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
  chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  chrome.once("error", error => { spawnError = error; });
  let port;
  for (let index = 0; index < 100; index++) {
    if (spawnError) throw spawnError;
    try {
      const candidate = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
      if (Number.isInteger(candidate) && candidate > 0 && (await fetch(`http://127.0.0.1:${candidate}/json/version`)).ok) { port = candidate; break; }
    } catch { /* owned browser is still starting */ }
    await delay(100);
  }
  if (!port) throw new Error("Could not discover the owned browser's ephemeral debugger port.");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  ({ send } = createProtocolClient(socket, { timeoutMs: 60000 }));
  await send("Runtime.enable");
  let pageReady = false;
  for (let index = 0; index < 100; index++) {
    try {
      const readiness = await send("Runtime.evaluate", { expression: `location.origin === ${JSON.stringify(origin.origin)} && document.readyState === 'complete'`, returnByValue: true });
      if (readiness.result?.value === true) { pageReady = true; break; }
    } catch (error) {
      if (!/context|navigat/i.test(String(error))) throw error;
    }
    await delay(100);
  }
  if (!pageReady) throw new Error("Built app document did not finish loading at the selected preview origin.");
  const browser = await send("Browser.getVersion");
  const result = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const workerUrl=${JSON.stringify(new URL(workerReference.url.pathname, origin).href)};
    const modelUrl=${JSON.stringify(new URL(modelPath, origin).href)};
    const wasmBase=${JSON.stringify(new URL("/mediapipe/wasm", origin).href)};
    const response=await fetch(modelUrl);if(!response.ok)throw new Error('Packaged model fetch failed.');
    const buffer=await response.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
    if(buffer.byteLength!==${modelBytes.byteLength} || hash!==${JSON.stringify(digest(modelBytes))})throw new Error('Browser received a different model.');
    const worker=new Worker(workerUrl,{type:'module'});const lifecycle={created:1,terminated:0};
    const pending=new Map();let sequence=0,failure;
    const fail=error=>{failure=error;for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();};
    worker.onerror=event=>{event.preventDefault();fail(new Error(event.message||'Production worker failed.'));};
    worker.onmessageerror=()=>fail(new Error('Production worker message could not be decoded.'));
    worker.onmessage=event=>{const waiter=pending.get(event.data?.id);if(!waiter)return;pending.delete(event.data.id);clearTimeout(waiter.timer);event.data.kind==='error'?waiter.reject(new Error(event.data.message)):waiter.resolve(event.data);};
    const request=(data,transfer=[])=>new Promise((resolve,reject)=>{
      if(failure)return reject(failure);const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Production worker timed out.'));},20000);
      pending.set(id,{resolve,reject,timer});try{worker.postMessage({...data,id},transfer);}catch(error){fail(error);}
    });
    try{
      const started=performance.now();const ready=await request({kind:'initialize',model:new Uint8Array(buffer),wasmBase},[buffer]);
      if(ready.kind!=='ready')throw new Error('Unexpected initialization reply.');
      const initializedMs=performance.now()-started;
      const canvas=document.createElement('canvas');canvas.width=192;canvas.height=256;
      const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('Synthetic canvas unavailable.');
      context.fillStyle='#808080';context.fillRect(0,0,canvas.width,canvas.height);
      const frames=[];
      for(const timestamp of [1000,1200]){
        const image=await createImageBitmap(canvas);
        try{const reply=await request({kind:'detect',image,timestamp},[image]);
          if(reply.kind!=='landmarks'||!Array.isArray(reply.landmarks)||reply.landmarks.some(points=>!Array.isArray(points)))throw new Error('Unexpected frame reply.');
          frames.push({timestamp,landmarkSets:reply.landmarks.length});
        }finally{image.close();}
      }
      return {backend:'worker',initializedMs,frames,lifecycle};
    }finally{for(const waiter of pending.values())clearTimeout(waiter.timer);pending.clear();worker.terminate();lifecycle.terminated++;}
  })()` });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  if (result.result.value?.lifecycle?.terminated !== 1) throw new Error("Synthetic worker was not terminated.");
  const report = { passed: true, syntheticOnly: true, accuracyClaim: false, browser: browser.product,
    previewOwnership: previewServer ? "owned-ephemeral-port" : "provided-url-verified-against-build",
    appUrl, workerAsset: workerReference.url.pathname, importer: workerReference.importer.pathname,
    workerSha256: digest(workerBytes), modelSha256: digest(modelBytes), verifiedAssetCount: assets.length, ...result.result.value };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (chrome && !spawnError) await closeTestBrowser(chrome, send);
  socket?.close();
  await previewServer?.close();
  if (temporaryRoot) {
    const cleanupPath = path.resolve(temporaryRoot);
    if (path.dirname(cleanupPath) !== path.resolve(tmpdir()) || !path.basename(cleanupPath).startsWith("climbiq-worker-smoke-")) throw new Error("Refusing to remove a directory outside this test's temporary root.");
    await rm(cleanupPath, { recursive: true, force: true, maxRetries: 3 }).catch(error => console.warn(`Could not remove owned temporary browser profile: ${error.code}`));
  }
}
