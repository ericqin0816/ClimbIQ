import type { Page } from "@playwright/test";
import { test, expect, reviewSyntheticComparisonContext } from "./fixtures";
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
  // The previous recording can still be ready while the candidate is decoding.
  await expect(page.locator(".upload-dropzone strong")).toHaveText(`climbiq-practice-${id.toLowerCase()}.mp4`);
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

async function prepareReplay(page: Page) {
  const sessions = [createPracticeSession("a"), createPracticeSession("b")];
  for (const session of sessions) session.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
  await ready(page);
  await page.locator('input[accept="application/json,.json"]').setInputFiles({ name: "reviewed-synthetic-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(createSessionLibraryBackup(sessions))) });
  await page.locator(".comparison-selectors select").nth(0).selectOption(sessions[0].id);
  await page.locator(".comparison-selectors select").nth(1).selectOption(sessions[1].id);
  await page.getByRole("button", { name: "Use baseline practice recording", exact: true }).click();
  await page.getByRole("button", { name: "Use new attempt practice recording", exact: true }).click();
  await page.locator(".comparison-recording-check input").nth(0).check();
  await page.locator(".comparison-recording-check input").nth(1).check();
  await expect(page.getByRole("button", { name: "Replay whole attempt", exact: true })).toBeEnabled();
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
  const nextStep = page.getByRole("region", { name: "Your next step", exact: true });
  await expect(nextStep.getByRole("link", { name: "Compare saved attempts" })).toHaveAttribute("href", "#attempt-comparison");
  await page.getByText("Session details & saved analyses", { exact: true }).click();
  await page.getByText("Session name and athlete details", { exact: true }).click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Synthetic workflow note; not a study observation.");
  await expect(nextStep.getByRole("link", { name: "Save this attempt" })).toBeAttached();
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(nextStep.getByRole("link", { name: "Compare saved attempts" })).toBeAttached();
  await reviewSyntheticComparisonContext(page);
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
  await expect(page.locator(".comparison-context-check input")).not.toBeChecked();
  await expect(page.locator(".comparison-row").filter({ hasText: "Total climb" })).toContainText("0.400s · Recorded difference");
  await expect(page.locator(".comparison-row.gained, .comparison-row.lost")).toHaveCount(0);
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
  await expect(page.locator(".comparison-table")).not.toContainText("Reviewed Hold 10");
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

test("replay startup ignores stale play promises and pauses on backgrounding", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media regressions run on macOS WebKit CI.");
  await prepareReplay(page);
  await page.evaluate(() => {
    const state = window as any;
    state.heldPlays = []; state.holdPlays = true;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const held = state.holdPlays && this.closest(".comparison-players");
      const result = play.call(this);
      return held ? result.then(() => new Promise<void>(resolve => state.heldPlays.push(resolve))) : result;
    };
  });
  const replay = page.getByRole("button", { name: "Replay whole attempt", exact: true });
  await replay.click();
  await expect.poll(() => page.evaluate(() => (window as any).heldPlays.length)).toBe(2);
  await expect(replay).toBeDisabled();
  await page.getByRole("button", { name: "Pause comparison", exact: true }).click();
  await page.evaluate(() => { (window as any).holdPlays = false; });
  await replay.click();
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => !(video as HTMLVideoElement).paused))).toBe(true);
  await page.evaluate(async () => { for (const release of (window as any).heldPlays.splice(0)) release(); await new Promise(requestAnimationFrame); });
  expect(await page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => !(video as HTMLVideoElement).paused))).toBe(true);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).paused))).toBe(true);
  await page.evaluate(() => { delete (document as any).hidden; });
});

test("the shorter phase stops exactly at its reviewed endpoint while the other continues", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Endpoint media regression runs on macOS WebKit CI.");
  await prepareReplay(page);
  // WebKit CI trace RPCs can take ~335ms each, nearly the entire 500ms
  // interval between these endpoints. Observe actual native media in-page and
  // retain the transition so a delayed remote poll cannot miss it.
  await page.evaluate(() => {
    const probe = { matched: false, active: true, firstStoppedBaselineTime: null as number | null, samples: [] as Array<{
      elapsedMs: number; baselineTime: number; candidateTime: number;
      baselinePaused: boolean; candidatePaused: boolean; baselineSeeking: boolean; candidateSeeking: boolean;
      baselineReady: number; candidateReady: number; hidden: boolean; event: string;
    }> };
    (window as any).__phaseEndpointProbe = probe;
    const started = performance.now();
    const record = (event: string) => {
      if (!probe.active || probe.samples.length >= 1200) return;
      const [baseline, candidate] = Array.from(document.querySelectorAll<HTMLVideoElement>(".comparison-players video"));
      if (baseline && candidate) {
        probe.samples.push({ elapsedMs: performance.now() - started,
          baselineTime: baseline.currentTime, candidateTime: candidate.currentTime,
          baselinePaused: baseline.paused, candidatePaused: candidate.paused, baselineSeeking: baseline.seeking, candidateSeeking: candidate.seeking,
          baselineReady: baseline.readyState, candidateReady: candidate.readyState, hidden: document.hidden, event });
        if (!baseline.paused && candidate.paused && Math.abs(candidate.currentTime - 3.3) < .005 && baseline.currentTime < 3.8) {
          probe.firstStoppedBaselineTime ??= baseline.currentTime;
          // Require actual forward clock movement while the shorter side stays
          // at its endpoint, not just a momentary unpaused flag.
          probe.matched ||= baseline.currentTime > probe.firstStoppedBaselineTime + .02;
        }
      }
    };
    const sample = () => {
      record("animation-frame");
      if (!probe.matched && performance.now() - started < 8000 && probe.samples.length < 1200) requestAnimationFrame(sample);
    };
    for (const video of document.querySelectorAll<HTMLVideoElement>(".comparison-players video")) {
      for (const event of ["pause", "seeked", "playing", "error"]) video.addEventListener(event, () => record(event));
    }
    requestAnimationFrame(sample);
  });
  await page.getByRole("button", { name: "Replay bottom phase", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const probe = (window as any).__phaseEndpointProbe;
    return { matched: probe.matched, firstStoppedBaselineTime: probe.firstStoppedBaselineTime, lastSamples: probe.samples.slice(-12) };
  })).toMatchObject({ matched: true });
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => {
    const [baseline, candidate] = videos as HTMLVideoElement[];
    return baseline.paused && candidate.paused && Math.abs(candidate.currentTime - 3.3) < .005 && Math.abs(baseline.currentTime - 3.8) < .005;
  })).toBe(true);
  await page.evaluate(() => { (window as any).__phaseEndpointProbe.active = false; });
});

test("native replay lag is corrected with both players paused before seeking and then resumes", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Native replay correction runs on macOS WebKit CI.");
  await prepareReplay(page);
  await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".comparison-players video"));
    const replay = Array.from(document.querySelectorAll<HTMLButtonElement>("#comparison-replay button"))
      .find(button => button.textContent === "Replay bottom phase");
    if (!replay) throw new Error("Bottom phase replay is unavailable.");
    const probe = { controlledPause: false, correctionSeeks: 0, activeSeek: false, resumed: false,
      firstPlayingTimes: null as number[] | null, resumedTimes: null as number[] | null, samples: [] as unknown[], error: "" };
    (window as any).__nativeCorrectionProbe = probe;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { ...descriptor, set(this: HTMLMediaElement, value: number) {
      if (probe.controlledPause && videos.includes(this as HTMLVideoElement)) {
        probe.correctionSeeks++;
        probe.activeSeek ||= videos.some(video => !video.paused);
      }
      descriptor.set!.call(this, value);
    } });
    replay.addEventListener("click", () => {
      const started = performance.now();
      const observe = () => {
        const playing = /· Playing$/.test(document.querySelector(".comparison-playback-status")?.textContent?.trim() ?? "");
        const ready = videos.length === 2 && videos.every(video => !video.paused && !video.seeking && video.readyState >= 3);
        if (!probe.controlledPause && playing && ready) {
          probe.firstPlayingTimes ??= videos.map(video => video.currentTime);
          if (videos.every((video, index) => video.currentTime > probe.firstPlayingTimes![index] + .08)) {
            // Controlled native lag, not a network-starvation or accuracy test.
            // Media clocks, native decoding and rAF remain untouched. Let the
            // real synchronization loop detect and correct this paused side.
            probe.controlledPause = true;
            videos[0].pause();
          }
        } else if (probe.controlledPause && probe.correctionSeeks > 0 && playing && ready) {
          probe.resumedTimes ??= videos.map(video => video.currentTime);
          probe.resumed ||= videos.every((video, index) => video.currentTime > probe.resumedTimes![index] + .08);
        }
        if (probe.samples.length < 600) probe.samples.push({ elapsedMs: performance.now() - started,
          videos: videos.map(video => ({ time: video.currentTime, paused: video.paused, seeking: video.seeking, ready: video.readyState })) });
        if (!probe.resumed && performance.now() - started < 8000) requestAnimationFrame(observe);
        else if (!probe.resumed) probe.error = "The real pair did not resume native progress after controlled lag.";
      };
      requestAnimationFrame(observe);
    }, { once: true });
  });
  await page.getByRole("button", { name: "Replay bottom phase", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const p = (window as any).__nativeCorrectionProbe;
    return { controlledPause: p.controlledPause, corrected: p.correctionSeeks > 0, activeSeek: p.activeSeek, resumed: p.resumed, error: p.error };
  })).toEqual({ controlledPause: true, corrected: true, activeSeek: false, resumed: true, error: "" });
  await expect(page.locator("#comparison-replay [role=alert]")).toHaveCount(0);
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => {
    const [baseline, candidate] = videos as HTMLVideoElement[];
    return baseline.paused && candidate.paused && !baseline.seeking && !candidate.seeking &&
      Math.abs(candidate.currentTime - 3.3) < .005 && Math.abs(baseline.currentTime - 3.8) < .005;
  })).toBe(true);
});

test("recovered waiting notices preserve replay and current unready data requires explicit replay", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media readiness regression runs on macOS WebKit CI.");
  await prepareReplay(page);
  const replay = page.getByRole("button", { name: "Replay bottom phase", exact: true });
  await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".comparison-players video"));
    const replayButton = Array.from(document.querySelectorAll<HTMLButtonElement>("#comparison-replay button"))
      .find(button => button.textContent === "Replay bottom phase");
    if (!replayButton) throw new Error("Bottom phase replay is unavailable.");
    const probe = { dispatchedReady: 0, continued: false, ownerPlaying: false,
      firstPlayingTimes: null as number[] | null, dispatchTimes: null as number[] | null, error: "" };
    (window as any).__recoveredWaitingProbe = probe;
    replayButton.addEventListener("click", () => {
      const started = performance.now();
      const observe = () => {
        const ownerPlaying = /· Playing$/.test(document.querySelector(".comparison-playback-status")?.textContent?.trim() ?? "");
        if (!probe.dispatchTimes && ownerPlaying && videos.length === 2 &&
            videos.every(video => !video.paused && !video.seeking && video.readyState >= 3)) {
          probe.firstPlayingTimes ??= videos.map(video => video.currentTime);
          if (videos.every((video, index) => video.currentTime > probe.firstPlayingTimes![index] + .02)) {
            probe.dispatchTimes = videos.map(video => video.currentTime);
            probe.dispatchedReady = videos[0].readyState;
            probe.ownerPlaying = true;
            // Model a queued notice after readiness recovered, as observed in
            // the native phone trace. Media clocks and decoding stay real.
            videos[0].dispatchEvent(new Event("waiting"));
          }
        }
        if (probe.dispatchTimes) probe.continued ||= videos.every((video, index) =>
          !video.paused && video.currentTime > probe.dispatchTimes![index] + .08);
        if (!probe.continued && performance.now() - started < 5000) requestAnimationFrame(observe);
        else if (!probe.continued) probe.error = "Ready replay did not continue after the recovered waiting notice.";
      };
      requestAnimationFrame(observe);
    }, { once: true });
  });
  await replay.click();
  await expect.poll(() => page.evaluate(() => {
    const probe = (window as any).__recoveredWaitingProbe;
    return { futureData: probe.dispatchedReady >= 3, continued: probe.continued, ownerPlaying: probe.ownerPlaying, error: probe.error };
  })).toEqual({ futureData: true, continued: true, ownerPlaying: true, error: "" });
  await expect(page.locator("#comparison-replay [role=alert]")).toHaveCount(0);

  await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".comparison-players video"));
    const replayButton = Array.from(document.querySelectorAll<HTMLButtonElement>("#comparison-replay button"))
      .find(button => button.textContent === "Replay bottom phase");
    if (!replayButton) throw new Error("Bottom phase replay is unavailable.");
    const probe = { dispatched: false, progressed: false, ownerPlaying: false, firstPlayingTimes: null as number[] | null, error: "" };
    (window as any).__controlledWaitingProbe = probe;
    // Prearm before the UI click. A remote assertion can arrive while native
    // seeking is still pending, or after this short phase has already ended.
    replayButton.addEventListener("click", () => {
      const started = performance.now();
      const observe = () => {
        const ownerPlaying = /· Playing$/.test(document.querySelector(".comparison-playback-status")?.textContent?.trim() ?? "");
        if (ownerPlaying && videos.length === 2 && videos.every(video => !video.paused && !video.seeking && video.readyState >= 3)) {
          probe.firstPlayingTimes ??= videos.map(video => video.currentTime);
          probe.progressed ||= videos.every((video, index) => video.currentTime > probe.firstPlayingTimes![index] + .02);
          if (probe.progressed) {
            const video = videos[0], original = Object.getOwnPropertyDescriptor(video, "readyState");
            try {
              // Controlled readiness is a policy regression, not proof of a
              // real network stall. Restore it before explicit user recovery.
              Object.defineProperty(video, "readyState", { configurable: true, get: () => 2 });
              video.dispatchEvent(new Event("waiting"));
              probe.dispatched = true;
              probe.ownerPlaying = true;
            } finally {
              if (original) Object.defineProperty(video, "readyState", original);
              else delete (video as any).readyState;
            }
            return;
          }
        }
        if (performance.now() - started < 5000) requestAnimationFrame(observe);
        else probe.error = "Native replay did not advance both ready players before the controlled waiting check.";
      };
      requestAnimationFrame(observe);
    }, { once: true });
  });
  await replay.click();
  await expect.poll(() => page.evaluate(() => (window as any).__controlledWaitingProbe)).toMatchObject({ dispatched: true, progressed: true, ownerPlaying: true, error: "" });
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).paused))).toBe(true);
  await expect(page.locator("#comparison-replay [role=alert]")).toContainText("Playback buffered");
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).readyState >= 3))).toBe(true);

  // Recovery is a separate explicit replay, never an automatic retry of the
  // failed uninterrupted run. Verify real progress and exact native endpoints.
  await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".comparison-players video"));
    const probe = { advanced: false, firstPlayingTimes: null as number[] | null };
    (window as any).__explicitReplayRecoveryProbe = probe;
    const started = performance.now();
    const observe = () => {
      if (videos.length === 2 && videos.every(video => !video.paused)) {
        probe.firstPlayingTimes ??= videos.map(video => video.currentTime);
        probe.advanced ||= videos.every((video, index) => video.currentTime > probe.firstPlayingTimes![index] + .08);
      }
      if (!probe.advanced && performance.now() - started < 5000) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });
  await replay.click();
  await expect(page.locator("#comparison-replay [role=alert]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__explicitReplayRecoveryProbe.advanced)).toBe(true);
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => {
    const [baseline, candidate] = videos as HTMLVideoElement[];
    return baseline.paused && candidate.paused && Math.abs(candidate.currentTime - 3.3) < .005 && Math.abs(baseline.currentTime - 3.8) < .005;
  })).toBe(true);
});

test("calibration owns its decoder task and blocks overlapping session changes", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Calibration media ownership runs on macOS WebKit CI.");
  const a = createPracticeSession("a"), b = createPracticeSession("b");
  a.zones.startLight = { id: "startLight", label: "Synthetic start light", x1: .15, y1: .87, x2: .25, y2: .94 };
  await ready(page);
  await page.locator('input[accept="application/json,.json"]').setInputFiles({ name: "calibration-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(createSessionLibraryBackup([a, b]))) });
  await page.locator(".attempt-library-list > button").filter({ hasText: a.name }).click();
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await page.getByRole("button", { name: "Attach to this attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  const sample = page.locator("button").filter({ hasText: "Use current frame as green" });
  await sample.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; });
  await page.evaluate(() => {
    const state = window as any;
    state.originalCalibrationVideoFrame = state.VideoFrame;
    // Exercise a pending readback without fabricating video pixels or detector
    // output. Its readiness timeout can be shorter than a WebKit trace RPC.
    state.VideoFrame = class { timestamp = 10_000_000; duration = 33_333; close() {} };
    const probe = { blocked: false, lastObserved: {} };
    const inspect = () => {
      const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(".attempt-library-list > button"));
      const replace = document.querySelector<HTMLInputElement>('input[aria-label="Replace video"]');
      const sample = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Use current frame as green");
      const blocked = rows.length === 2 && rows.every(row => row.disabled) && replace?.disabled === true && sample?.disabled === true;
      probe.lastObserved = { rowsDisabled: rows.map(row => row.disabled), replaceDisabled: replace?.disabled, sampleDisabled: sample?.disabled };
      probe.blocked ||= blocked;
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.querySelector("main")!, { attributes: true, childList: true, subtree: true });
    state.calibrationOwnershipProbe = probe;
    state.stopCalibrationOwnershipProbe = () => observer.disconnect();
  });
  await sample.click();
  // Retain one real DOM commit where all overlapping operations are blocked;
  // remote assertions may run after the 200ms readback has already completed.
  await expect.poll(() => page.evaluate(() => (window as any).calibrationOwnershipProbe)).toMatchObject({ blocked: true });
  await page.evaluate(() => {
    const state = window as any;
    state.stopCalibrationOwnershipProbe();
    if (state.originalCalibrationVideoFrame) state.VideoFrame = state.originalCalibrationVideoFrame;
    else delete state.VideoFrame;
  });
  await expect(sample).toBeEnabled();
  await expect(page.locator(".attempt-library-list > button").first()).toBeEnabled();
  await expect(page.locator(".upload-error")).toHaveCount(0);
});
