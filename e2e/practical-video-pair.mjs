import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startTestBrowser } from "./test-browser.mjs";
import { readSessionLibraryJson } from "./session-library.mjs";

// This practical workflow uses native decoding, real detector runs, real files,
// and public UI controls. Review cursors are operational inputs, not event labels.
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = path.resolve(argument("manifest") ?? "test-results/practical-online/manifest.json");
const reportPath = path.resolve(argument("report") ?? "test-results/practical-online/pair-round1.json");
const appUrl = argument("url") ?? process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5190/";
const restoreBackupOnly = argument("restore-backup");
const guided = process.argv.includes("--guided"), phone = process.argv.includes("--phone"), backup = process.argv.includes("--backup");
const manualEntry = process.argv.includes("--manual-entry");
const requireContextGate = process.argv.includes("--require-context-gate");
const contextOptions = { viewport: phone ? { width: 320, height: 740 } : { width: 1440, height: 1050 },
  isMobile: phone, hasTouch: phone, deviceScaleFactor: 1, acceptDownloads: true };
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.clips?.length, 2, "A practical comparison needs exactly two distinct recordings.");
const outputDirectory = reportPath.slice(0, -path.extname(reportPath).length);
await mkdir(path.dirname(reportPath), { recursive: true });
await access(reportPath).then(() => { throw new Error(`Refusing to overwrite ${reportPath}`); }, error => { if (error.code !== "ENOENT") throw error; });
await mkdir(outputDirectory, { recursive: true });
for (const clip of manifest.clips) {
  assert.equal(typeof clip.id, "string");
  clip.file = path.resolve(path.dirname(manifestPath), clip.file);
  await access(clip.file);
  assert.ok(clip.review?.isGroundTruthLabel === false, "Operational review cursors must explicitly disclaim independent ground truth.");
  const { start, hold10, finish } = clip.review;
  assert.ok([start, finish].every(Number.isFinite) && start >= 0 && start < finish,
    "Endpoint review cursors must be finite and ordered Start < Finish.");
  assert.ok(hold10 === null || hold10 === undefined || (Number.isFinite(hold10) && start < hold10 && hold10 < finish),
    "An observable Hold 10 cursor must lie between Start and Finish; otherwise omit it.");
  clip.sha256 = createHash("sha256").update(await readFile(clip.file)).digest("hex");
}
assert.notEqual(manifest.clips[0].sha256, manifest.clips[1].sha256, "Duplicate files cannot establish an actual pair workflow.");
assert.notEqual(manifest.clips[0].id, manifest.clips[1].id);
const report = { schemaVersion: 1, appUrl, guided, phone, backup, manualEntry, requireContextGate, restoreBackupOnly: Boolean(restoreBackupOnly), startedAt: new Date().toISOString(), isGroundTruthLabel: false,
  scope: "Two-clip operational workflow; automation and manual correction reported separately. Not an independent detector validation or a same-athlete training conclusion.",
  clips: manifest.clips.map(({ file, ...clip }) => ({ ...clip, fileName: path.basename(file) })), stages: [], visibilityActions: [], pageErrors: [], policyViolations: [] };
let owner, browser, page;
const stage = async (name, action, { continueOnFailure = false } = {}) => {
  const started = performance.now();
  try { const result = await action(); report.stages.push({ name, passed: true, elapsedMs: performance.now() - started, ...result }); return result; }
  catch (error) {
    const diagnostic = page ? await page.evaluate(() => ({ title: document.title, status: document.querySelector(".quick-analysis-box .status-message")?.textContent,
      uploadError: document.querySelector(".upload-error")?.textContent, review: document.querySelector(".timestamp-review")?.textContent,
      storage: document.querySelector("[data-session-storage-state]")?.getAttribute("data-session-storage-state"),
      comparison: { status: document.querySelector(".comparison-playback-status")?.textContent,
        alerts: Array.from(document.querySelectorAll("#comparison-replay [role=alert]")).map(node => node.textContent), hidden: document.hidden,
        players: Array.from(document.querySelectorAll(".comparison-players video")).map(video => ({ currentTime: video.currentTime,
          paused: video.paused, seeking: video.seeking, readyState: video.readyState, networkState: video.networkState,
          mediaErrorCode: video.error?.code ?? null, buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]) })),
        replayProbe: window.__practicalReplay ? { firstWaiting: window.__practicalReplay.firstWaiting, actions: window.__practicalReplay.actions,
          events: window.__practicalReplay.events, lastSamples: window.__practicalReplay.samples.slice(-12) } : null } })).catch(() => null) : null;
    report.stages.push({ name, passed: false, elapsedMs: performance.now() - started, error: String(error), diagnostic });
    if (continueOnFailure && page) await page.screenshot({ path: path.join(outputDirectory, `stage-${report.stages.length}-failure.png`), fullPage: true }).catch(() => {});
    if (!continueOnFailure) throw error;
  }
};
const reveal = async locator => {
  if (!manualEntry) return locator.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; });
  for (const details of await locator.locator("xpath=ancestor::details").all()) {
    if (await details.getAttribute("open") === null) {
      const summary = details.locator(":scope > summary");
      report.visibilityActions.push((await summary.innerText()).trim());
      await summary.click();
    }
  }
};
const library = async () => JSON.parse(await readSessionLibraryJson(expression => page.evaluate(expression)));
const dataset = async label => {
  const button = page.getByRole("button", { name: "Download data", exact: true });
  await reveal(button);
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  const data = JSON.parse(await readFile(await download.path(), "utf8"));
  await writeFile(path.join(outputDirectory, `${label}.json`), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  return data;
};
const markers = data => data.acceptedTimestamps.map(({ markerId, acceptedRawTime, source, confidence, acceptanceMode, isGroundTruthLabel, note }) =>
  ({ id: markerId, rawTime: acceptedRawTime, source, confidence, acceptanceMode, isGroundTruthLabel, note }));
const setMarker = async (label, time) => {
  const input = page.getByLabel(`${label} raw video time`, { exact: true });
  await reveal(input); await input.fill(String(time)); await input.press("Enter");
  await expect(page.locator(".timestamp-status")).toHaveCount(0);
};
const reviewMarker = async (clip, id, label, cursor) => {
  const started = performance.now();
  const controlActions = [];
  let jumpSubmission = null;
  if (manualEntry) {
    let opener = page.getByRole("button", { name: id === "startSignal" ? "Review timing manually" : id === "finishPad" ? "Review finish" : "Review Hold 10 contact", exact: true });
    if (id === "finishPad" && await opener.count() === 0) opener = page.getByRole("button", { name: "Review finish / mark pad", exact: true });
    await opener.click(); controlActions.push(`Open manual ${label}`);
    await page.getByRole("button", { name: "Jump to time", exact: true }).click(); controlActions.push("Open precise time navigation");
    const input = page.getByRole("textbox", { name: "Raw video time (seconds)", exact: true });
    await input.fill(String(cursor)); controlActions.push("Enter operational cursor");
    jumpSubmission = await input.evaluate(node => { const video = document.querySelector("#video-review video"); return {
      typedValue: node.value, currentTime: video.currentTime, seeking: video.seeking, readyState: video.readyState,
      acceptDisabled: document.querySelector(".timestamp-review-actions .primary").disabled,
      jumpDisabled: document.querySelector(".review-seek-form button").disabled,
    }; });
    await input.press("Enter"); controlActions.push("Jump to cursor");
    await expect.poll(() => page.locator("#video-review video").evaluate(video => video.currentTime), { timeout: 15000,
      message: `The requested ${label} cursor ${cursor}s must actually be reached before frame acceptance.` }).toBeCloseTo(cursor, 4);
  } else {
    await setMarker(label, cursor);
    const row = page.locator("#timing-markers tbody tr").filter({ has: page.getByRole("cell", { name: label, exact: true }) });
    await row.getByRole("button", { name: "Review", exact: true }).click();
  }
  const accept = page.locator(".timestamp-review-actions button.primary");
  await expect(accept).toBeEnabled({ timeout: 15000 });
  const frame = await page.locator(".timestamp-review").evaluate(node => ({ text: node.innerText,
    frameTimeSource: node.querySelector("[data-frame-time-source]")?.getAttribute("data-frame-time-source"),
    videoTime: document.querySelector("#video-review video").currentTime }));
  await page.locator("#video-review").screenshot({ path: path.join(outputDirectory, `${clip.id}-${id}-review.png`) });
  // Accept only the ready, natively decoded frame rendered by the real review UI.
  await accept.click();
  if (manualEntry) controlActions.push("Accept the displayed native frame");
  await expect(page.locator(".timestamp-review")).toHaveCount(0);
  return { markerId: id, requestedCursor: cursor, ...frame, manualEntry, controlActions, jumpSubmission, automatedCorrectionWorkflowMs: performance.now() - started,
    correctionTimeScope: "Automated UI actions, native readiness and screenshot; excludes participant search or thinking time.", isGroundTruthLabel: false };
};
const save = async name => {
  const before = await library();
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  await expect.poll(library, { timeout: 15000 }).not.toEqual(before);
  const saved = (await library()).find(session => session.name === name);
  assert.ok(saved, "Saved record was not committed."); return saved;
};
const upload = async clip => {
  await page.locator(".upload-dropzone input[type=file]").setInputFiles(clip.file);
  const choice = page.getByRole("button", { name: "Analyze as a new attempt", exact: true });
  await expect.poll(async () => (await choice.isVisible()) || (await page.locator(".upload-dropzone strong").textContent())?.trim() === path.basename(clip.file), { timeout: 20000 }).toBe(true);
  if (await choice.isVisible()) await choice.click();
  await expect(page.locator(".upload-dropzone strong")).toHaveText(path.basename(clip.file));
  await expect(page.locator(".video-meta-line")).toContainText("Ready", { timeout: 20000 });
  await expect(page.locator(".upload-error")).toHaveCount(0);
};
const importBackupAndReload = async (file, originalSessions) => {
  // Import intentionally resets only this transient decoder flag: a saved
  // measurement cannot establish a loaded HTMLVideoElement in a fresh context.
  const expected = originalSessions.map(session => session.videoMetadata ? { ...session,
    videoMetadata: { ...session.videoMetadata, metadataLoaded: false } } : session);
  assert.deepEqual(await library(), []);
  await page.locator('input[accept="application/json,.json"]').setInputFiles(file);
  await expect.poll(library).toEqual(expected);
  await page.reload();
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  const restored = await library(); assert.deepEqual(restored, expected);
  assert.ok(restored.every(session => !session.videoMetadata || session.videoMetadata.metadataLoaded === false));
  await expect(page.locator("#video-review video, .comparison-players video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replay whole attempt", exact: true })).toBeDisabled();
  return { restoredCount: restored.length, allSavedFieldsPreservedExceptTransientDecoderReadiness: true,
    timestampsAndLineagesPreserved: true, importedDecoderFlagsFalse: true, noRestoredVideoAttachment: true };
};

try {
  report.build = await (await fetch(new URL("build-info.json", appUrl))).json();
  owner = await startTestBrowser({ label: "practical-pair", args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`);
  const context = await browser.newContext(contextOptions);
  page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await context.exposeBinding("__practicalPolicy", (_, description) => report.policyViolations.push(description));
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", event => void window.__practicalPolicy(`${event.effectiveDirective}: ${event.blockedURI}`)));
  await page.goto(appUrl);
  await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
  if (restoreBackupOnly) {
    await stage("focused actual downloaded backup reimport and reload without detector inference", async () => {
      const file = path.resolve(restoreBackupOnly), bytes = await readFile(file), exported = JSON.parse(bytes);
      assert.equal(exported.format, "climbiq-session-library"); assert.equal(exported.version, 1);
      const restored = await importBackupAndReload(file, exported.sessions);
      return { ...restored, actualDownloadedBackup: path.basename(file), sourceBackupSha256: createHash("sha256").update(bytes).digest("hex"), detectorInferenceRun: false };
    });
  } else {
  const savedSessions = [];
  for (const clip of manifest.clips) {
    await stage(`${clip.id}: ${manualEntry ? "import without detector inference" : "import and real timing-only analysis"}`, async () => {
      const imported = performance.now(); await upload(clip);
      const importMs = performance.now() - imported;
      if (savedSessions.length) {
        const fresh = await dataset(`${clip.id}-new-before-analysis`);
        assert.notEqual(fresh.session.attemptLineageId, savedSessions[0].attemptLineageId);
        assert.ok(fresh.acceptedTimestamps.every(marker => marker.acceptedRawTime === null), "New recording inherited accepted analysis.");
      }
      if (guided && !manualEntry) {
        await page.getByRole("button", { name: "Review timing manually", exact: true }).click();
        await expect(page.locator("#timestamp-review-instruction")).toContainText("Athlete movement alone does not establish the signal");
        await expect(page.locator("#timestamp-review-instruction")).toContainText("Leave Start unset if the signal is missing");
        await page.getByRole("button", { name: "Close review", exact: true }).click();
        const afterClose = await dataset(`${clip.id}-closed-manual-start`);
        assert.equal(markers(afterClose).find(marker => marker.id === "startSignal").rawTime, null);
      }
      if (manualEntry) {
        const unanalysed = await dataset(`${clip.id}-unanalysed`);
        assert.ok(markers(unanalysed).every(marker => marker.rawTime === null));
        return { importMs, detectorInferenceRun: false, automaticEndpointCount: null, automaticCoverageMeasured: false,
          manualEndpointCountNeeded: 2, manualEntryAvailable: await page.getByRole("button", { name: "Review timing manually", exact: true }).isEnabled() };
      }
      await page.getByLabel("Analysis scope", { exact: true }).selectOption("timing-only");
      const run = page.getByRole("button", { name: "Find start & finish", exact: true });
      const started = performance.now(); await run.click();
      await expect(page.getByRole("button", { name: "Analyzing climb…", exact: true })).toBeVisible();
      await expect(run).toBeEnabled({ timeout: 180000 });
      const analysisMs = performance.now() - started;
      const automatic = await dataset(`${clip.id}-automatic`);
      const accepted = markers(automatic);
      assert.ok(accepted.every(marker => marker.isGroundTruthLabel === false));
      return { importMs, analysisMs, manualStartEntryVerifiedWithoutAccepting: guided, automaticMarkers: accepted,
        automaticEndpointCount: accepted.filter(marker => ["startSignal", "finishPad"].includes(marker.id) && marker.rawTime !== null).length,
        manualEndpointCountNeeded: accepted.filter(marker => ["startSignal", "finishPad"].includes(marker.id) && marker.rawTime === null).length,
        audit: automatic.automationAudit, warnings: automatic.detectionWarnings };
    });
    await stage(`${clip.id}: native frame review, save and failed replacement recovery`, async () => {
      const name = `Public workflow ${clip.id}`;
      const nameInput = page.getByRole("textbox", { name: "Session name", exact: true, includeHidden: true });
      await reveal(nameInput); await nameInput.fill(name);
      await page.getByRole("textbox", { name: "Climber", exact: true }).fill(clip.athlete ?? `Unknown public athlete ${clip.id}`);
      await page.getByRole("textbox", { name: "Notes", exact: true }).fill(`Operational native-frame workflow for ${clip.sourceUrl ?? "public clip"}. Review cursors are not independent event labels. ${clip.review.basis ?? ""}`);
      const frames = [];
      frames.push(await reviewMarker(clip, "startSignal", "Start Signal", clip.review.start));
      frames.push(await reviewMarker(clip, "finishPad", "Finish Pad", clip.review.finish));
      if (Number.isFinite(clip.review.hold10)) frames.push(await reviewMarker(clip, "hold10", "Hold 10", clip.review.hold10));
      if (guided && !Number.isFinite(clip.review.hold10)) {
        await page.getByRole("button", { name: "Review Hold 10 contact", exact: true }).click();
        await expect(page.locator("#timestamp-review-instruction")).toContainText("only a navigation aid");
        await expect(page.locator("#timestamp-review-instruction")).toContainText("close review and compare totals instead");
        await page.getByRole("button", { name: "Close review", exact: true }).click();
      }
      const reviewed = await dataset(`${clip.id}-reviewed`);
      for (const frame of frames) assert.equal(markers(reviewed).find(marker => marker.id === frame.markerId).acceptanceMode, "frame-review");
      assert.equal(reviewed.hold10PhaseAnalysis.available, Number.isFinite(clip.review.hold10));
      if (manualEntry) await page.getByRole("link", { name: "Save this attempt", exact: true }).click();
      const saved = await save(name); savedSessions.push(saved);
      const player = page.locator("#video-review video"), source = await player.getAttribute("src");
      await page.getByLabel("Replace video", { exact: true }).setInputFiles({ name: "undecodable.mp4", mimeType: "video/mp4", buffer: Buffer.from("Not a decodable video") });
      await expect(page.locator(".upload-error")).toBeVisible();
      await expect(player).toHaveAttribute("src", source);
      const afterFailure = await dataset(`${clip.id}-after-failed-replacement`);
      assert.deepEqual(afterFailure.acceptedTimestamps, reviewed.acceptedTimestamps);
      assert.equal(afterFailure.session.attemptLineageId, saved.attemptLineageId);
      return { frames, savedId: saved.id, lineage: saved.attemptLineageId, unresolvedContactEntryClosedWithoutAccepting: guided && !Number.isFinite(clip.review.hold10), reviewedMarkers: markers(reviewed),
        ...(manualEntry ? { baseReviewSaveControlActions: ["Import recording", ...frames.flatMap(frame => frame.controlActions), "Follow Save this attempt", "Save Session"],
          actionScope: "Scripted core import/review/save controls with supplied operational cursors; additional metadata entry, evidence exports, detail-summary navigation and recovery checks are separate. Not human search time or a minimum action count." } : {}),
        phases: reviewed.hold10PhaseAnalysis, savedAfterFailureUnchanged: true };
    });
  }
  await stage("reload restores both distinct attempts without stale video attachments", async () => {
    const committed = await library(); await page.reload();
    await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
    assert.deepEqual(await library(), committed);
    await expect(page.locator(".comparison-players video")).toHaveCount(0);
    assert.notEqual(savedSessions[0].attemptLineageId, savedSessions[1].attemptLineageId);
    return { savedCount: committed.length, unchanged: true, replayRequiresReattachment: true };
  });
  await stage("distinct real recordings attach and replay available accepted ranges", async () => {
    await reveal(page.getByLabel("Baseline attempt", { exact: true }));
    await page.getByLabel("Baseline attempt", { exact: true }).selectOption(savedSessions[0].id);
    await page.getByLabel("New attempt", { exact: true }).selectOption(savedSessions[1].id);
    const identity = page.locator(".comparison-identity-check input");
    const requiredIdentityConfirmation = await identity.count() > 0;
    if (requiredIdentityConfirmation) await identity.check();
    const contextConfirmation = page.locator(".comparison-context-check input");
    let comparisonDecisionScope = { comparabilityGateAvailable: false };
    if (requireContextGate) await expect(contextConfirmation).toHaveCount(1);
    if (await contextConfirmation.count()) {
      // The supplied Start cursors are departure-window workflow inputs. They
      // cannot honestly authorize a same-physical-event training conclusion.
      await expect(contextConfirmation).not.toBeChecked();
      await expect(page.locator(".comparison-table")).toContainText("Recorded difference");
      await expect(page.locator(".comparison-table .gained, .comparison-table .lost")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Replay changed .* phase$/ })).toHaveCount(0);
      comparisonDecisionScope = { comparabilityGateAvailable: true, comparableEventsConfirmed: false,
        numericDeltaIsObservational: true, gainOrChangedPhaseRecommendationSuppressed: true };
    }
    const players = page.locator(".comparison-players video");
    await page.getByLabel("Attach baseline recording", { exact: true }).setInputFiles(manifest.clips[0].file);
    await page.getByLabel("Attach new attempt recording", { exact: true }).setInputFiles(manifest.clips[1].file);
    const confirmations = page.locator(".comparison-recording-check input");
    await expect(confirmations).toHaveCount(2); await confirmations.nth(0).check(); await confirmations.nth(1).check();
    const whole = page.getByRole("button", { name: "Replay whole attempt", exact: true });
    await expect(whole).toBeEnabled({ timeout: 20000 });
    let swappedRecordingCheck = null;
    if (manualEntry) {
      // These personal sessions have no stored content hash. An unrelated file
      // covering the range must remain unconfirmed; do not claim hash rejection.
      const originalSources = await players.evaluateAll(videos => videos.map(video => video.src));
      const baselineInput = page.getByLabel("Attach baseline recording", { exact: true });
      await reveal(baselineInput);
      await baselineInput.setInputFiles(manifest.clips[1].file);
      await expect(confirmations.nth(0)).not.toBeChecked();
      await expect(whole).toBeDisabled();
      await expect.poll(() => players.nth(0).getAttribute("src")).not.toBe(originalSources[0]);
      const swappedSource = await players.nth(0).getAttribute("src");
      swappedRecordingCheck = { knownContentHashAvailable: false, wrongFileLoadedWithoutConfirmation: true,
        replayBlockedWithoutExplicitConfirmation: true, hashMismatchRejectionClaimed: false };
      await baselineInput.setInputFiles(manifest.clips[0].file);
      await expect.poll(() => players.nth(0).getAttribute("src")).not.toBe(swappedSource);
      await expect(confirmations.nth(0)).not.toBeChecked();
      await confirmations.nth(0).check();
      await expect(whole).toBeEnabled({ timeout: 20000 });
    }
    const ranges = savedSessions.map(session => Object.fromEntries(session.timestamps.filter(marker => ["startSignal", "hold10", "finishPad"].includes(marker.id)).map(marker => [marker.id, marker.rawTime])));
    await page.evaluate(starts => {
      const probe = { samples: [], events: [], actions: [], firstWaiting: null, active: true, started: performance.now() };
      window.__practicalReplay = probe;
      const started = probe.started;
      const videos = Array.from(document.querySelectorAll(".comparison-players video"));
      for (const [index, video] of videos.entries()) for (const type of ["waiting", "stalled", "pause", "playing", "seeking", "seeked", "error"]) {
        video.addEventListener(type, () => {
          if (!probe.active) return;
          const event = { type, index, elapsedMs: performance.now() - started, currentTime: video.currentTime,
            paused: video.paused, seeking: video.seeking, readyState: video.readyState, hidden: document.hidden,
            buffered: Array.from({ length: video.buffered.length }, (_, range) => [video.buffered.start(range), video.buffered.end(range)]) };
          if (probe.events.length < 200) probe.events.push(event);
          if (type === "waiting" && probe.firstWaiting === null) probe.firstWaiting = event;
        });
      }
      const sample = () => {
        const videos = Array.from(document.querySelectorAll(".comparison-players video"));
        if (probe.active && probe.samples.length < 2000 && videos.length === 2) {
          probe.samples.push(videos.map((video, index) => ({ currentTime: video.currentTime, elapsed: video.currentTime - starts[index], paused: video.paused, seeking: video.seeking, readyState: video.readyState })));
          requestAnimationFrame(sample);
        }
      }; requestAnimationFrame(sample);
    }, ranges.map(range => range.startSignal));
    await whole.click();
    await expect.poll(() => page.evaluate(() => window.__practicalReplay.samples.some(pair => pair.every(video => !video.paused && !video.seeking && video.elapsed > .15))), { timeout: 15000 }).toBe(true);
    await page.evaluate(() => window.__practicalReplay.actions.push({ type: "element-screenshot-start", elapsedMs: performance.now() - window.__practicalReplay.started, width: innerWidth, height: innerHeight }));
    await page.locator("#comparison-replay").screenshot({ path: path.join(outputDirectory, "actual-pair-playing.png") });
    await page.evaluate(() => window.__practicalReplay.actions.push({ type: "element-screenshot-end", elapsedMs: performance.now() - window.__practicalReplay.started, width: innerWidth, height: innerHeight }));
    await expect(page.locator(".comparison-playback-status")).toContainText("Finished", { timeout: 60000 });
    const replay = await page.evaluate(() => { window.__practicalReplay.active = false; return window.__practicalReplay; });
    const nativeEnd = await players.evaluateAll(videos => videos.map(video => ({ currentTime: video.currentTime, paused: video.paused, readyState: video.readyState })));
    nativeEnd.forEach((video, index) => { assert.equal(video.paused, true); assert.ok(Math.abs(video.currentTime - ranges[index].finishPad) < .005); });
    const moving = replay.samples.filter(pair => pair.every(video => !video.paused && !video.seeking && video.elapsed > .15));
    assert.ok(moving.length > 2, "No sustained native pair playback was observed.");
    const elapsedSkews = moving.map(pair => Math.abs(pair[0].elapsed - pair[1].elapsed));
    assert.ok(Math.max(...elapsedSkews) < .3, `Pair clocks diverged by ${Math.max(...elapsedSkews)} seconds.`);
    const phases = [], canReviewPhases = manifest.clips.every(clip => Number.isFinite(clip.review.hold10));
    for (const phase of canReviewPhases ? ["bottom", "top"] : []) {
      await page.getByRole("button", { name: `Replay ${phase} phase`, exact: true }).click();
      await expect(page.locator(".comparison-playback-status")).toContainText("Playing");
      const begin = ranges.map(range => phase === "bottom" ? range.startSignal : range.hold10);
      await expect.poll(() => players.evaluateAll((videos, starts) => videos.every((video, index) => !video.paused && video.currentTime > starts[index] + .08), begin)).toBe(true);
      await page.getByRole("button", { name: "Pause comparison", exact: true }).click();
      const clocks = await players.evaluateAll(videos => videos.map(video => ({ currentTime: video.currentTime, paused: video.paused })));
      assert.ok(clocks.every(video => video.paused)); phases.push({ phase, clocks });
    }
    if (!canReviewPhases) {
      for (const phase of ["bottom", "top"]) await expect(page.getByRole("button", { name: `Replay ${phase} phase`, exact: true })).toBeDisabled();
    }
    let invalidComparisonReplacementRecovered = false;
    if (guided) {
      const oldSources = await players.evaluateAll(videos => videos.map(video => video.src));
      const input = page.getByLabel("Attach baseline recording", { exact: true });
      await reveal(input);
      await input.setInputFiles({ name: "undecodable-comparison.mp4", mimeType: "video/mp4", buffer: Buffer.from("Not a decodable comparison recording") });
      await expect(page.locator("#comparison-replay").getByRole("alert")).toBeVisible();
      assert.deepEqual(await players.evaluateAll(videos => videos.map(video => video.src)), oldSources);
      await expect(whole).toBeEnabled(); await whole.click();
      await expect.poll(() => players.evaluateAll((videos, starts) => videos.every((video, index) => !video.paused && !video.seeking && video.currentTime > starts[index] + .08), ranges.map(range => range.startSignal))).toBe(true);
      await page.getByRole("button", { name: "Pause comparison", exact: true }).click();
      invalidComparisonReplacementRecovered = true;
    }
    return { requiredIdentityConfirmation, comparisonDecisionScope, genuineFileAttachments: true, ranges, swappedRecordingCheck, synchronizedMovingSamples: moving.length,
      maximumElapsedSkewSeconds: Math.max(...elapsedSkews), nativeEnd, phases,
      nativeReplayEvents: replay.events,
      invalidComparisonReplacementRecovered,
      phaseComparisonAvailable: canReviewPhases, phaseLimitation: canReviewPhases ? null : "Hold 10 contact was not independently observable in both clips; no contact cursor was invented.",
      comparison: await page.locator(".comparison-table").innerText() };
  }, { continueOnFailure: true });
  if (!report.stages.at(-1).passed) await stage("separate explicit native Replay recovery after the observed initial playback failure", async () => {
    const before = await page.locator(".comparison-playback-status").textContent();
    const alerts = await page.locator("#comparison-replay [role=alert]").allTextContents();
    assert.ok(alerts.some(message => message.includes("Playback buffered")), "The initial failure was not the known recoverable buffering state.");
    const players = page.locator(".comparison-players video");
    await expect.poll(() => players.evaluateAll(videos => videos.length === 2 && videos.every(video =>
      !video.seeking && video.readyState >= 3 && Array.from({ length: video.buffered.length }, (_, index) =>
        video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= Math.min(video.duration, video.currentTime + .25)).some(Boolean))), { timeout: 15000 }).toBe(true);
    const ready = await players.evaluateAll(videos => videos.map(video => ({ currentTime: video.currentTime, readyState: video.readyState, paused: video.paused })));
    await page.evaluate(() => window.__practicalReplay.actions.push({ type: "explicit-user-replay-recovery", elapsedMs: performance.now() - window.__practicalReplay.started }));
    // One distinct user recovery action. The failed initial completion assertion
    // remains a failed stage and remains part of the overall result.
    await page.getByRole("button", { name: "Replay whole attempt", exact: true }).click();
    await expect(page.locator(".comparison-playback-status")).toContainText("Playing");
    await expect(page.locator(".comparison-playback-status")).toContainText("Finished", { timeout: 30000 });
    const nativeEnd = await players.evaluateAll(videos => videos.map(video => ({ currentTime: video.currentTime, paused: video.paused })));
    nativeEnd.forEach((video, index) => {
      const end = savedSessions[index].timestamps.find(marker => marker.id === "finishPad").rawTime;
      assert.equal(video.paused, true); assert.ok(Math.abs(video.currentTime - end) < .005);
    });
    const nativeEvents = await page.evaluate(() => { window.__practicalReplay.active = false; return window.__practicalReplay.events; });
    return { originalCompletionStillFailed: true, userReplayActions: 1, before, alerts, ready, nativeEnd, nativeEvents };
  }, { continueOnFailure: true });
  await stage("annotation correction retains identity and changes neither saved pair nor original measurements until save", async () => {
    await page.locator(".attempt-library-list > button").filter({ hasText: savedSessions[0].name }).click();
    await page.getByLabel("Choose video", { exact: true }).setInputFiles(manifest.clips[0].file);
    await page.getByRole("button", { name: "Attach to this attempt", exact: true }).click();
    await expect(page.locator(".video-meta-line")).toContainText("Ready");
    const before = await library();
    const original = savedSessions[0].timestamps.find(marker => marker.id === "finishPad").rawTime;
    const correctionFrame = manualEntry ? await reviewMarker(manifest.clips[0], "finishPad", "Finish Pad", original - .1) : null;
    if (!manualEntry) await setMarker("Finish Pad", original - .1);
    assert.deepEqual(await library(), before, "Unsaved correction changed committed measurements.");
    const draft = await dataset("corrected-unsaved-draft");
    assert.equal(draft.session.attemptLineageId, savedSessions[0].attemptLineageId);
    assert.equal(draft.session.sessionId, savedSessions[0].id);
    const corrected = await save(savedSessions[0].name);
    assert.equal(corrected.attemptLineageId, savedSessions[0].attemptLineageId);
    assert.equal((await library()).length, 2, "Correction created a falsely distinct training attempt.");
    if (manualEntry) await expect(page.locator(".recent-attempts button")).toHaveCount(2);
    return { identityRetained: true, unsavedEditsIsolated: true, correctionFrame,
      correctedFinishRawTime: corrected.timestamps.find(marker => marker.id === "finishPad").rawTime, libraryCount: 2 };
  }, { continueOnFailure: true });
  if (backup) await stage("real library backup reimports into an isolated browser context and survives reload", async () => {
    const committed = await library();
    const exportButton = page.getByRole("button", { name: "Export saved library", exact: true, includeHidden: true });
    await reveal(exportButton);
    const pending = page.waitForEvent("download"); await exportButton.click();
    const download = await pending, downloadedFile = await download.path();
    const exported = JSON.parse(await readFile(downloadedFile, "utf8"));
    assert.deepEqual(exported.sessions, committed);
    assert.deepEqual(exported.exportBuild, report.build);
    await writeFile(path.join(outputDirectory, "saved-library-backup.json"), JSON.stringify(exported, null, 2) + "\n", { flag: "wx" });
    const originalPage = page;
    const restoredContext = await browser.newContext(contextOptions);
    try {
      await restoredContext.exposeBinding("__practicalPolicy", (_, description) => report.policyViolations.push(description));
      await restoredContext.addInitScript(() => document.addEventListener("securitypolicyviolation", event => void window.__practicalPolicy(`${event.effectiveDirective}: ${event.blockedURI}`)));
      page = await restoredContext.newPage();
      page.on("pageerror", error => report.pageErrors.push(error.message));
      await page.goto(appUrl);
      await expect(page.locator("[data-session-storage-state]")).toHaveAttribute("data-session-storage-state", "ready");
      const restored = await importBackupAndReload(downloadedFile, committed);
      return { ...restored, realDownloadedBackup: true, isolatedContextReimport: true };
    } finally { page = originalPage; await restoredContext.close(); }
  }, { continueOnFailure: true });
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.policyViolations, []);
  report.passed = report.stages.every(stage => stage.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false; report.error = String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(outputDirectory, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, reportPath, stages: report.stages.map(({ name, passed, elapsedMs, error }) => ({ name, passed, elapsedMs, error })), pageErrors: report.pageErrors, policyViolations: report.policyViolations }, null, 2));
  } finally {
    try { await browser?.close(); } finally { await owner?.close(); }
  }
}
