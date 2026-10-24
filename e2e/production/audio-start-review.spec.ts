import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const file = path.resolve("e2e/fixtures/audio-start-review.mp4");
test.beforeEach(async ({ page }, info) => {
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true, audioProfile: "secondary-880-1760" });
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  await expect(page.locator("[data-audio-start-review]")).toContainText("0.00–10.00s");
});

async function dataset(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  return JSON.parse(await readFile((await (await downloaded).path())!, "utf8"));
}

function timingState(data: any) {
  return { timestamps: data.acceptedTimestamps, candidates: data.candidates,
    automatic: data.automationAudit, lanes: data.startLaneEvidenceAudit };
}

async function holdOneRealDecode(page: Page) {
  await page.evaluate(() => {
    const state = window as any;
    const Native = window.AudioContext;
    state.__audioReviewHeld = 0; state.__audioReviewClosed = 0;
    let calls = 0;
    window.AudioContext = new Proxy(Native, { construct(target, args) {
      const context = Reflect.construct(target, args) as AudioContext;
      const decode = context.decodeAudioData.bind(context), close = context.close.bind(context);
      context.close = async () => { state.__audioReviewClosed += 1; await close(); };
      context.decodeAudioData = async bytes => {
        const decoded = await decode(bytes);
        if (calls++ === 0) {
          state.__audioReviewHeld += 1;
          // Real native decoding and PCM are retained. Only settlement is held
          // so user cancellation/replacement can be exercised deterministically.
          await new Promise<void>(resolve => { state.__releaseAudioReview = resolve; });
        }
        return decoded;
      };
      return context;
    } });
  });
}

test("a recorded cue remains navigation until the user accepts a reviewed frame", async ({ page }, info) => {
  const before = await dataset(page);
  const panel = page.locator("[data-audio-start-review]");
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  const inspect = panel.getByRole("button", { name: /^Inspect recorded cue at/ });
  await expect(inspect).toBeEnabled();
  const proposed = Number((await inspect.textContent())!.match(/at ([\d.]+)s/)![1]);
  expect(Math.abs(proposed - 2.4)).toBeLessThanOrEqual(.04);
  await inspect.click();
  await expect(page.locator(".timestamp-review")).toHaveAttribute("data-navigation-only", "true");
  expect(timingState(await dataset(page))).toEqual(timingState(before));
  // The suggestion is not accepted blindly. Explicitly inspect the authored
  // visible source-frame transition, then choose manual acceptance.
  await page.getByRole("button", { name: "Jump to time", exact: true }).click();
  const field = page.getByLabel("Raw video time (seconds)", { exact: true });
  await field.fill("2.4"); await field.press("Enter");
  const accept = page.getByRole("button", { name: /^Accept start at 2\.400s/ });
  await expect(accept).toBeEnabled();
  await info.attach("manual-audio-navigation", { body: await panel.screenshot(), contentType: "image/png" });
  await accept.click();
  const after = await dataset(page);
  const start = after.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal");
  expect(start).toMatchObject({ source: "Manual", acceptedRawTime: 2.4, acceptanceMode: "frame-review", userAccepted: true, isGroundTruthLabel: false });
  expect(start.note).toContain("unverified recorded-cue suggestion");
  expect(after.startLaneEvidenceAudit.audioSearchHintTime).toBeNull();
  expect(after.candidates.startSignal).toEqual(before.candidates.startSignal);
});

test("cancelling held native decoding closes its context and permits a clean retry", async ({ page }) => {
  await holdOneRealDecode(page);
  const panel = page.locator("[data-audio-start-review]");
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__audioReviewHeld)).toBe(1);
  await panel.getByRole("button", { name: "Cancel audio review", exact: true }).click();
  await expect(panel).toContainText("Audio review cancelled");
  await expect.poll(() => page.evaluate(() => (window as any).__audioReviewClosed)).toBe(1);
  await page.evaluate(() => (window as any).__releaseAudioReview());
  await expect(panel.locator("[data-audio-review-result]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Inspect recorded cue at/ })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__audioReviewClosed)).toBe(2);
  expect((await dataset(page)).acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBeNull();
});

test("a same-name replacement aborts old decoding and cannot inherit its suggestion", async ({ page }) => {
  await holdOneRealDecode(page);
  const panel = page.locator("[data-audio-start-review]");
  const previousSource = await page.locator("#video-review video").evaluate(video => (video as HTMLVideoElement).src);
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__audioReviewHeld)).toBe(1);
  await page.getByLabel("Replace video", { exact: true }).setInputFiles({ name: "audio-start-review.mp4", mimeType: "video/mp4",
    buffer: await readFile(path.resolve("e2e/fixtures/guided-finish-indicator.mp4")) });
  await expect.poll(() => page.locator("#video-review video").evaluate(video => (video as HTMLVideoElement).src)).not.toBe(previousSource);
  await expect.poll(() => page.evaluate(() => (window as any).__audioReviewClosed)).toBe(1);
  await page.evaluate(() => (window as any).__releaseAudioReview());
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  await expect(panel.locator("[data-audio-review-result]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  await expect(panel.locator("[data-audio-review-result]")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Inspect recorded cue at/ })).toHaveCount(0);
  expect((await dataset(page)).acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBeNull();
});
