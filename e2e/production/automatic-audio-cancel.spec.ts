import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";

const fixture = path.resolve("e2e/fixtures/audio-start-review.mp4");

async function dataset(page: Page, info: TestInfo, name: string) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const bytes = await readFile((await (await waiting).path())!);
  await writeFile(info.outputPath(`${name}.json`), bytes);
  await info.attach(name, { body: bytes, contentType: "application/json" });
  return JSON.parse(bytes.toString("utf8"));
}

function protectedState(data: any) {
  return { timestamps: data.acceptedTimestamps, candidates: data.candidates,
    automatic: data.automationAudit, lanes: data.startLaneEvidenceAudit,
    finish: data.finishEvidenceAudit, analysisBuild: data.analysisBuild,
    zones: data.zones, calibration: data.calibration };
}

function restoredAnalysis(data: any) {
  const state = protectedState(data);
  // The cancellation status is expected to change. All actual prior timing,
  // evidence, calibration, candidate and lane state must be restored exactly.
  const { automaticAnalysis: _status, ...automatic } = state.automatic;
  return { ...state, automatic };
}

test("main Cancel releases automatic analysis while real audio decode settlement remains pending", async ({ page }, info) => {
  test.setTimeout(90_000);
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  expect(createHash("sha256").update(await readFile(fixture)).digest("hex"))
    .toBe("d50025ef6d94a03154bb09375240f366d0d40d0463c041478b969808420fd864");
  await page.goto("/");
  await info.attach("served-build", { body: JSON.stringify(await (await page.request.get("/build-info.json")).json()), contentType: "application/json" });
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(fixture);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByLabel("Analysis scope", { exact: true }).selectOption("timing-only");
  const imported = await dataset(page, info, "imported");
  const analyze = page.locator(".analyze-button");
  await analyze.click();
  await expect(analyze).toBeDisabled();
  await expect(analyze).toBeEnabled({ timeout: 60_000 });
  const previous = await dataset(page, info, "before-cancel-existing-analysis");
  const candidateCount = Object.values(previous.candidates).reduce((sum: number, value: any) => sum + value.length, 0);
  expect(candidateCount).toBeGreaterThan(0);
  expect(previous.automationAudit.automaticAnalysis).toBeTruthy();
  expect(previous.automationAudit).not.toEqual(imported.automationAudit);
  await info.attach("nonempty-prior-analysis", { body: JSON.stringify({ candidateCount, candidateCounts: Object.fromEntries(Object.entries(previous.candidates).map(([key, value]) => [key, (value as any[]).length])), automatic: previous.automationAudit }), contentType: "application/json" });
  const player = page.locator("#video-review video");
  await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).seeking)).toBe(false);
  const playerBefore = await player.evaluate(video => { const v = video as HTMLVideoElement; return { source: v.src, currentTime: v.currentTime, paused: v.paused }; });
  await page.evaluate(() => {
    const state = window as any, Native = window.AudioContext;
    const probe = state.__automaticAudioCancel = { created: 0, held: 0, released: false, closed: [] as number[], decoded: [] as any[] };
    let calls = 0;
    window.AudioContext = new Proxy(Native, { construct(target, args) {
      const context = Reflect.construct(target, args) as AudioContext;
      const index = probe.created++; probe.closed[index] = 0;
      const decode = context.decodeAudioData.bind(context), close = context.close.bind(context);
      context.close = async () => { probe.closed[index] += 1; await close(); };
      context.decodeAudioData = async bytes => {
        const decoded = await decode(bytes);
        probe.decoded.push({ channels: decoded.numberOfChannels, frames: decoded.length, sampleRate: decoded.sampleRate });
        if (calls++ === 0) {
          probe.held += 1;
          // The real decoder and its original PCM have completed. Hold only
          // settlement, so an abort cannot depend on this promise ever settling.
          await new Promise<void>(resolve => { probe.release = () => { probe.released = true; resolve(); }; });
        }
        return decoded;
      };
      return context;
    } });
  });
  try {
    await analyze.click();
    await expect(analyze).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__automaticAudioCancel.held)).toBe(1);
    const decoded = await page.evaluate(() => (window as any).__automaticAudioCancel.decoded[0]);
    expect(decoded.channels).toBeGreaterThan(0); expect(decoded.frames).toBeGreaterThan(0);
    await page.locator("#upload").getByRole("button", { name: "Cancel", exact: true }).click();
    // Soft assertions preserve the actual blocked UI, then release it safely
    // so the RED case can also show whether cancellation publishes late data.
    await expect.soft(analyze).toBeEnabled({ timeout: 5_000 });
    await expect.soft.poll(() => page.evaluate(() => (window as any).__automaticAudioCancel.closed)).toEqual([1]);
    await expect.soft.poll(() => player.evaluate((video, before) => {
      const v = video as HTMLVideoElement;
      return v.src === before.source && v.paused && !v.seeking && Math.abs(v.currentTime - before.currentTime) <= .002;
    }, playerBefore)).toBe(true);
    const pending = await page.evaluate(() => { const p = (window as any).__automaticAudioCancel; return { created: p.created, held: p.held, released: p.released, closed: p.closed, decoded: p.decoded }; });
    expect(pending.released).toBe(false);
    await info.attach("after-cancel-while-real-settlement-pending", { body: JSON.stringify(pending, null, 2), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("after-cancel-while-pending.png"), fullPage: true });
    const cancelled = await dataset(page, info, "after-cancel-while-pending");
    expect.soft(cancelled.automationAudit.automaticAnalysis).toMatch(/cancelled/i);
    expect.soft(restoredAnalysis(cancelled)).toEqual(restoredAnalysis(previous));
    await page.evaluate(() => (window as any).__automaticAudioCancel.release());
    await expect(analyze).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__automaticAudioCancel.closed)).toEqual([1]);
    const settled = await dataset(page, info, "after-late-real-settlement");
    expect.soft(protectedState(settled)).toEqual(protectedState(cancelled));
    // A native second request is not held and must finish normally.
    await analyze.click();
    await expect(analyze).toBeDisabled();
    await expect(analyze).toBeEnabled({ timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__automaticAudioCancel.closed)).toEqual([1, 1]);
    const retry = await dataset(page, info, "after-real-native-retry");
    expect(retry.automationAudit.automaticAnalysis).toBeTruthy();
    expect(retry.automationAudit.automaticAnalysis).not.toMatch(/cancelled/i);
    await info.attach("completed-context-lifecycle", { body: JSON.stringify(await page.evaluate(() => { const p = (window as any).__automaticAudioCancel; return { created: p.created, closed: p.closed, decoded: p.decoded, released: p.released }; }), null, 2), contentType: "application/json" });
  } finally {
    await page.evaluate(() => (window as any).__automaticAudioCancel?.release?.());
  }
});
