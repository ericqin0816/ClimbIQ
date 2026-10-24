import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";

test("indicator tracking retains its marking frame or explains a missing native interval", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  const file = path.resolve("e2e/fixtures/tracked-finish-pan.mp4");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true, anchorCursor: 7, authoredIndicatorTransition: 7 });
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  const seek = async (time: number) => {
    await page.getByRole("button", { name: "Jump to time", exact: true }).click();
    const field = page.getByLabel("Raw video time (seconds)", { exact: true });
    await field.fill(String(time));
    await field.press("Enter");
  };
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  await seek(reference.authoredStart);
  const start = page.getByRole("button", { name: /^Accept start at 2\.400s/ });
  await expect(start).toBeEnabled();
  await start.click();
  await page.getByRole("button", { name: "Review finish", exact: true }).click();
  await seek(reference.anchorCursor);
  const nativeInterval = await page.locator("#video-review video").evaluate(element => {
    const frame = new VideoFrame(element as HTMLVideoElement);
    try { return { timestamp: frame.timestamp, duration: frame.duration }; }
    finally { frame.close(); }
  });
  if (testInfo.project.name.startsWith("chromium")) expect(nativeInterval.duration).toBeGreaterThan(0);
  await testInfo.attach("marking-frame-native-interval-capability", { body: JSON.stringify(nativeInterval), contentType: "application/json" });
  const panel = page.locator("[data-finish-review-tools]");
  await panel.getByRole("button", { name: "Mark finish indicator", exact: true }).click();
  await expect(panel).toContainText("Frame: 7.000s");
  const zone = reference.anchorIndicatorRegion;
  for (const [label, coordinate] of [["Left %", zone.x1], ["Top %", zone.y1], ["Right %", zone.x2], ["Bottom %", zone.y2]] as const) {
    await panel.getByLabel(label, { exact: true }).fill(String(coordinate * 100));
  }
  // This live frame no longer contains the same pixel rectangle as the marking
  // snapshot. Apply must retain7s pixels/sourcePTS, not silently recapture9s.
  await seek(9);
  await expect(panel).toContainText("Frame: 7.000s");
  await panel.getByRole("button", { name: "Use this indicator area", exact: true }).click();
  const track = panel.getByRole("button", { name: "Track marked indicator", exact: true });
  if (nativeInterval.duration === null) {
    // WebKit CI exposes a cursor-valued timestamp and no native duration.
    // Assert the actual supported fallback, never invent a30fps interval.
    await expect(track).toBeDisabled();
    await expect(panel).toContainText("Frame tracking is unavailable here");
    await expect(panel.locator("[data-guided-indicator-result]")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Scan marked indicator", exact: true })).toBeEnabled();
  } else {
    await expect(panel).toContainText("Tracking starts from your marking frame at 7.000s");
    await expect(track).toBeEnabled();
    await track.click();
    const result = panel.locator("[data-guided-indicator-result]");
    await expect(result).toContainText("No timing was accepted by this scan", { timeout: 90_000 });
    await expect(result.locator("[data-tracked-indicator-status]")).toContainText("Full review window tracked");
    const inspect = result.getByRole("button", { name: /^Inspect unverified indicator candidate at/ });
    await expect(inspect).toBeEnabled();
    const candidate = Number((await inspect.textContent())!.match(/at ([\d.]+)s/)![1]);
    expect(Math.abs(candidate - reference.authoredIndicatorTransition)).toBeLessThanOrEqual(1 / reference.fps + .001);
    // Inspection moves only the video. Before that, the9s cursor is restored.
    const video = page.locator("#video-review video");
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(9, 2);
    await expect(panel).toContainText("This frame is outside the tracked observations");
    await expect(panel.locator("figure.finish-closeup")).toHaveCount(0);
    await inspect.click();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(candidate, 2);
    await expect(panel.locator('[data-tracked-closeup="true"]')).toContainText("7.000s");
    await testInfo.attach("tracked-indicator-review", { body: await panel.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const dataset = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(dataset.zones.finishIndicatorZone).toMatchObject({ id: "finishIndicator", x1: zone.x1, y1: zone.y1, x2: zone.x2, y2: zone.y2 });
  expect(dataset.zones.finishPadZone).toBeNull();
  expect(dataset.zones.finishLightZone).toBeNull();
  expect(dataset.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal")).toMatchObject({ source: "Manual", acceptedRawTime: 2.4 });
  expect(dataset.acceptedTimestamps.find((marker: any) => marker.markerId === "finishPad").acceptedRawTime).toBeNull();
  await testInfo.attach("tracked-review-only-dataset", { body: JSON.stringify(dataset, null, 2), contentType: "application/json" });
});
