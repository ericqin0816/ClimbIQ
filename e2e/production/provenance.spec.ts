import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { test, expect } from "./fixtures";
import { createPracticeSession } from "../../src/lib/practiceRecordings";
import type { AppBuildIdentity } from "../../src/lib/buildIdentity";

// Imported schema fixture only: this stamp does not represent a measured detector run.
const importedBuild: AppBuildIdentity = { schemaVersion: 1, appVersion: "0.28.0", commitSha: "b".repeat(40), workingTreeDirty: false };

async function importKnownAnalysis(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  const session = { ...createPracticeSession("a"), name: "Imported provenance fixture", analysisBuild: importedBuild };
  await page.locator('input[accept="application/json,.json"]').setInputFiles({
    name: "imported-provenance.climbiq-session.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(session)),
  });
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.600s");
}

async function dataset(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const file = await (await downloadPromise).path();
  const result = JSON.parse(await readFile(file!, "utf8"));
  const currentBuild = await (await page.request.get("/build-info.json")).json();
  expect(result.appVersion).toBe(pkg.version);
  expect(result.exportBuild).toEqual(currentBuild);
  return result;
}

async function libraryBackup(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export saved library", exact: true }).click(),
  ]);
  const result = JSON.parse(await readFile((await download.path())!, "utf8"));
  const currentBuild = await (await page.request.get("/build-info.json")).json();
  expect(result.exportBuild.appVersion).toBe(pkg.version);
  expect(result.exportBuild).toEqual(currentBuild);
  return result;
}

test("imported Start provenance survives session edits, save, reload and re-export without video", async ({ page }) => {
  await importKnownAnalysis(page);
  await page.getByText("Session details & saved analyses", { exact: true }).click();
  await page.getByText("Session name and athlete details", { exact: true }).click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Session edits preserve the original Start provenance.");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect(page.locator(".session-card .status-message")).toContainText("Saved");
  const edited = (await libraryBackup(page)).sessions[0];
  expect(edited.analysisBuild).toEqual(importedBuild);
  expect(edited.notes).toBe("Session edits preserve the original Start provenance.");
  await page.reload();
  await expect(page.locator(".attempt-library-list > button")).toHaveCount(1);
  await page.locator(".attempt-library-list > button").first().click();
  expect((await libraryBackup(page)).sessions[0].analysisBuild).toEqual(importedBuild);
});

test("failed media replacement preserves imported provenance and a new practice attempt clears it", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI verifies the media decoder; Windows WebKit cannot decode these fixtures.");
  await importKnownAnalysis(page);
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(path.resolve("public/samples/climbiq-practice-a.mp4"));
  await page.getByRole("button", { name: "Attach to this attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.locator("#timing-markers summary").click();
  const finish = page.getByLabel("Finish Pad raw video time", { exact: true });
  await finish.fill("6.400");
  await finish.press("Enter");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.400s");
  const corrected = await dataset(page);
  expect(corrected.analysisBuild).toEqual(importedBuild);
  expect(corrected.acceptedTimestamps.find((marker: any) => marker.markerId === "finishPad")).toMatchObject({ acceptedRawTime: 6.4, acceptanceMode: "manual-entry" });
  const player = page.locator("#video-review video");
  const originalSource = await player.getAttribute("src");
  await page.getByLabel("Replace video", { exact: true }).setInputFiles({ name: "undecodable.mp4", mimeType: "video/mp4", buffer: Buffer.from("invalid nonempty media") });
  await expect(page.locator(".upload-error")).toBeVisible();
  await expect(player).toHaveAttribute("src", originalSource!);
  expect((await dataset(page)).analysisBuild).toEqual(importedBuild);
  await page.getByRole("button", { name: "Open practice B as a new attempt", exact: true }).click();
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await expect(page.locator("#results .summary-primary-metric strong")).toHaveText("5.200s");
  await expect(page.getByRole("button", { name: "Review practice Hold 10", exact: true })).toBeFocused();
  expect((await dataset(page)).analysisBuild).toBeNull();
});
