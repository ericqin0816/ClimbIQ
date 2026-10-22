import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPracticeSession } from "../../src/lib/practiceRecordings";
import { createSessionLibraryBackup } from "../../src/lib/sessionLibrary";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
}

async function openPractice(page: Page, id: "A" | "B") {
  const name = id === "A" ? /Open practice A(?: as a new attempt)?$/ : "Open practice B as a new attempt";
  await page.getByRole("button", { name }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText(id === "A" ? "5.600s" : "5.200s");
}

async function reviewHold(page: Page) {
  await page.getByRole("button", { name: "Review practice Hold 10", exact: true }).click();
  const accept = page.getByRole("button", { name: /^Accept Hold 10 at/ });
  await expect(accept).toBeEnabled();
  await accept.click();
}

async function savePractice(page: Page, count: number) {
  await page.getByRole("button", { name: "Save practice attempt", exact: true }).click();
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(count);
}

test("practice import, contact review, save, comparison replay and reload", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Windows Playwright WebKit lacks a working video decoder here; macOS CI runs this media workflow without skips.");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Compare two attempts");
  await openPractice(page, "A");
  await reviewHold(page);
  await savePractice(page, 1);
  await openPractice(page, "B");
  await reviewHold(page);
  await savePractice(page, 2);
  await expect(page.locator(".comparison-insight")).toContainText("0.400s");
  await expect(page.getByRole("button", { name: "Replay whole attempt", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Use baseline practice recording", exact: true }).click();
  await page.getByRole("button", { name: "Use new attempt practice recording", exact: true }).click();
  const confirmations = page.locator(".comparison-recording-check input");
  await expect(confirmations).toHaveCount(2);
  await confirmations.nth(0).check();
  await confirmations.nth(1).check();
  const replay = page.getByRole("button", { name: "Replay top phase", exact: true });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).currentTime > 3.9))).toBe(true);
  const clocks = await page.locator(".comparison-players video").evaluateAll(videos => videos.map(video => (video as HTMLVideoElement).currentTime));
  expect(Math.abs((clocks[0] - 3.8) - (clocks[1] - 3.3))).toBeLessThan(.16);
  await page.getByRole("button", { name: "Pause comparison", exact: true }).click();
  await expect(page.locator(".recent-attempts button")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator("#saved-attempts").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("saved-comparison.png") });
  await page.reload();
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(2);
  await expect(page.locator(".comparison-insight")).toContainText("0.400s");
  await expect(page.locator(".comparison-players video")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("bad replacement preserves analysis and matching metadata cannot attach another recording", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media workflow is verified by macOS WebKit CI; this Windows WebKit build rejects H.264 and WebM.");
  await ready(page);
  await openPractice(page, "A");
  const player = page.locator("#video-review video");
  const source = await player.getAttribute("src");
  await page.getByLabel("Replace video", { exact: true }).setInputFiles({ name: "broken.mp4", mimeType: "video/mp4", buffer: Buffer.from("No video frames") });
  await expect(page.locator(".upload-error")).toBeVisible();
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  await expect(player).toHaveAttribute("src", source!);
  await page.getByLabel("Replace video", { exact: true }).setInputFiles({ name: "climbiq-practice-a.mp4", mimeType: "video/mp4", buffer: await readFile(path.resolve("public/samples/climbiq-practice-b.mp4")) });
  await expect(page.locator("[data-video-attachment-choice]")).toBeVisible();
  await expect(player).toHaveAttribute("src", source!);
  await page.getByRole("button", { name: "Analyze as a new attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("—");
  await expect(player).not.toHaveAttribute("src", source!);
});

test("a stale tab cannot overwrite a newer saved library", async ({ page, context }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "The video precondition requires macOS WebKit CI.");
  await ready(page);
  await openPractice(page, "A");
  await savePractice(page, 1);
  const peer = await context.newPage();
  await ready(peer);
  await peer.locator(".attempt-library-list > button").first().click();
  await openPractice(page, "B");
  await savePractice(page, 2);
  await peer.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(peer.getByRole("button", { name: "Reload latest saved attempts", exact: true })).toBeVisible();
  await peer.getByRole("button", { name: "Reload latest saved attempts", exact: true }).click();
  await expect(peer.locator(".attempt-library-list > button")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(2);
});

test("saved JSON import, lineage safeguards, backup and stale-tab recovery without video", async ({ page, context }, testInfo) => {
  const a = createPracticeSession("a"), b = createPracticeSession("b");
  const payload = (sessions: typeof a[]) => ({ name: "synthetic-library.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(createSessionLibraryBackup(sessions))) });
  const input = (target: Page) => target.locator('input[accept="application/json,.json"]');
  await ready(page);
  await input(page).setInputFiles(payload([a]));
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
  const peer = await context.newPage(); await ready(peer);
  await peer.locator(".attempt-library-list > button").first().click();
  await input(page).setInputFiles(payload([b]));
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(2);
  await peer.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(peer.getByRole("button", { name: "Reload latest saved attempts", exact: true })).toBeVisible();
  await peer.getByRole("button", { name: "Reload latest saved attempts", exact: true }).click();
  await expect(peer.locator(".attempt-library-list > button")).toHaveCount(2);
  const copy = { ...a, id: a.id + "-annotation", name: "Annotation copy", updatedAt: new Date().toISOString() };
  copy.timestamps = structuredClone(a.timestamps); copy.timestamps.find(marker => marker.id === "finishPad")!.rawTime = 6;
  await input(page).setInputFiles(payload([copy]));
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(3);
  await page.locator(".comparison-selectors select").nth(0).selectOption(a.id);
  await page.locator(".comparison-selectors select").nth(1).selectOption(copy.id);
  await expect(page.locator(".comparison-insight")).toContainText("Annotation comparison only");
  await expect(page.locator(".recent-attempts button")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export saved library", exact: true }).click();
  const download = await downloadPromise; const downloaded = await download.path();
  const backup = JSON.parse(await readFile(downloaded!, "utf8"));
  expect(backup.sessions).toHaveLength(3);
  expect(backup.sessions.find((item: typeof a) => item.id === copy.id).attemptLineageId).toBe(a.attemptLineageId);
  await page.reload(); await expect(page.locator(".attempt-library-list > button")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("saved-without-video.png") });
});
