import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";
import { readSessionLibraryJson } from "./session-library.mjs";

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const appUrl = argument("url") ?? "http://127.0.0.1:5190/";
const file = path.resolve(argument("file") ?? "");
const reportPath = path.resolve(argument("report") ?? "test-results/practical-evidence/manual-jump.json");
const requestedCursor = Number(argument("cursor") ?? "7.4");
const heights = (argument("heights") ?? "568,740").split(",").map(Number);
const finishAndSave = process.argv.includes("--finish-and-save");
const pendingJump = process.argv.includes("--pending-jump");
const exerciseStepCursor = process.argv.includes("--step-cursor");
const finishCursor = Number(argument("finish") ?? "14.2");
const expectedFrameInterval = argument("expected-frame-interval") === undefined ? null : Number(argument("expected-frame-interval"));
assert.ok(argument("file"), "Supply an actual local recording with --file.");
assert.ok(Number.isFinite(requestedCursor) && requestedCursor >= 0);
assert.ok(heights.every(height => Number.isInteger(height) && height >= 400));
assert.ok(expectedFrameInterval === null || (finishAndSave && Number.isFinite(expectedFrameInterval) && expectedFrameInterval > 0), "Expected frame interval requires --finish-and-save and a positive value.");
await access(file);
await access(reportPath).then(() => { throw new Error(`Refusing to overwrite ${reportPath}`); }, error => { if (error.code !== "ENOENT") throw error; });
await mkdir(path.dirname(reportPath), { recursive: true });
const directory = reportPath.slice(0, -path.extname(reportPath).length);
await mkdir(directory, { recursive: true });
const report = {
  scope: finishAndSave
    ? "Real-file manual frame acceptance and saving at supplied operational cursors, not independent event labels. No detector inference, human search time, event accuracy or training decision is measured."
    : "Real-file native manual-review navigation. Supplied cursor is an operational input, not an event label. No detector inference, event acceptance, human search time, or training decision is measured.",
  appUrl, fileName: path.basename(file), sourceSha256: createHash("sha256").update(await readFile(file)).digest("hex"), requestedCursor,
  finishAndSave, exerciseStepCursor, pendingJump, expectedFrameInterval,
  cases: [],
};
let owner, browser, page;
const geometry = async page => page.evaluate(() => {
  const rect = node => { const value = node?.getBoundingClientRect(); return value ? { top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null; };
  return {
    frame: rect(document.querySelector("#video-review video")), nav: rect(document.querySelector(".mobile-workflow")),
    seekToggle: rect(document.querySelector(".review-seek-toggle")),
    actions: [...document.querySelectorAll(".timestamp-review-actions button")].map(node => ({ text: node.textContent, ...rect(node) })),
  };
});
const assertGeometry = value => {
  assert.ok(value.frame.top >= 0 && value.frame.bottom <= value.nav.top, "The source frame stays visible above navigation.");
  for (const button of [...value.actions, value.seekToggle]) {
    assert.ok(button.height >= 44 && button.width >= 44, "Review actions retain 44px touch targets.");
    assert.ok(button.top >= 0 && button.bottom <= value.nav.top, "Closed review actions stay above fixed navigation.");
  }
};
try {
  owner = await startTestBrowser({ label: "practical-evidence" });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`);
  report.browser = await browser.version();
  for (const height of heights) {
    const context = await browser.newContext({ viewport: { width: 320, height }, reducedMotion: "reduce" });
    page = await context.newPage();
    const item = { height, taskActions: [], validationActions: [], errors: [] };
    report.cases.push(item);
    page.on("pageerror", error => item.errors.push(error.message));
    const action = async (name, run, validation = false) => { (validation ? item.validationActions : item.taskActions).push(name); await run(); };
    await page.goto(appUrl);
    item.build = await (await page.request.get(new URL("build-info.json", appUrl).href)).json();
    await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
    await action("Import recording", () => page.locator(".upload-dropzone input[type=file]").setInputFiles(file));
    await expect(page.locator(".upload-dropzone strong")).toHaveText(path.basename(file));
    await expect(page.locator(".video-meta-line")).toContainText("Ready");
    const opener = page.getByRole("button", { name: "Review timing manually", exact: true });
    await action("Open manual Start review", () => opener.click());
    await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
    item.before = await geometry(page); assertGeometry(item.before);
    await page.screenshot({ path: path.join(directory, `closed-${height}.png`) });
    const toggle = page.getByRole("button", { name: "Jump to time", exact: true });
    await action("Open precise time navigation", () => toggle.click());
    const input = page.getByRole("textbox", { name: "Raw video time (seconds)", exact: true });
    await expect(input).toBeFocused();
    for (const value of ["", "-1", "NaN", "Infinity"]) {
      await action(`Reject invalid cursor ${JSON.stringify(value)}`, () => input.fill(value), true);
      await expect(page.locator(".review-seek-form").getByRole("button", { name: "Jump", exact: true })).toBeDisabled();
    }
    await action("Enter operational cursor", () => input.fill(String(exerciseStepCursor ? requestedCursor - .8 : requestedCursor)));
    if (pendingJump) {
      await action("Make the displayed frame unready with native playback", () => page.getByRole("button", { name: "Play / pause", exact: true }).click(), true);
      await expect(page.locator(".timestamp-review-actions .primary")).toHaveText("Pause and wait for the frame");
      await expect(page.locator(".review-seek-form button")).toBeDisabled();
      await action("Attempt Enter while the frame is not ready", () => input.press("Enter"), true);
      await expect(input).toBeVisible();
      await expect(input).toHaveValue(String(requestedCursor));
      await action("Pause to restore native review readiness", () => page.getByRole("button", { name: "Play / pause", exact: true }).click(), true);
      await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
      await expect(page.locator(".review-seek-form button")).toBeEnabled();
      await expect(input).toHaveValue(String(requestedCursor));
      item.notReadyInputPreservedUntilPause = true;
    }
    await action("Jump with Enter", () => input.press("Enter"));
    await expect(input).toHaveCount(0);
    await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
    if (exerciseStepCursor) for (let step = 0; step < 8; step++) {
      await action("Exercise cursor/frame mismatch using +0.10s", () => page.getByRole("button", { name: "+0.10s", exact: true }).click(), true);
      await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
      await page.waitForTimeout(45);
    }
    await expect.poll(() => page.locator("#video-review video").evaluate(video => video.currentTime)).toBeCloseTo(requestedCursor, 5);
    await expect(page.locator(".review-frame-source")).toHaveAttribute("data-frame-time-source", "presentation");
    if (!exerciseStepCursor) await expect(toggle).toBeFocused();
    item.after = await geometry(page); assertGeometry(item.after);
    item.nativeReview = await page.locator(".timestamp-review").innerText();
    item.startRawValue = await page.getByLabel("Start Signal raw video time", { exact: true }).inputValue();
    assert.equal(item.startRawValue, "", "Navigation must not accept a marker.");
    item.nativeCursor = await page.locator("#video-review video").evaluate(video => ({ currentTime: video.currentTime, paused: video.paused, seeking: video.seeking }));
    await page.screenshot({ path: path.join(directory, `jumped-${height}.png`) });
    if (finishAndSave) {
      const library = async () => JSON.parse(await readSessionLibraryJson(expression => page.evaluate(expression)));
      item.acceptedStart = Number((await page.locator(".timestamp-review-actions .primary").innerText()).match(/at ([\d.]+)s$/)?.[1]);
      assert.ok(Number.isFinite(item.acceptedStart));
      await action("Accept operational native Start frame", () => page.locator(".timestamp-review-actions .primary").click());
      await expect(page.locator(".timestamp-review")).toHaveCount(0);
      const finishOpener = page.getByRole("button", { name: "Review finish", exact: true });
      await action("Open guided manual Finish", () => finishOpener.click());
      await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
      await expect(page.locator(".timestamp-review")).toContainText("Starting cursor");
      await expect(page.locator(".timestamp-review")).not.toContainText("Suggested");
      await expect(page.locator(".timestamp-review .review-confidence")).toHaveCount(0);
      await expect(page.locator("#timestamp-review-instruction")).toContainText("leave Finish unset");
      item.initialFinishCursor = await page.locator("#video-review video").evaluate(video => video.currentTime);
      assert.ok(item.initialFinishCursor > item.acceptedStart + 1, "The same Start frame must not be reused as Finish navigation.");
      item.finishGeometry = await geometry(page); assertGeometry(item.finishGeometry);
      await page.screenshot({ path: path.join(directory, `manual-finish-${height}.png`) });
      await action("Close Finish without accepting", () => page.getByRole("button", { name: "Close review", exact: true }).click(), true);
      assert.equal(await page.getByLabel("Finish Pad raw video time", { exact: true }).inputValue(), "");
      await expect(finishOpener).toBeFocused();
      await action("Reopen manual Finish after close validation", () => finishOpener.click(), true);
      await action("Open precise Finish navigation", () => page.getByRole("button", { name: "Jump to time", exact: true }).click());
      await action("Enter operational Finish cursor", () => page.getByRole("textbox", { name: "Raw video time (seconds)", exact: true }).fill(String(finishCursor)));
      await action("Jump to operational Finish", () => page.getByRole("textbox", { name: "Raw video time (seconds)", exact: true }).press("Enter"));
      await expect(page.locator(".timestamp-review-actions .primary")).toBeEnabled();
      await action("Accept operational native Finish frame", () => page.locator(".timestamp-review-actions .primary").click());
      await expect(page.locator(".timestamp-review")).toHaveCount(0);
      await action("Follow Save this attempt", () => page.getByRole("link", { name: "Save this attempt", exact: true }).click());
      await action("Save manually reviewed attempt", () => page.getByRole("button", { name: "Save Session", exact: true }).click());
      await expect.poll(async () => (await library()).length).toBe(1);
      const saved = (await library())[0];
      item.savedMarkers = saved.timestamps.filter(marker => ["startSignal", "finishPad", "hold10"].includes(marker.id));
      const finish = item.savedMarkers.find(marker => marker.id === "finishPad");
      assert.ok(finish.rawTime > item.acceptedStart);
      assert.equal(finish.source, "Manual");
      assert.equal(finish.confidence, "Medium");
      assert.equal(finish.acceptanceMode, "frame-review");
      // The shared manual policy stores the accepted native frame in this
      // legacy field. It must not record the unverified initial cursor instead.
      assert.equal(finish.detectedRawTime, finish.rawTime);
      assert.notEqual(finish.detectedRawTime, item.initialFinishCursor);
      assert.equal(finish.offsetApplied, 0);
      assert.equal(item.savedMarkers.find(marker => marker.id === "startSignal").rawTime, item.acceptedStart);
      if (expectedFrameInterval !== null) for (const id of ["startSignal", "finishPad"]) {
        const marker = item.savedMarkers.find(item => item.id === id);
        assert.ok(typeof marker.observationIntervalSeconds === "number" &&
          Math.abs(marker.observationIntervalSeconds - expectedFrameInterval) < .000001,
        `Saved ${id} must retain the native source frame interval, not an event-error bound.`);
      }
      assert.equal(item.savedMarkers.find(marker => marker.id === "hold10").rawTime, null);
      await expect(page.locator(".next-step-card")).toContainText("Saved on this device");
      await page.screenshot({ path: path.join(directory, `saved-${height}.png`) });
    } else {
      await action("Close review without accepting", () => page.getByRole("button", { name: "Close review", exact: true }).click(), true);
      await expect(opener).toBeFocused();
    }
    item.taskActionCount = item.taskActions.length;
    item.validationActionCount = item.validationActions.length;
    assert.deepEqual(item.errors, []);
    item.passed = true;
    await context.close();
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error.stack ?? error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(directory, "failure.png") }).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (owner) await owner.close().catch(error => { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ passed: report.passed, error: report.error, cases: report.cases.map(({ height, passed, taskActionCount }) => ({ height, passed, taskActionCount })) }));
}
