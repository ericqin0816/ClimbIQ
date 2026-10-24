import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";

const fixture = path.resolve("e2e/fixtures/audio-start-review.mp4");
const fixtureSha = "d50025ef6d94a03154bb09375240f366d0d40d0463c041478b969808420fd864";

test.beforeEach(async ({ page }, info) => {
  test.skip(process.platform === "win32" && info.project.name.startsWith("webkit"), "macOS CI exercises native WebKit codecs.");
  expect(createHash("sha256").update(await readFile(fixture)).digest("hex")).toBe(fixtureSha);
  await page.goto("/");
  const build = await (await page.request.get("/build-info.json")).json();
  await info.attach("served-build", { body: JSON.stringify(build, null, 2), contentType: "application/json" });
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(fixture);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
});

async function exported(page: Page, info: TestInfo, label: string) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await writeFile(info.outputPath(`${label}.json`), bytes);
  await info.attach(label, { body: bytes, contentType: "application/json" });
  return JSON.parse(bytes.toString("utf8"));
}

function protectedState(data: any) {
  return { accepted: data.acceptedTimestamps, candidates: data.candidates,
    automatic: data.automationAudit, lanes: data.startLaneEvidenceAudit,
    finish: data.finishEvidenceAudit, analysisBuild: data.analysisBuild,
    zones: data.zones, calibration: data.calibration };
}

async function screenshot(page: Page, info: TestInfo, label: string) {
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true });
}

async function findAndInspect(page: Page, info: TestInfo, label: string, before: any) {
  const panel = page.locator("[data-audio-start-review]");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Find a recorded start cue", exact: true }).click();
  const inspect = panel.getByRole("button", { name: /^Inspect recorded cue at/ });
  await expect(inspect).toBeEnabled();
  const proposed = Number((await inspect.textContent())!.match(/at ([\d.]+)s/)![1]);
  expect(Math.abs(proposed - 2.4)).toBeLessThanOrEqual(.04);
  const found = await exported(page, info, `${label}-after-find`);
  expect(protectedState(found)).toEqual(protectedState(before));
  await inspect.click();
  await expect(page.locator(".timestamp-review")).toHaveAttribute("data-navigation-only", "true");
  const inspected = await exported(page, info, `${label}-after-inspect`);
  expect(protectedState(inspected)).toEqual(protectedState(before));
  await screenshot(page, info, `${label}-recorded-cue-inspected`);
}

test("explicit audio review remains discoverable after ordinary Start and Finish analysis", async ({ page }, info) => {
  test.setTimeout(120_000);
  const imported = await exported(page, info, "imported");
  await page.getByLabel("Analysis scope", { exact: true }).selectOption("timing-only");
  const analyze = page.getByRole("button", { name: "Find start & finish", exact: true });
  await analyze.click();
  // The visible label changes to “Analyzing climb…” while this control is busy.
  const analysisControl = page.locator(".analyze-button");
  await expect(analysisControl).toBeDisabled();
  await expect(analysisControl).toBeEnabled({ timeout: 90_000 });
  const analyzed = await exported(page, info, "after-ordinary-analysis");
  expect(analyzed.automationAudit.automaticAnalysis).toBeTruthy();
  expect(analyzed.automationAudit).not.toEqual(imported.automationAudit);
  const counts = Object.fromEntries(Object.entries(analyzed.candidates).map(([key, candidates]) => [key, (candidates as any[]).length]));
  await info.attach("actual-analysis-state", { body: JSON.stringify({ counts, automatic: analyzed.automationAudit,
    accepted: analyzed.acceptedTimestamps, scope: "Native authored CC0 workflow, not field accuracy; candidate counts are reported without requiring invented proposals." }, null, 2), contentType: "application/json" });
  await screenshot(page, info, "after-ordinary-analysis");
  const manual = page.getByRole("button", { name: "Review timing manually", exact: true });
  await expect(manual).toBeVisible();
  await manual.click();
  await findAndInspect(page, info, "post-analysis-manual-review", analyzed);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  expect(protectedState(await exported(page, info, "post-analysis-review-closed"))).toEqual(protectedState(analyzed));
});

test("a manually accepted Start keeps explicit audio review available without rewriting timing", async ({ page }, info) => {
  const manual = page.getByRole("button", { name: "Review timing manually", exact: true });
  await manual.click();
  const before = await exported(page, info, "before-first-manual-cue");
  await findAndInspect(page, info, "first-manual-review", before);
  await page.getByRole("button", { name: "Jump to time", exact: true }).click();
  const field = page.getByLabel("Raw video time (seconds)", { exact: true });
  await field.fill("2.4"); await field.press("Enter");
  const accept = page.getByRole("button", { name: /^Accept start at 2\.400s/ });
  await expect(accept).toBeEnabled();
  await accept.click();
  const accepted = await exported(page, info, "after-manual-start-accepted");
  const start = accepted.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal");
  expect(start).toMatchObject({ source: "Manual", acceptedRawTime: 2.4, acceptanceMode: "frame-review", userAccepted: true, isGroundTruthLabel: false });
  expect(start.note).toContain("unverified recorded-cue suggestion");
  expect(accepted.candidates).toEqual(before.candidates);
  expect(accepted.startLaneEvidenceAudit).toEqual(before.startLaneEvidenceAudit);
  await screenshot(page, info, "after-manual-start-accepted");
  await expect(manual).toBeVisible();
  await manual.click();
  expect(protectedState(await exported(page, info, "manual-start-review-reopened"))).toEqual(protectedState(accepted));
  await findAndInspect(page, info, "reopened-manual-review", accepted);
  await expect(page.locator("[data-audio-review-result]")).toContainText("This suggestion has not changed accepted timing.");
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  expect(protectedState(await exported(page, info, "reopened-review-closed"))).toEqual(protectedState(accepted));
  await expect(manual).toBeVisible();
});
