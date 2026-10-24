import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";

test("a marked finish indicator gives review navigation without accepting timing", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  const file = path.resolve("e2e/fixtures/guided-finish-indicator.mp4");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true, authoredFinishIndicator: 7 });
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  const seek = async (time: number) => {
    await page.getByRole("button", { name: "Jump to time", exact: true }).click();
    const field = page.getByLabel("Raw video time (seconds)", { exact: true });
    await field.fill(String(time)); await field.press("Enter");
  };
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  await seek(reference.authoredStart);
  const acceptStart = page.getByRole("button", { name: /^Accept start at 2\.400s/ });
  await expect(acceptStart).toBeEnabled(); await acceptStart.click();
  await page.getByRole("button", { name: "Review finish", exact: true }).click();
  await seek(reference.authoredFinishIndicator);
  const panel = page.locator("[data-finish-review-tools]");
  await expect(panel.getByRole("button", { name: "Mark finish indicator", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Mark finish indicator", exact: true }).click();
  const zone = reference.selectedIndicatorRegion;
  for (const [label, value] of [["Left %", zone.x1], ["Top %", zone.y1], ["Right %", zone.x2], ["Bottom %", zone.y2]] as const) {
    await panel.getByLabel(label, { exact: true }).fill(String(value * 100));
  }
  await panel.getByRole("button", { name: "Use this indicator area", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Scan marked indicator", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Scan marked indicator", exact: true }).click();
  const result = panel.locator("[data-guided-indicator-result]");
  await expect(result).toContainText("No timing was accepted by this scan", { timeout: 60_000 });
  const inspect = result.getByRole("button", { name: /^Inspect unverified indicator candidate at/ });
  await expect(inspect).toBeEnabled();
  const candidate = Number((await inspect.textContent())!.match(/at ([\d.]+)s/)![1]);
  const beforeInspection = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  await testInfo.attach("marked-indicator-context-before-inspection", { body: JSON.stringify({
    dataset: JSON.parse(await readFile((await (await beforeInspection).path())!, "utf8")),
    resultText: await result.innerText(), candidate,
    cursor: await page.locator("#video-review video").evaluate(video => (video as HTMLVideoElement).currentTime),
  }, null, 2), contentType: "application/json" });
  expect(Math.abs(candidate - reference.authoredFinishIndicator)).toBeLessThanOrEqual(1 / reference.fps + .001);
  await inspect.click();
  await expect.poll(() => page.locator("#video-review video").evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo(candidate, 2);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const dataset = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(dataset.zones.finishIndicatorZone).toMatchObject({ id: "finishIndicator", ...zone });
  expect(dataset.zones.finishPadZone).toBeNull();
  expect(dataset.zones.finishLightZone).toBeNull();
  expect(dataset.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal")).toMatchObject({ acceptedRawTime: 2.4, source: "Manual" });
  expect(dataset.acceptedTimestamps.find((marker: any) => marker.markerId === "finishPad").acceptedRawTime).toBeNull();
  await testInfo.attach("guided-indicator-review-only-dataset", { body: JSON.stringify(dataset, null, 2), contentType: "application/json" });
});
