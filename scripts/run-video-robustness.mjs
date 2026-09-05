import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIDEO_VARIATIONS, assessVideoVariation, buildVideoVariationArgs, videoVariationName } from "./lib/video-robustness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.resolve(process.env.CLIMBIQ_VIDEO_DIR ?? path.join(root, "node_modules/.climbiq-private-videos"));
// Generated private media stays in an ignored, dedicated directory.
const outputDirectory = path.join(root, "node_modules/.climbiq-robustness");
const bundledFfmpeg = path.join(root, "node_modules/.climbiq-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const ffmpeg = process.env.CLIMBIQ_FFMPEG ?? (process.platform === "win32" ? bundledFfmpeg : "ffmpeg");
const args = process.argv.slice(2);
const knownFlags = ["--generate-only", "--full"];
for (const argument of args) {
  if (argument.startsWith("--") && !knownFlags.includes(argument) && !argument.startsWith("--variants=") && !argument.startsWith("--fps=")) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}
const selectedIds = args.find(arg => arg.startsWith("--variants="))?.slice(11).split(",");
if (selectedIds?.some(id => !VIDEO_VARIATIONS.some(v => v.id === id))) throw new Error("Unknown --variants selection.");
const variations = VIDEO_VARIATIONS.filter(v => !selectedIds || selectedIds.includes(v.id));
const sourceNames = args.filter(arg => !arg.startsWith("--"));
if (!sourceNames.length) sourceNames.push("IMG_9199.MOV", "IMG_8903.MOV");
for (const name of sourceNames) videoVariationName(name, variations[0]);
const generatedOnly = args.includes("--generate-only");
const fullWorkflow = args.includes("--full");
const fpsArgument = args.find(arg => arg.startsWith("--fps="));
const sampleFps = fpsArgument ? Number(fpsArgument.slice(6)) : undefined;
if (sampleFps !== undefined && ![5, 10, 15].includes(sampleFps)) throw new Error("--fps must be 5, 10, or 15.");
const expectations = JSON.parse(await readFile(path.join(root, "benchmarks/real-video-results.json"), "utf8"));
const references = new Map(expectations.trials.map(trial => [trial.id, trial]));
for (const name of sourceNames) if (!references.has(name)) throw new Error(`No source regression observation exists for ${name}.`);
await mkdir(outputDirectory, { recursive: true });
await mkdir(path.join(root, "test-results"), { recursive: true });
const reportPath = path.join(root, "test-results", `video-robustness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(),
  interpretation: "Derived variations of existing climbs, not independent new labels. Tolerance is a regression policy, not a measured accuracy bound.",
  fullWorkflow, generatedOnly, sampleFps, appUrl: process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/", runs: [],
  referenceSnapshot: sourceNames.map(name => references.get(name)),
};

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, commandArgs, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function exists(filename) {
  try { await access(filename); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function prepare(sourceName, sourceSha256, variation) {
  const name = videoVariationName(sourceName, variation);
  const destination = path.join(outputDirectory, name);
  const metadataPath = `${destination}.json`;
  if (await exists(destination)) {
    if (!(await exists(metadataPath))) throw new Error(`${name} has no provenance sidecar; move it out before regenerating.`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.sourceSha256 !== sourceSha256 || JSON.stringify(metadata.variation) !== JSON.stringify(variation) || metadata.sha256 !== await hashFile(destination)) {
      throw new Error(`${name} does not match its source, transform, or checksum; move it out before regenerating.`);
    }
    return metadata;
  }
  const execution = await run(ffmpeg, buildVideoVariationArgs(path.join(sourceDirectory, sourceName), destination, variation));
  if (execution.code !== 0) throw new Error(`Video generation failed for ${name}: ${execution.stderr}`);
  const metadata = { schemaVersion: 1, fileName: name, sourceName, sourceSha256, variation,
    sha256: await hashFile(destination), bytes: (await stat(destination)).size, generatedAt: new Date().toISOString() };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  return metadata;
}

console.log(`Robustness report: ${reportPath}`);
for (const sourceName of sourceNames) {
  const sourceSha256 = await hashFile(path.join(sourceDirectory, sourceName));
  for (const variation of variations) {
    const started = Date.now();
    const entry = { sourceName, variationId: variation.id };
    try {
      console.log(`Preparing ${sourceName} / ${variation.id}`);
      entry.media = await prepare(sourceName, sourceSha256, variation);
      if (!generatedOnly) {
        console.log(`Testing ${entry.media.fileName}`);
        const execution = await run(process.execPath, ["e2e/real-video-timing.mjs", ...(fullWorkflow ? ["--full"] : []), ...(fpsArgument ? [fpsArgument] : []), entry.media.fileName],
          { ...process.env, CLIMBIQ_VIDEO_DIR: outputDirectory });
        let benchmark;
        try { benchmark = JSON.parse(execution.stdout); }
        catch { throw new Error(`Workflow runner exited ${execution.code}: ${execution.stderr || execution.stdout}`); }
        entry.app = benchmark.app;
        entry.outcome = benchmark.outcomes[0];
        if (!entry.outcome) throw new Error("Workflow runner returned no outcome.");
        entry.assessment = assessVideoVariation(references.get(sourceName), variation, entry.outcome);
        if (execution.code !== 0) entry.error = entry.outcome.workflow?.error ??
          benchmark.assertions?.flatMap(assertion => assertion.errors).join("; ") ?? `Workflow runner exited ${execution.code}.`;
        console.log(`${variation.id}: Start ${entry.assessment.boundaries.start.status}; Finish ${entry.assessment.boundaries.finish.status}`);
      }
    } catch (error) {
      entry.error = error.message;
      console.error(`${sourceName} / ${variation.id}: ${entry.error}`);
    }
    entry.elapsedMs = Date.now() - started;
    report.runs.push(entry);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}
report.finishedAt = new Date().toISOString();
report.summary = {
  totalVariations: report.runs.length,
  independentSourceClimbs: new Set(sourceNames).size,
  workflowErrors: report.runs.filter(r => r.error).length,
  timingRegressions: report.runs.filter(r => r.assessment?.safetyRegression).length,
  sourceTimingRegressions: report.runs.filter(r => r.assessment?.sourceTimingRegression).length,
  needsInvestigation: report.runs.filter(r => r.assessment?.needsInvestigation).length,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
if (report.summary.workflowErrors || report.summary.timingRegressions || report.summary.sourceTimingRegressions) process.exitCode = 1;
