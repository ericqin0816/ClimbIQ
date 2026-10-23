import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";

const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const file = option("video"), expectedSha = option("sha"), output = option("output");
const start = Number(option("start")), lane = Number(option("lane"));
if (!file || !expectedSha || !output || !Number.isFinite(start) || start < 0 || !(lane > 0 && lane < 1)) throw new Error("Supply --video= --sha= --output= --start=<reviewed source seconds> --lane=<reviewed horizontal position>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (hash(await readFile(file)) !== expectedSha) throw new Error("Frozen source hash changed");
const report = { schemaVersion: 1, sourceSha256: expectedSha, fileName: path.basename(file),
  interpretation: "Native detector-component experiment conditioned on a manually supplied Start cursor and lane position. No automatic athlete identity, Start recovery, electronic timing or whole-app acceptance claim.",
  suppliedStartSeconds: start, suppliedLaneX: lane,
  detectorSha256: hash((await readFile("src/lib/detectTopFinishSignal.ts", "utf8")).replace(/\r\n/g, "\n")), errors: [] };
let owner, browser;
try {
  owner = await startTestBrowser({ label: "finish-indicator-probe" });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`);
  report.browser = browser.version();
  const page = await browser.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(option("url") ?? "http://127.0.0.1:5173/");
  await page.evaluate(() => { document.body.replaceChildren(); const input = document.createElement("input"); input.type = "file"; document.body.append(input); });
  await page.locator("input").setInputFiles(file);
  report.outcome = await page.evaluate(async ({ start, lane }) => {
    const { detectTopFinishSignal } = await import("/src/lib/detectTopFinishSignal.ts");
    const video = document.createElement("video"); video.muted = true; video.playsInline = true; document.body.append(video);
    const url = URL.createObjectURL(document.querySelector("input").files[0]);
    try {
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Video decode failed")); video.src = url; });
      const began = performance.now();
      const result = await detectTopFinishSignal({ video, startSignalRawTime: start,
        laneHintZone: { id: "startLight", label: "Explicit research lane", x1: Math.max(0, lane - .01), x2: Math.min(1, lane + .01), y1: .7, y2: .72 } });
      return { metadata: { duration: video.duration, width: video.videoWidth, height: video.videoHeight }, elapsedMs: performance.now() - began, ...result };
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  }, { start, lane });
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally {
  try { await browser?.close(); } finally { await owner?.close(); }
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ output, errors: report.errors, detected: report.outcome?.result.detected, time: report.outcome?.result.rawTime, confidence: report.outcome?.result.confidence }));
