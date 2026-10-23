import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const reportPath = option("report") ?? "test-results/detector-ten/sampling-new-run.json";
const manifestPath = path.resolve(option("manifest") ?? "test-results/detector-ten/development.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(Array.isArray(manifest.clips) && manifest.clips.length, "Provide at least one real recording.");
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
await access(reportPath).then(() => { throw new Error("Refusing to overwrite a sampling report."); }, error => { if (error.code !== "ENOENT") throw error; });
const baselineRef = option("baseline") ?? "90f645c";
const baseline = execFileSync("git", ["show", `${baselineRef}:src/lib/videoFrameSampler.ts`], { encoding: "utf8" });
const candidate = await readFile("src/lib/videoFrameSampler.ts", "utf8");
const bundle = async (contents, globalName) => (await build({ stdin: { contents, loader: "ts" }, bundle: true, write: false, format: "iife", globalName })).outputFiles[0].text;
const owner = await startTestBrowser({ label: "roi-pixels" });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const report = { scope: "Native paused source frames; exact ROI bytes and isolated readback CPU. Transparent canvas is a synthetic compositing control, not human accuracy evidence.", baselineRef, originalSourceSha256: sha256(baseline), candidateSourceSha256: sha256(candidate), browser: browser.version(), rows: [] };
try {
  const page = await browser.newPage();
  await page.goto(option("url") ?? "http://127.0.0.1:5192/");
  await page.evaluate(() => { document.body.replaceChildren(); const input = document.createElement("input"); input.type = "file"; document.body.append(input); const video = document.createElement("video"); video.muted = true; video.preload = "auto"; document.body.append(video); });
  await page.addScriptTag({ content: await bundle(baseline, "OriginalSampler") });
  await page.addScriptTag({ content: await bundle(candidate, "CandidateSampler") });
  const files = manifest.clips.map(clip => path.resolve(path.dirname(manifestPath), clip.file));
  for (const file of files) {
    const sourceSha256 = sha256(await readFile(file));
    await page.locator("input").setInputFiles(file);
    await page.evaluate(async () => { const video = document.querySelector("video"); if (video.src) URL.revokeObjectURL(video.src); video.src = URL.createObjectURL(document.querySelector("input").files[0]); await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; }); });
    for (const time of [1, 4, 8]) {
      const row = await page.evaluate(async ({ file, time }) => {
        const video = document.querySelector("video"); await OriginalSampler.seekTo(video, time, { exact: true });
        const zones = [[.1, .1, .12, .12], [.2, .3, .35, .5], [.4, .2, .5, .35]];
        const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; };
        const rows = [];
        for (const [x1, y1, x2, y2] of zones) {
          const zone = { id: "startLight", label: "Probe", x1, y1, x2, y2 };
          const a = OriginalSampler.captureZoneImageData(video, zone), b = CandidateSampler.captureZoneImageData(video, zone);
          const equal = a.imageData.data.length === b.imageData.data.length && a.imageData.data.every((value, index) => value === b.imageData.data[index]);
          if (!equal) throw new Error("Actual source pixel mismatch");
          const timing = { baseline: [], candidate: [] };
          for (let repeat = 0; repeat < 10; repeat++) for (const name of repeat % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
            const sampler = name === "baseline" ? OriginalSampler : CandidateSampler;
            const started = performance.now(); for (let iteration = 0; iteration < 24; iteration++) sampler.captureZoneImageData(video, zone);
            if (repeat >= 2) timing[name].push((performance.now() - started) / 24);
          }
          const counts = {}; const create = document.createElement;
          for (const name of ["baseline", "candidate"]) {
            let canvases = 0; document.createElement = function(tag, ...args) { if (tag === "canvas") canvases++; return create.call(this, tag, ...args); };
            try { for (let i = 0; i < 24; i++) (name === "baseline" ? OriginalSampler : CandidateSampler).captureZoneImageData(video, zone); } finally { document.createElement = create; }
            counts[name] = canvases;
          }
          rows.push({ pixelZone: a.pixelZone, exactByteParity: equal, baselineMedianMs: median(timing.baseline), candidateMedianMs: median(timing.candidate), timing, canvasAllocationsPer24Calls: counts });
        }
        return { file: file.split("/").at(-1), time, rows };
      }, { file: path.basename(file), time });
      row.sourceSha256 = sourceSha256;
      report.rows.push(row);
    }
  }
  report.transparency = await page.evaluate(() => {
    const source = document.createElement("canvas"); source.width = 20; source.height = 20;
    Object.defineProperties(source, { videoWidth: { get: () => source.width }, videoHeight: { get: () => source.height } });
    const context = source.getContext("2d"), zone = { id: "startLight", label: "Alpha", x1: 0, y1: 0, x2: 1, y2: 1 };
    const cases = [];
    for (let i = 0; i < 4; i++) {
      if (i === 2) { source.width = 13; source.height = 9; }
      context.clearRect(0, 0, source.width, source.height); context.fillStyle = i % 2 ? "rgba(0,0,255,0.25)" : "red"; context.fillRect(0, 0, source.width / (i % 2 ? 2 : 1), source.height);
      const a = OriginalSampler.captureZoneImageData(source, zone), b = CandidateSampler.captureZoneImageData(source, zone);
      const equal = a.imageData.data.every((value, index) => value === b.imageData.data[index]);
      if (!equal) throw new Error("Transparent or resized sample retained previous pixels"); cases.push({ width: source.width, height: source.height, equal });
    }
    return cases;
  });
  report.passed = true;
} finally {
  try { await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); }
  finally { try { await browser.close(); } finally { await owner.close(); } }
}
console.log(JSON.stringify({ passed: report.passed, rows: report.rows.length, transparency: report.transparency, medians: report.rows.map(row => ({ file: row.file, time: row.time, pairs: row.rows.map(v => [v.baselineMedianMs, v.candidateMedianMs]) })) }));
