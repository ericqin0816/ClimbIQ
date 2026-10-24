import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";

const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const file = option("video"), expectedSha = option("sha"), output = option("output");
const start = Number(option("start")), lane = Number(option("lane"));
const indicator = option("indicator")?.split(",").map(Number);
if (indicator && (indicator.length !== 4 || indicator.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
  indicator[0] >= indicator[2] || indicator[1] >= indicator[3])) throw new Error("--indicator requires normalized x1,y1,x2,y2 inside the image");
const minimum = option("minimum") === undefined ? undefined : Number(option("minimum"));
const maximum = option("maximum") === undefined ? undefined : Number(option("maximum"));
const expectedFinishTime = option("expected") === undefined ? undefined : Number(option("expected"));
if (expectedFinishTime !== undefined && (!Number.isFinite(expectedFinishTime) || expectedFinishTime < 0)) throw new Error("Invalid --expected source time");
if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0) ||
  maximum !== undefined && (!Number.isFinite(maximum) || maximum <= (minimum ?? 3))) throw new Error("Invalid --minimum/--maximum climb-duration window");
if (!file || !expectedSha || !output || !Number.isFinite(start) || start < 0 || !(lane > 0 && lane < 1)) throw new Error("Supply --video= --sha= --output= --start=<reviewed source seconds> --lane=<reviewed horizontal position>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (hash(await readFile(file)) !== expectedSha) throw new Error("Frozen source hash changed");
const report = { schemaVersion: 1, sourceSha256: expectedSha, fileName: path.basename(file),
  interpretation: "Native detector-component experiment conditioned on a manually supplied Start cursor and lane position. No automatic athlete identity, Start recovery, electronic timing or whole-app acceptance claim.",
  suppliedStartSeconds: start, suppliedLaneX: lane,
  suppliedIndicatorRegion: indicator ?? null, suppliedExpectedFinishTime: expectedFinishTime ?? null,
  minimumClimbSeconds: minimum ?? 3, maximumClimbSeconds: maximum ?? 30,
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
  report.outcome = await page.evaluate(async ({ start, lane, indicator, minimum, maximum, expectedFinishTime }) => {
    const { detectTopFinishSignal } = await import("/src/lib/detectTopFinishSignal.ts");
    const video = document.createElement("video"); video.muted = true; video.playsInline = true; document.body.append(video);
    const url = URL.createObjectURL(document.querySelector("input").files[0]);
    try {
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Video decode failed")); video.src = url; });
      const began = performance.now();
      const result = await detectTopFinishSignal({ video, startSignalRawTime: start,
        minimumClimbSeconds: minimum, maximumClimbSeconds: maximum, expectedFinishTime,
        indicatorZone: indicator ? { id: "finishIndicator", label: "Explicit research indicator", x1: indicator[0], y1: indicator[1], x2: indicator[2], y2: indicator[3] } : undefined,
        laneHintZone: { id: "startLight", label: "Explicit research lane", x1: Math.max(0, lane - .01), x2: Math.min(1, lane + .01), y1: .7, y2: .72 } });
      return { metadata: { duration: video.duration, width: video.videoWidth, height: video.videoHeight }, elapsedMs: performance.now() - began, ...result };
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  }, { start, lane, indicator, minimum, maximum, expectedFinishTime });
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally {
  try { await browser?.close(); } finally { await owner?.close(); }
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ output, errors: report.errors, detected: report.outcome?.result.detected, time: report.outcome?.result.rawTime, confidence: report.outcome?.result.confidence }));
