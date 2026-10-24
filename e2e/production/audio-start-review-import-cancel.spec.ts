import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { test, expect } from "./fixtures";

const fixture = path.resolve("e2e/fixtures/audio-start-review.mp4");

test("cancel during a held audio module load permits retry and only the new request can decode", async ({ page }, info) => {
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  const reference = JSON.parse(await readFile(fixture.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true });
  expect(createHash("sha256").update(await readFile(fixture)).digest("hex")).toBe(reference.sha256);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let moduleRequests = 0;
  await page.route(/\/assets\/audioStartReview-[^/]+\.js(?:\?|$)/, async route => {
    moduleRequests += 1;
    await held;
    await route.continue();
  });
  await page.addInitScript(() => {
    const state = window as any, Native = window.AudioContext;
    state.__importCancelCreated = 0; state.__importCancelDecoded = 0; state.__importCancelClosed = 0;
    window.AudioContext = new Proxy(Native, { construct(target, args) {
      const context = Reflect.construct(target, args) as AudioContext;
      // Count successfully owned contexts, not unsupported-rate constructor attempts.
      state.__importCancelCreated += 1;
      const decode = context.decodeAudioData.bind(context), close = context.close.bind(context);
      context.decodeAudioData = bytes => { state.__importCancelDecoded += 1; return decode(bytes); };
      context.close = async () => { state.__importCancelClosed += 1; await close(); };
      return context;
    } });
  });
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(fixture);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
  const panel = page.locator("[data-audio-start-review]");
  const find = panel.getByRole("button", { name: "Find a recorded start cue", exact: true });
  try {
    await find.click();
    await expect.poll(() => moduleRequests).toBe(1);
    await panel.getByRole("button", { name: "Cancel audio review", exact: true }).click();
    await info.attach("cancel-while-module-held", { contentType: "application/json", body: JSON.stringify({
      moduleRequests, moduleStillHeld: true, findDisabled: await find.isDisabled(), status: await panel.textContent(),
      contextsCreated: await page.evaluate(() => (window as any).__importCancelCreated),
    }, null, 2) });
    // These must settle while actual JavaScript bytes remain held. The old
    // import may finish later, but must not own the UI or open a decoder.
    await expect(find).toBeEnabled({ timeout: 1_500 });
    await expect(panel).toContainText("Audio review cancelled.");
    await expect(panel.getByRole("button", { name: "Cancel audio review", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__importCancelCreated)).toBe(0);
    // Retry BEFORE releasing the same import, so an old finally block cannot
    // clear the replacement request's controller/running state.
    await find.click();
    await expect(find).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Cancel audio review", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__importCancelDecoded)).toBe(0);
    release();
    await expect(panel.getByRole("button", { name: /^Inspect recorded cue at/ })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__importCancelCreated)).toBe(1);
    expect(await page.evaluate(() => (window as any).__importCancelDecoded)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).__importCancelClosed)).toBe(1);
    await expect(panel.locator("[data-audio-review-result]")).toHaveCount(1);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download data", exact: true }).click();
    const data = JSON.parse(await readFile((await (await download).path())!, "utf8"));
    expect(data.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBeNull();
    expect(data.startLaneEvidenceAudit.audioSearchHintTime).toBeNull();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
