import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { evaluatePublicVideoEvidence } from "./lib/public-video-evidence.mjs";
import { validatePublicWorkflowArtifact } from "./lib/public-workflow-artifact.mjs";

try {
  const { values } = parseArgs({ options: { study: { type: "string" }, output: { type: "string" } } });
  if (!values.study) throw new Error("Usage: node scripts/evaluate-public-video-evidence.mjs --study local-audit.json [--output new-report.json]");
  const study = JSON.parse(await readFile(values.study, "utf8"));
  for (const run of study.runs ?? []) {
    if (typeof run.artifactFile !== "string" || !run.artifactFile.trim()) throw new Error("Each run needs its original detector-workflow artifactFile.");
    const bytes = await readFile(path.resolve(path.dirname(path.resolve(values.study)), run.artifactFile));
    if (createHash("sha256").update(bytes).digest("hex") !== run.evidenceFileSha256) throw new Error("Original workflow artifact hash mismatch.");
    validatePublicWorkflowArtifact(run, JSON.parse(bytes.toString("utf8")));
  }
  const evaluated = evaluatePublicVideoEvidence(study);
  evaluated.artifactVerification = { mode: "SHA-256 and original detector-workflow snapshot", runsChecked: study.runs.length,
    automaticTimestamps: "Verified against supplied original artifacts; reviewed or corrected replacements rejected.",
    nonAutomaticStatuses: "Operator classifications of review/missing/failed; the adapter verifies only the absence of an original automatic acceptance.",
    limitation: "Artifact consistency does not attest executable identity, honest blinding, physical event interpretation or recording permission." };
  const report = JSON.stringify(evaluated, null, 2) + "\n";
  if (values.output) await writeFile(values.output, report, { flag: "wx" });
  else process.stdout.write(report);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
