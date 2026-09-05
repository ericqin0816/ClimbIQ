import { readFile } from "node:fs/promises";
import { compareVideoRuns } from "./lib/compare-video-runs.mjs";

const [beforePath, afterPath, ...extra] = process.argv.slice(2);
if (!beforePath || !afterPath || extra.length) throw new Error("Usage: node scripts/compare-video-runs.mjs BEFORE.json AFTER.json");
const [before, after] = await Promise.all([beforePath, afterPath].map(async file => JSON.parse(await readFile(file, "utf8"))));
const result = compareVideoRuns(before, after);
console.log(JSON.stringify(result, null, 2));
// Availability changes still require inspection; they are not mislabeled as errors.
if (result.summary.unpairedCases || result.summary.timingDrifts) process.exitCode = 1;
else if (result.summary.newUnverifiedAcceptances) process.exitCode = 2;
