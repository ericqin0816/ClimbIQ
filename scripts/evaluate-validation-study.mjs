import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { evaluateValidationStudy, parseLabelWorksheet } from "./lib/validation-study.mjs";

try {
  const { values } = parseArgs({ options: { study: { type: "string" }, labels: { type: "string" }, output: { type: "string" } } });
  if (!values.study || !values.labels) throw new Error("Usage: npm run study:evaluate -- --study private-study.json --labels private-labels.csv [--output private-report.json]");
  const study = JSON.parse(await readFile(values.study, "utf8"));
  const labels = parseLabelWorksheet(await readFile(values.labels, "utf8"));
  const report = JSON.stringify(evaluateValidationStudy(study, labels), null, 2) + "\n";
  if (values.output) { await writeFile(values.output, report); console.log(`Report saved to ${values.output}.`); }
  else process.stdout.write(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
