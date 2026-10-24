import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { test, expect } from "./fixtures";

// Authored media/decoder diagnostic. These clocks are not field event labels.
test("retain native seek metadata and indicator pixels across decoder readiness stages", async ({ page }, info) => {
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "Native WebKit media is exercised on macOS CI.");
  const file = path.resolve("e2e/fixtures/guided-finish-indicator.mp4");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  await page.goto("/");
  await expect(page.locator('[data-session-storage-state="ready"]')).toBeAttached();
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  const observations = await page.locator("#video-review video").evaluate(async element => {
    const video = element as HTMLVideoElement;
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const sample = (stage: string) => {
      let native: { timestamp: number; duration: number | null } | null = null;
      try { const frame = new VideoFrame(video); native = { timestamp: frame.timestamp, duration: frame.duration }; frame.close(); } catch { /* Capability is recorded. */ }
      context.drawImage(video, 0, 0, 320, 180);
      const pixels = context.getImageData(239, 95, 3, 3).data;
      const rgb = [0, 0, 0]; for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) rgb[c] += pixels[i+c]/9;
      return { stage, cursor: video.currentTime, native, rgb };
    };
    const rows = [];
    for (const requested of [.5, 6.55, 6.8, 6.95, 7, 7.05, 7.3, 9, 7, 6.55]) {
      let compositor: { mediaTime: number; presentedFrames: number } | null = null;
      const callback = video.requestVideoFrameCallback?.((_, metadata) => { compositor = { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames }; });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { video.removeEventListener("seeked", done); reject(new Error("Diagnostic seek timed out")); }, 4000);
        const done = () => { clearTimeout(timer); resolve(); };
        video.addEventListener("seeked", done, { once: true }); video.currentTime = requested;
      });
      const stages = [sample("seeked")];
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      stages.push(sample("two-render-frames"));
      await new Promise(resolve => setTimeout(resolve, 100)); stages.push(sample("settled-100ms"));
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      rows.push({ requested, compositor, stages });
    }
    return rows;
  });
  await info.attach("native-seek-metadata-and-pixels", { body: JSON.stringify({ sourceSha256: reference.sha256, observations }, null, 2), contentType: "application/json" });
  for (const row of observations) {
    const stable = row.stages.at(-1)!;
    expect(stable.cursor).toBeCloseTo(row.requested, 3);
    expect(stable.rgb[0] > stable.rgb[1], `Settled indicator color at ${row.requested}s`).toBe(row.requested >= 7);
  }
});
