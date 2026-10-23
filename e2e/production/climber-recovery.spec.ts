import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";
import { createPracticeSession } from "../../src/lib/practiceRecordings";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
}

async function dataset(page: Page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}

test.beforeEach(({}, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI verifies the media decoder; local Windows WebKit cannot decode these fixtures.");
});

test("opposing authored lanes offer frame-safe climber setup with cancellation and manual Finish fallback", async ({ page }) => {
  // Original encoded geometry/audio exercises the shipped pipeline. This is
  // workflow behavior, never real-climber identity or detector accuracy truth.
  await ready(page);
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("e2e/fixtures/dual-lane.mp4"));
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByLabel("Analysis scope", { exact: true }).selectOption("timing-only");
  await page.locator(".analyze-button").click();
  const select = page.getByRole("button", { name: "Select climber", exact: true });
  await expect(select).toBeVisible();
  await expect(page.locator('[aria-label="Your next step"]')).toContainText("Start is accepted");
  await expect(page.locator('[aria-label="Your next step"]').getByRole("button", { name: "Review finish", exact: true })).toBeEnabled();
  const before = await dataset(page), start = before.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime;
  const source = await page.locator("#video-review video").getAttribute("src");
  expect(typeof start).toBe("number");

  // Hold one real native seek until cancellation. The resumed seek still uses
  // the original media setter; no detector state or pixels are replaced.
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("#video-review video")!;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    Object.defineProperty(video, "currentTime", { configurable: true, get() { return descriptor.get!.call(video); },
      set(value: number) { (window as any).__releaseClimberSeek = () => {
        delete (video as any).currentTime;
        descriptor.set!.call(video, value);
      }; } });
  });
  await select.click();
  await expect(page.locator(".analyze-button")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseClimberSeek)).toBe("function");
  await page.getByRole("button", { name: "Cancel opening frame", exact: true }).click();
  await page.evaluate(() => (window as any).__releaseClimberSeek());
  await expect(select).toBeVisible();
  await expect(page.locator(".zone-frame")).toHaveCount(0);
  expect((await dataset(page)).acceptedTimestamps).toEqual(before.acceptedTimestamps);

  await select.click();
  await expect(page.getByLabel("Manual zone", { exact: true })).toHaveValue("startBody");
  await expect(page.getByLabel("Manual zone", { exact: true })).toBeFocused();
  await expect(page.locator("#review-tools")).toHaveAttribute("open", "");
  await expect(page.locator("#zones details")).toHaveAttribute("open", "");
  const frame = Number(await page.locator("[data-zone-frame-time]").getAttribute("data-zone-frame-time"));
  expect(Math.abs(frame - start)).toBeLessThanOrEqual(1 / 30 + .001); // Source-frame containment, not event error.
  await expect(page.getByLabel("Left edge (%)", { exact: true })).toHaveValue("");
  await expect(page.locator(".zone-frame")).toBeVisible();
  expect(await page.locator("#video-review video").getAttribute("src")).toBe(source);
  expect((await dataset(page)).acceptedTimestamps).toEqual(before.acceptedTimestamps);
});

test("keyboard region rejects incomplete/bounded/empty input and valid Apply clears athlete-specific annotations", async ({ page }) => {
  const session = createPracticeSession("a");
  session.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
  await ready(page);
  await page.locator('input[accept="application/json,.json"]').setInputFiles({ name: "keyboard-region.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(session)) });
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await page.getByRole("button", { name: "Attach to this attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.locator("#review-tools > summary").click();
  await page.locator("#zones summary").click();
  await page.getByLabel("Manual zone", { exact: true }).selectOption("startBody");
  await page.getByRole("button", { name: "Capture Current Frame for Zone Setup", exact: true }).click();
  const before = await dataset(page), apply = page.getByRole("button", { name: "Apply climber region", exact: true });
  const edges = ["Left", "Top", "Right", "Bottom"].map(edge => page.getByLabel(`${edge} edge (%)`, { exact: true }));
  for (const edge of edges) await expect(edge).toHaveValue("");
  await apply.click();
  await expect(page.getByRole("alert")).toContainText("Enter all four edges");
  for (const values of [["-1", "10", "60", "90"], ["10", "10", "101", "90"], ["60", "10", "60", "90"], ["10", "90", "60", "10"]]) {
    for (let i = 0; i < edges.length; i++) await edges[i].fill(values[i]);
    await apply.click();
    await expect(page.getByRole("alert")).toContainText("Enter all four edges");
  }
  for (const values of [["10", "40", "10.1", "90"], ["10", "40", "45", "40.1"]]) {
    for (let i = 0; i < edges.length; i++) await edges[i].fill(values[i]);
    await apply.click();
    await expect(page.getByRole("alert")).toContainText("more than 0.5%");
  }
  expect((await dataset(page)).acceptedTimestamps).toEqual(before.acceptedTimestamps);
  for (const [index, value] of ["10", "40", "45", "90"].entries()) await edges[index].fill(value);
  await apply.click();
  await expect(page.locator("#results .summary-primary-metric strong")).not.toHaveText("5.600s");
  const after = await dataset(page);
  expect(after.session.attemptLineageId).toBe(session.attemptLineageId);
  expect(after.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBe(1);
  expect(after.acceptedTimestamps.filter((marker: any) => marker.markerId !== "startSignal").every((marker: any) => marker.acceptedRawTime === null)).toBe(true);
  expect(after.zones.startBodyZone).toMatchObject({ x1: .1, y1: .4, x2: .45, y2: .9 });
});
