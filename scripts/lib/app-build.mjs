import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Only a package version, Git object ID, and dirty flag enter the browser. */
export function readAppBuild(root, git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 1024 * 1024,
})) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(pkg.version)) {
    throw new Error("A valid package version is required for build provenance.");
  }
  const unknown = { schemaVersion: 1, appVersion: pkg.version, commitSha: null, workingTreeDirty: null };
  try {
    const commitSha = git(["rev-parse", "--verify", "HEAD"]).trim();
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) return unknown;
    const status = git(["status", "--porcelain", "--untracked-files=normal"]);
    return { ...unknown, commitSha: commitSha.toLowerCase(), workingTreeDirty: status.trim().length > 0 };
  } catch {
    // Archives, missing Git, and failed status checks must never look like clean commits.
    return unknown;
  }
}
