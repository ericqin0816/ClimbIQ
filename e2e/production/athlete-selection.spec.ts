import { test, expect } from "./fixtures";
import { createPracticeSession } from "../../src/lib/practiceRecordings";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("reattached automatic zones need fresh evidence and deleting the athlete clears dependent timing", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI verifies the media decoder; local Windows WebKit cannot decode this fixture.");
  const session = createPracticeSession("a"); // Authored workflow fixture, never an independent event label.
  session.zones.startBody = { id: "startBody", label: "Selected synthetic climber", x1: .1, x2: .45, y1: .4, y2: .9 };
  session.zones.startLight = { id: "startLight", label: "Auto-detected fixture light", x1: .2, x2: .23, y1: .7, y2: .75 };
  session.startLightCalibration = { beforeStartRGB: { r: 10, g: 100, b: 20 }, afterStartRGB: { r: 10, g: 20, b: 100 }, colorDelta: 113 };
  session.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.locator('input[accept="application/json,.json"]').setInputFiles({ name: "athlete-selection.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(session)) });
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await page.getByRole("button", { name: "Attach to this attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  await page.locator("#review-tools > summary").click();
  await page.getByRole("button", { name: "Find finish automatically", exact: true }).click();
  await expect(page.locator("#review-tools")).toContainText("Automatic Finish needs a new lane check");
  await expect(page.locator("[data-finish-evidence]")).toHaveCount(0);
  // Standalone blocking preserves deliberate observations until the athlete changes.
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  await page.locator("#zones summary").click();
  await page.locator("#zones select").selectOption("startBody");
  await page.getByRole("button", { name: "Delete selected zone", exact: true }).click();
  await expect(page.locator("#results .summary-primary-metric strong")).not.toHaveText("5.600s");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const dataset = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(dataset.session.attemptLineageId).toBe(session.attemptLineageId);
  expect(dataset.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBe(1);
  expect(dataset.acceptedTimestamps.filter((marker: any) => marker.markerId !== "startSignal").every((marker: any) => marker.acceptedRawTime === null)).toBe(true);
  expect(dataset.zones.startBodyZone).toBeNull();
});
