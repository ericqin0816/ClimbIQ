import { test, expect, reviewSyntheticComparisonContext } from "./fixtures";
import { createPracticeSession } from "../../src/lib/practiceRecordings";
import pkg from "../../package.json" with { type: "json" };
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSessionLibraryBackup } from "../../src/lib/sessionLibrary";

test("manual timing reaches native review without preaccepting missing markers", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI exercises media under WebKit; the local Windows decoder is unavailable.");
  if (testInfo.project.name.endsWith("phone")) await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  const start = page.locator("#timing-markers tbody tr").filter({ hasText: "Start Signal" });
  const hold = page.locator("#timing-markers tbody tr").filter({ hasText: "Hold 10" });
  // Native controls are browser-owned; seek the real decoder and wait for its
  // presented frame rather than forcing a review clock or hidden mobile input.
  const seek = (time: number) => page.locator("#video-review video").evaluate((video: HTMLVideoElement, target) => { video.pause(); video.currentTime = target; }, time);
  const manual = page.getByRole("button", { name: "Review timing manually", exact: true });
  await manual.click();
  await expect(page.locator(".timestamp-review")).toContainText("Leave Start unset if the signal is missing");
  await expect(page.locator(".timestamp-review")).toContainText("Starting cursor");
  await expect(page.locator(".timestamp-review")).not.toContainText("Suggested");
  await expect(page.locator(".timestamp-review")).toContainText("This cursor is not a prediction");
  if (testInfo.project.name.endsWith("phone")) {
    const geometry = await page.evaluate(() => ({
      frame: document.querySelector("#video-review video")!.getBoundingClientRect().toJSON(),
      actions: document.querySelector(".timestamp-review-actions")!.getBoundingClientRect().toJSON(),
      hint: document.querySelector(".review-navigation-hint")!.getBoundingClientRect().toJSON(),
      nav: document.querySelector(".mobile-workflow")!.getBoundingClientRect().toJSON(),
    }));
    expect(geometry.frame.top).toBeGreaterThanOrEqual(0);
    expect(geometry.frame.bottom).toBeLessThan(geometry.hint.top);
    expect(geometry.hint.bottom).toBeLessThanOrEqual(geometry.actions.top);
    expect(geometry.actions.bottom).toBeLessThanOrEqual(geometry.nav.top);
  }
  await expect(start).toContainText("Not set");
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(start).toContainText("Not set");
  await manual.click();
  await seek(1);
  const acceptStart = page.getByRole("button", { name: /^Accept start at 1\.000s/ });
  await expect(acceptStart).toBeEnabled();
  await acceptStart.click();
  await page.getByRole("button", { name: "Review finish", exact: true }).click();
  await seek(6.6);
  const acceptFinish = page.getByRole("button", { name: /^Set reviewed finish at 6\.600s/ });
  await expect(acceptFinish).toBeEnabled();
  await acceptFinish.click();
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  await page.getByRole("button", { name: "Review Hold 10 contact", exact: true }).click();
  await expect(page.locator(".timestamp-review")).toContainText("compare totals instead");
  await expect(hold).toContainText("Not set");
  await seek(7.5);
  const invalidContact = page.getByRole("button", { name: /^Accept Hold 10 at 7\.500s/ });
  await expect(invalidContact).toBeEnabled();
  await invalidContact.click();
  await expect(page.locator(".timestamp-review [role=alert]")).toContainText("before the accepted Finish Pad");
  await expect(hold).toContainText("Not set");
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(hold).toContainText("Not set");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
});

test("the shipped policy and source identity are visible without claiming analysis provenance", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("worker-src 'self' blob:");
  const buildResponse = await request.get("/build-info.json");
  expect(buildResponse.ok()).toBe(true);
  const build = await buildResponse.json();
  expect(build.appVersion).toBe(pkg.version);
  expect(build.commitSha).toMatch(/^[a-f0-9]{40}$/);
  expect(typeof build.workingTreeDirty).toBe("boolean");
  await expect(page.locator("[data-build-identity]")).toHaveAttribute("data-build-identity", build.commitSha);
  const entry = page.getByRole("button", { name: "Try a practice recording", exact: true });
  await expect(entry).toBeEnabled();
  const bounds = await entry.boundingBox();
  const unobscuredBottom = await page.evaluate(() => {
    const nav = document.querySelector(".mobile-workflow");
    return nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
  });
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(unobscuredBottom);
});

test("malformed imported text cannot poison a saved attempt", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  const input = page.locator('input[accept="application/json,.json"]');
  const valid = createPracticeSession("a");
  const upload = (value: unknown) => input.setInputFiles({ name: "attempt.climbiq-session.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
  await upload(valid);
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
  await upload({ ...valid, id: valid.id + "-bad", climberName: 42, notes: {} });
  await expect(page.locator(".library-transfer")).toContainText("not a ClimbIQ analysis session");
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(page.locator(".session-card .status-message")).toContainText("Saved");
});

test("keyboard wall corners can be entered out of order and cleared without inventing points", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI exercises media under WebKit; the local Windows decoder is unavailable.");
  await page.goto("/");
  await page.getByRole("button", { name: "Try a practice recording", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByRole("button", { name: "Capture current full-wall frame", exact: true }).click();
  await page.getByText("Fine-tune corner coordinates", { exact: true }).click();
  const corners = page.locator(".corner-coordinate-grid fieldset");
  const x = (index: number) => corners.nth(index).getByLabel("X (% of frame)");
  const y = (index: number) => corners.nth(index).getByLabel("Y (% of frame)");
  const save = page.getByRole("button", { name: "Save wall calibration", exact: true });
  await x(3).fill("10");
  await y(3).fill("10");
  await expect(page.locator(".wall-corner-marker")).toHaveCount(1);
  await expect(save).toBeDisabled();
  for (const [index, px, py] of [[1, 90, 90], [0, 10, 90], [2, 90, 10]]) {
    await x(index).fill(String(px)); await y(index).fill(String(py));
  }
  await page.getByRole("checkbox", { name: /The camera stays fixed/ }).check();
  await expect(save).toBeEnabled();
  await y(1).fill("");
  await expect(y(1)).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(page.locator(".wall-corner-marker")).toHaveCount(3);
  await y(1).fill("90");
  await save.click();
  await expect(page.locator("#center-of-mass")).toContainText("wall calibration saved");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const downloaded = await (await downloadPromise).path();
  const dataset = JSON.parse(await readFile(downloaded!, "utf8"));
  const build = await (await page.request.get("/build-info.json")).json();
  expect(dataset.exportBuild).toEqual(build);
  expect(dataset.analysisBuild).toBeNull();
});

test("phone frame review keeps its evidence and acceptance action above navigation", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media geometry is verified by macOS WebKit CI.");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try a practice recording", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  for (const height of [740, 568]) {
    await page.setViewportSize({ width: 320, height });
    await page.getByRole("button", { name: "Review practice Hold 10", exact: true }).click();
    const accept = page.getByRole("button", { name: /^Accept Hold 10 at/ });
    await expect(accept).toBeEnabled();
    const bounds = await accept.boundingBox();
    const geometry = await page.evaluate(() => ({
      timestamps: document.querySelector(".timestamp-review-times")!.getBoundingClientRect().bottom,
      frame: document.querySelector("#video-review video")!.getBoundingClientRect().height,
      navigation: document.querySelector(".mobile-workflow")!.getBoundingClientRect().top,
      focused: document.activeElement?.classList.contains("timestamp-review"),
    }));
    expect(geometry.frame).toBeGreaterThan(70);
    expect(geometry.timestamps).toBeLessThanOrEqual(bounds!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(geometry.navigation);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(geometry.focused).toBe(true);
    await page.getByRole("button", { name: "Close review", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review practice Hold 10", exact: true })).toBeFocused();
  }
  const finishOpener = page.getByRole("button", { name: "Review finish / mark pad", exact: true });
  await finishOpener.click();
  await expect(page.locator(".timestamp-review")).toBeFocused();
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(finishOpener).toBeFocused();
});

test("opening practice lands at its current review action on a phone", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Phone media landing is verified by macOS WebKit CI.");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try a practice recording", exact: true }).click();
  const review = page.getByRole("button", { name: "Review practice Hold 10", exact: true });
  await expect(review).toBeFocused();
  const bounds = await review.boundingBox();
  const navigation = await page.locator(".mobile-workflow").evaluate(element => element.getBoundingClientRect().top);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(navigation);
});

async function importComparison(page: Page, personal = false) {
  const sessions = [createPracticeSession("a"), createPracticeSession("b")];
  sessions.forEach((session, index) => {
    session.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
    if (personal) session.attemptLineageId = `personal-recording-fixture-${index}`;
  });
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.locator('input[accept="application/json,.json"]').setInputFiles({ name: "reviewed-workflow-fixtures.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(createSessionLibraryBackup(sessions))) });
  await page.getByLabel("Baseline attempt", { exact: true }).selectOption(sessions[0].id);
  await page.getByLabel("New attempt", { exact: true }).selectOption(sessions[1].id);
}

test("synthetic context review keeps observations separate and resets for a reversed pair", async ({ page }, testInfo) => {
  // Authored sessions exercise the control; checking it is not an accuracy label
  // or a real climber's training decision.
  await importComparison(page);
  const review = page.locator(".comparison-context-check input");
  const claims = page.locator(".comparison-row.gained, .comparison-row.lost");
  await expect(review).not.toBeChecked();
  await expect(claims).toHaveCount(0);
  await expect(page.locator(".comparison-row").filter({ hasText: "Total climb" })).toContainText("0.400s · Recorded difference");
  await expect(page.getByRole("link", { name: "Replay changed bottom phase" })).toHaveCount(0);
  await reviewSyntheticComparisonContext(page);
  await expect(page.locator(".comparison-insight")).toContainText("0.400s faster overall");
  await expect(page.getByRole("link", { name: "Replay changed bottom phase" })).toHaveCount(1);
  const candidate = await page.getByLabel("New attempt", { exact: true }).inputValue();
  await page.getByLabel("Baseline attempt", { exact: true }).selectOption(candidate);
  await expect(review).not.toBeChecked();
  await expect(claims).toHaveCount(0);
  await expect(page.locator(".comparison-row").filter({ hasText: "Total climb" })).toContainText("+0.400s · Recorded difference");
  await page.screenshot({ path: testInfo.outputPath("context-review-reset.png"), fullPage: true });
});

test("a pending practice landing yields to an outside export action", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Native media readiness is verified by macOS WebKit CI.");
  await page.goto("/");
  await page.evaluate(() => {
    // Hold only the visible player's readiness notifications. The detached
    // preparation decoder and native video decoding still run normally.
    const events = ["loadedmetadata", "loadeddata", "canplay"];
    const gate = (event: Event) => {
      if (event.target instanceof HTMLVideoElement && event.target.closest("#video-review")) event.stopImmediatePropagation();
    };
    for (const event of events) window.addEventListener(event, gate, true);
    (window as any).__releaseVisibleMediaReadiness = () => {
      for (const event of events) window.removeEventListener(event, gate, true);
      document.querySelector("#video-review video")!.dispatchEvent(new Event("loadeddata"));
    };
  });
  await page.getByRole("button", { name: "Try a practice recording", exact: true }).click();
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
  await expect(page.getByRole("button", { name: "Review practice Hold 10", exact: true })).toBeDisabled();
  await expect.poll(() => page.locator("#video-review video").evaluate(video => (video as HTMLVideoElement).readyState >= 2)).toBe(true);
  const exportButton = page.getByRole("button", { name: "Download data", exact: true });
  await exportButton.focus();
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const downloaded = await (await downloadPromise).path();
  expect(JSON.parse(await readFile(downloaded!, "utf8")).analysisBuild).toBeNull();
  // Safari pointer/download handling may blur the activating button. Establish
  // explicit outside keyboard focus before testing the later readiness event.
  await exportButton.focus();
  await expect(exportButton).toBeFocused();
  await page.evaluate(() => (window as any).__releaseVisibleMediaReadiness());
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await expect(exportButton).toBeFocused();
});

test("known practice pair prepares together and replays the largest reviewed phase", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media fast path runs in macOS WebKit CI.");
  await importComparison(page);
  await reviewSyntheticComparisonContext(page);
  await page.getByRole("link", { name: "Replay changed bottom phase" }).click();
  await page.getByRole("button", { name: "Prepare practice replay", exact: true }).click();
  await expect(page.locator(".comparison-verified")).toHaveCount(2);
  await expect(page.locator(".comparison-recording-check input")).toHaveCount(0);
  const replay = page.getByRole("button", { name: "Replay changed bottom phase", exact: true });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect.poll(() => page.locator(".comparison-players video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).currentTime > 1.1))).toBe(true);
  await expect(page.locator(".comparison-playback-status")).toContainText("Bottom: start → Hold 10");
  await expect(page.getByRole("button", { name: "Replay bottom phase", exact: true })).toHaveAttribute("aria-pressed", "true");
  const frames = await page.locator(".comparison-players video").evaluateAll(videos => videos.map(video => {
    const box = video.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
  }));
  expect(Math.abs(frames[0].top - frames[1].top)).toBeLessThanOrEqual(1);
  const unobscuredBottom = await page.evaluate(() => {
    const nav = document.querySelector(".mobile-workflow");
    return nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
  });
  for (const frame of frames) {
    expect(frame.top).toBeGreaterThanOrEqual(0);
    expect(frame.bottom).toBeLessThanOrEqual(unobscuredBottom);
  }
  await page.screenshot({ path: testInfo.outputPath("reviewed-phase-replay.png") });
  if (testInfo.project.name.includes("phone")) {
    await page.setViewportSize({ width: 320, height: 568 });
    await replay.click();
    const shortFrames = await page.locator(".comparison-players video").evaluateAll(videos => videos.map(video => {
      const box = video.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
    }));
    const navigation = await page.locator(".mobile-workflow").evaluate(element => element.getBoundingClientRect().top);
    expect(Math.abs(shortFrames[0].top - shortFrames[1].top)).toBeLessThanOrEqual(1);
    for (const frame of shortFrames) {
      expect(frame.top).toBeGreaterThanOrEqual(0);
      expect(frame.bottom).toBeLessThanOrEqual(navigation);
    }
    await page.screenshot({ path: testInfo.outputPath("short-phone-reviewed-phase.png") });
  }
});

test("a mismatched bundled recording never receives automatic identity confirmation", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Media identity rejection runs in macOS WebKit CI.");
  await importComparison(page);
  await reviewSyntheticComparisonContext(page);
  await page.route("**/samples/climbiq-practice-b.mp4", async route => route.fulfill({ contentType: "video/mp4",
    body: await readFile(path.resolve("public/samples/climbiq-practice-a.mp4")) }));
  await page.getByRole("button", { name: "Prepare practice replay", exact: true }).click();
  await expect(page.locator(".comparison-playback [role=alert]")).toContainText("integrity check failed");
  await expect(page.getByRole("button", { name: "Replay changed bottom phase", exact: true })).toBeDisabled();
  await expect(page.locator(".comparison-verified")).toHaveCount(1);
});

test("personal recordings still require an explicit confirmation on each side", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "Personal media confirmation runs in macOS WebKit CI.");
  await importComparison(page, true);
  await expect(page.getByRole("button", { name: "Prepare practice replay", exact: true })).toHaveCount(0);
  await page.getByLabel("Attach baseline recording", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await page.getByLabel("Attach new attempt recording", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-b.mp4"));
  const confirmations = page.locator(".comparison-recording-check input");
  const replay = page.getByRole("button", { name: "Replay whole attempt", exact: true });
  await expect(confirmations).toHaveCount(2);
  await expect(replay).toBeDisabled();
  await confirmations.nth(0).check();
  await expect(replay).toBeDisabled();
  await confirmations.nth(1).check();
  await expect(replay).toBeEnabled();
});
