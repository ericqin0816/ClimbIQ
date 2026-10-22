import { test, expect } from "./fixtures";
import { createPracticeSession } from "../../src/lib/practiceRecordings";

test("the shipped policy and source identity are visible without claiming analysis provenance", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("worker-src 'self' blob:");
  const buildResponse = await request.get("/build-info.json");
  expect(buildResponse.ok()).toBe(true);
  const build = await buildResponse.json();
  expect(build.appVersion).toBe("0.30.0");
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
  const { readFile } = await import("node:fs/promises");
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
  }
});
