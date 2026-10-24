import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const file = path.resolve("e2e/fixtures/audio-start-review.mp4");
test.beforeEach(async ({ page }, info) => {
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true });
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
});

async function holdNativeDecode(page: Page) {
  await page.evaluate(() => {
    const state = window as any, Native = window.AudioContext;
    state.__independentAudioHeld = 0; state.__independentAudioClosed = 0;
    let calls = 0;
    window.AudioContext = new Proxy(Native, { construct(target, args) {
      const context = Reflect.construct(target, args) as AudioContext;
      const decode = context.decodeAudioData.bind(context), close = context.close.bind(context);
      context.close = async () => { state.__independentAudioClosed += 1; await close(); };
      context.decodeAudioData = async bytes => {
        const decoded = await decode(bytes);
        if (calls++ === 0) {
          state.__independentAudioHeld += 1;
          await new Promise<void>(resolve => { state.__independentReleaseAudio = resolve; });
        }
        return decoded;
      };
      return context;
    } });
  });
  await page.locator("[data-audio-start-review]").getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__independentAudioHeld)).toBe(1);
}

async function exportedStart(page: Page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const data = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  return { marker: data.acceptedTimestamps.find((m: any) => m.markerId === "startSignal"),
    audioHint: data.startLaneEvidenceAudit.audioSearchHintTime };
}

test("changing only the configured audio window discards held decoding and its old suggestion", async ({ page }) => {
  const beforeSource = await page.locator("#video-review video").evaluate(v => (v as HTMLVideoElement).src);
  await holdNativeDecode(page);
  await page.locator("summary").filter({ hasText: "Review & advanced tools" }).click();
  await page.getByText("Manual timing settings", { exact: true }).click();
  await page.getByLabel("Ignore video before (seconds)", { exact: true }).fill("4");
  const panel = page.locator("[data-audio-start-review]");
  await expect(panel).toContainText("4.00–10.00s");
  await expect.poll(() => page.evaluate(() => (window as any).__independentAudioClosed)).toBe(1);
  expect(await page.locator("#video-review video").evaluate(v => (v as HTMLVideoElement).src)).toBe(beforeSource);
  await page.evaluate(() => (window as any).__independentReleaseAudio());
  await expect(panel.locator("[data-audio-review-result]")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel audio review", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect(panel.locator("[data-audio-review-result]")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Inspect recorded cue at/ })).toHaveCount(0);
  const exported = await exportedStart(page);
  expect(exported.marker.acceptedRawTime).toBeNull();
  expect(exported.audioHint).toBeNull();
});

test("closing review aborts its held decoder and reopening cannot inherit a late suggestion", async ({ page }) => {
  await holdNativeDecode(page);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.locator("[data-audio-start-review]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__independentAudioClosed)).toBe(1);
  await page.evaluate(() => (window as any).__independentReleaseAudio());
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  const panel = page.locator("[data-audio-start-review]");
  await expect(panel.locator("[data-audio-review-result]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Inspect recorded cue at/ })).toBeEnabled();
  const exported = await exportedStart(page);
  expect(exported.marker.acceptedRawTime).toBeNull();
  expect(exported.audioHint).toBeNull();
});
