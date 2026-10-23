import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";

// Measure the actual shipped detector workflow. Imported files and downloaded
// datasets remain local; automatic acceptance is never an independent label.
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = path.resolve(option("manifest") ?? "test-results/detector-ten/development.json");
const output = path.resolve(option("report") ?? "test-results/detector-ten/run.json");
const appUrl = option("url") ?? "http://127.0.0.1:5190/";
const scope = option("scope") ?? "timing-only";
const repeats = Number(option("repeats") ?? 1);
assert.ok(["full", "timing-only"].includes(scope));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(Array.isArray(manifest.clips) && manifest.clips.length);
await mkdir(path.dirname(output), { recursive: true });
await access(output).then(() => { throw new Error("Refusing to overwrite an existing detector report."); }, error => { if (error.code !== "ENOENT") throw error; });
const directory = output.slice(0, -path.extname(output).length);
await mkdir(directory, { recursive: true });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), appUrl, scope, repeats,
  interpretation: "Actual local browser workflow. Coverage and processing latency are not timing correctness. Polling resolution approximately 100 ms. Each run uses fresh browser storage. Development/held-out assignment is supplied by the operator, not attested by this tool.",
  outcomes: [], pageErrors: [], policyViolations: [] };
let owner, browser;
try {
  const identity = await fetch(new URL("build-info.json", appUrl));
  report.build = identity.ok && identity.headers.get("content-type")?.includes("json") ? await identity.json() : null;
  owner = await startTestBrowser({ label: "detector-workflow", args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`);
  report.browser = browser.version();
  for (let repeat = 1; repeat <= repeats; repeat++) for (const clip of manifest.clips) {
    const file = path.resolve(path.dirname(manifestPath), clip.file);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sourceSha256 = hash.digest("hex");
    if (clip.sha256) assert.equal(sourceSha256, clip.sha256, "Source changed since manifest freeze.");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const outcome = { id: clip.id, cohort: clip.cohort, repeat, fileName: path.basename(file), sourceSha256, stages: [], isGroundTruthLabel: false };
    report.outcomes.push(outcome);
    await context.exposeBinding("__detectorPolicy", (_, message) => report.policyViolations.push({ clip: clip.id, message }));
    await context.addInitScript(() => document.addEventListener("securitypolicyviolation", event => void window.__detectorPolicy(`${event.effectiveDirective}: ${event.blockedURI}`)));
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push({ clip: clip.id, message: error.message }));
    try {
      await page.goto(appUrl);
      await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
      const imported = performance.now();
      await page.locator('.upload-dropzone input[type="file"]').setInputFiles(file);
      await expect(page.locator(".video-meta-line")).toContainText("Ready", { timeout: 25000 });
      outcome.importMs = performance.now() - imported;
      await page.getByLabel("Analysis scope", { exact: true }).selectOption(scope);
      const started = performance.now();
      await page.locator("#upload .analyze-button").click();
      let lastStatus, completed = false;
      while (performance.now() - started < 180000) {
        const state = await page.evaluate(() => {
          const button = document.querySelector("#upload .analyze-button");
          const markers = Object.fromEntries(["Start Signal", "Finish Pad", "Hold 10"].map(label => {
            const row = [...document.querySelectorAll("#timing-markers tbody tr")].find(row => row.firstElementChild?.textContent.trim() === label);
            return [label, row?.querySelectorAll("td")[1]?.textContent.trim() ?? "Not set"];
          }));
          return { running: Boolean(button?.disabled), status: document.querySelector(".quick-analysis-box .status-message")?.textContent.trim() ?? "",
            total: document.querySelector("#results .summary-primary-metric strong")?.textContent.trim() ?? "", markers,
            nextStep: document.querySelector(".next-step-card")?.textContent.trim() ?? "" };
        });
        const elapsedMs = performance.now() - started;
        if (/^\d+\.\d+s$/.test(state.total) && outcome.firstTotalMs === undefined) outcome.firstTotalMs = elapsedMs;
        if (state.status !== lastStatus) { outcome.stages.push({ elapsedMs, status: state.status }); lastStatus = state.status; }
        if (!state.running && elapsedMs > 200) {
          outcome.idleMs = elapsedMs; outcome.firstUsefulTerminalMs = outcome.firstTotalMs ?? elapsedMs;
          outcome.state = state; completed = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(completed, "Detector exceeded the bounded three-minute run.");
      const button = page.getByRole("button", { name: "Download data", exact: true });
      await button.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; });
      const pending = page.waitForEvent("download");
      await button.click();
      const download = await pending;
      const dataset = JSON.parse(await readFile(await download.path(), "utf8"));
      await writeFile(path.join(directory, `${clip.id}-${repeat}-dataset.json`), JSON.stringify(dataset, null, 2) + "\n", { flag: "wx" });
      outcome.accepted = dataset.acceptedTimestamps;
      outcome.automaticEndpointCount = dataset.acceptedTimestamps.filter(marker => ["startSignal", "finishPad"].includes(marker.markerId) && marker.acceptedRawTime !== null && marker.acceptanceMode === "automatic").length;
      outcome.passed = true;
      console.log(JSON.stringify({ id: clip.id, repeat, seconds: +(outcome.firstUsefulTerminalMs / 1000).toFixed(3), automaticEndpoints: outcome.automaticEndpointCount, status: outcome.state.status }));
    } catch (error) {
      outcome.passed = false; outcome.error = String(error); process.exitCode = 1;
      await page.screenshot({ path: path.join(directory, `${clip.id}-${repeat}-failure.png`), fullPage: true }).catch(() => {});
    } finally { await context.close(); }
  }
  report.passed = report.outcomes.every(outcome => outcome.passed) && !report.pageErrors.length && !report.policyViolations.length;
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  try { await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); }
  finally { try { await browser?.close(); } finally { await owner?.close(); } }
}
