import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const evaluator = fileURLToPath(new URL("evaluate-validation-study.mjs", import.meta.url));
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "climbiq-study-cli-")); directories.push(root);
  const studyFile = path.join(root, "study.json"), labelsFile = path.join(root, "labels.csv");
  const study = JSON.stringify({ version: 1, studyId: "empty-prepared-fixture", protocol: {
    appCommit: "123abcd", frozenAt: "2026-10-01T00:00:00Z", splitUnit: "climberAlias", endpointToleranceSeconds: .1,
  }, clips: [], predictions: [], observations: [] });
  const labels = "labelId,clipId\n";
  await writeFile(studyFile, study); await writeFile(labelsFile, labels);
  const run = output => spawnSync(process.execPath, [evaluator, "--study", studyFile, "--labels", labelsFile,
    ...(output ? ["--output", output] : [])], { cwd: root, encoding: "utf8", timeout: 15000 });
  return { root, studyFile, labelsFile, study, labels, run };
}

describe("private study CLI output", () => {
  it("creates a fresh report and leaves the frozen inputs unchanged", async () => {
    const f = await fixture(), output = path.join(f.root, "report-001.json");
    const result = f.run(output);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Report saved");
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.status).toBe("awaiting-data");
    expect(report.endpoints.start.automaticCoverage.fraction).toBeNull();
    expect(await readFile(f.studyFile, "utf8")).toBe(f.study);
    expect(await readFile(f.labelsFile, "utf8")).toBe(f.labels);
  });

  it("rejects input paths, hard-link aliases, and existing reports without changing their bytes", async () => {
    const f = await fixture(), prior = path.join(f.root, "prior-report.json"), alias = path.join(f.root, "manifest-alias.json");
    const originalReport = '{"previousReport":"retain exactly"}\n';
    await writeFile(prior, originalReport); await link(f.studyFile, alias);
    for (const target of [f.studyFile, f.labelsFile, alias, prior]) {
      const result = f.run(target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Choose a new report filename");
      expect(result.stdout).not.toContain("Report saved");
      expect(await readFile(f.studyFile, "utf8")).toBe(f.study);
      expect(await readFile(f.labelsFile, "utf8")).toBe(f.labels);
      expect(await readFile(alias, "utf8")).toBe(f.study);
      expect(await readFile(prior, "utf8")).toBe(originalReport);
    }
  });

  it("does not create a report from malformed labels and can still print to stdout", async () => {
    const f = await fixture(), output = path.join(f.root, "invalid-report.json");
    const stdout = f.run();
    expect(stdout.status, stdout.stderr).toBe(0);
    expect(JSON.parse(stdout.stdout).status).toBe("awaiting-data");
    await writeFile(f.labelsFile, "labelId,labelReview.rawTime\na,NaN\n");
    const result = f.run(output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid labelReview.rawTime");
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.studyFile, "utf8")).toBe(f.study);
  });
});
