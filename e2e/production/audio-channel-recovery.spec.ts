import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";

test("native encoded stereo recovers one audio protocol when the final tone cancels in the mix", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(process.platform === "win32" && testInfo.project.name.startsWith("webkit"), "macOS CI verifies the native codec; local Windows WebKit cannot decode this fixture.");
  // Original CC0 geometry and audio, with unchanged detector thresholds.
  // This validates a codec/workflow regression, never real-climber accuracy.
  const file = path.resolve("e2e/fixtures/dual-lane-stereo-cancellation.mp4");
  const reference = JSON.parse(await readFile(file.replace(/\.mp4$/, ".reference.json"), "utf8"));
  expect(reference).toMatchObject({ synthetic: true, workflowOnly: true, audioChannels: 2,
    channelPhases: { preparation: [1, 1], final: [1, -1] }, authoredStart: 2.4, authoredLaunch: 2.7 });
  expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference.sha256);
  await page.goto("/");
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  await page.getByLabel("Choose video", { exact: true }).setInputFiles(file);
  await expect(page.locator(".video-meta-line")).toContainText("Ready");
  await page.getByLabel("Analysis scope", { exact: true }).selectOption("timing-only");
  const analyze = page.locator(".analyze-button");
  await analyze.click();
  await expect(analyze).toBeDisabled();
  await expect(analyze).toBeEnabled({ timeout: 60_000 });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data", exact: true }).click();
  const data = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  const audit = data.startLaneEvidenceAudit, recovery = audit.audioChannelRecovery;
  expect(audit).toMatchObject({ isGroundTruthLabel: false, audioConfidence: "High" });
  expect(recovery).not.toBeNull();
  expect(recovery.isIndependentEvidence).toBe(false);
  expect(recovery.mixedResult.confidence).not.toBe("High");
  expect(recovery.channels).toHaveLength(2);
  expect(recovery.channels.map((channel: any) => channel.channel)).toEqual([0, 1]);
  for (const channel of recovery.channels) {
    expect(channel.sequence).toHaveLength(3);
    expect(channel.timingWindow.isEventAccuracyBound).toBe(false);
    expect(channel.sequence.every((tone: any) => tone.qualifiedFrames >= 4)).toBe(true);
  }
  const selected = recovery.channels[recovery.selectedChannel];
  expect(selected.rawTime).toBe(Math.min(...recovery.channels.map((channel: any) => channel.rawTime)));
  expect(audit.audioSearchHintTime).toBe(selected.rawTime);
  expect(audit.audioTimingWindow).toEqual(selected.timingWindow);
  expect(recovery.nominalWindowEnvelope).toMatchObject({ isContinuousObservedSupport: false, isEventAccuracyBound: false });
  const audioEvidence = data.candidates.startSignal.filter((candidate: any) => candidate.candidateType === "changed-pitch final start beep");
  expect(audioEvidence).toHaveLength(1); // Two channels remain ONE audio source.
  expect(audioEvidence[0]).toMatchObject({ confidence: "High", candidateRawTime: selected.rawTime, accepted: true });
  expect(data.acceptedTimestamps.find((marker: any) => marker.markerId === "startSignal").acceptedRawTime).toBe(selected.rawTime);
  expect(data.acceptedTimestamps.find((marker: any) => marker.markerId === "finishPad").acceptedRawTime).toBeNull();
  await testInfo.attach("native-stereo-workflow-dataset", { body: JSON.stringify(data, null, 2), contentType: "application/json" });
});
