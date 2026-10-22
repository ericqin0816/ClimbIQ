import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAppBuild } from "./app-build.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "climbiq-build-contract-")); directories.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  return root;
}

describe("build source identity", () => {
  it("identifies the actual clean commit, then reports tracked and untracked source changes", async () => {
    const root = await fixture();
    const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init"]); git(["add", "package.json"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Build identity fixture"]);
    const commitSha = git(["rev-parse", "HEAD"]);
    expect(readAppBuild(root)).toEqual({ schemaVersion: 1, appVersion: "1.2.3", commitSha, workingTreeDirty: false });
    await writeFile(path.join(root, "notes.txt"), "private source path contents never enter provenance");
    const modified = readAppBuild(root);
    expect(modified).toEqual({ schemaVersion: 1, appVersion: "1.2.3", commitSha, workingTreeDirty: true });
    expect(JSON.stringify(modified)).not.toContain(root);
    await rm(path.join(root, "notes.txt"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.4" }));
    expect(readAppBuild(root)).toMatchObject({ appVersion: "1.2.4", commitSha, workingTreeDirty: true });
  });

  it("reports unknown source when Git or status cannot establish it", async () => {
    const root = await fixture();
    const unknown = { schemaVersion: 1, appVersion: "1.2.3", commitSha: null, workingTreeDirty: null };
    expect(readAppBuild(root, () => { throw new Error("Git unavailable"); })).toEqual(unknown);
    expect(readAppBuild(root, args => { if (args[0] === "status") throw new Error("status failed"); return "a".repeat(40); })).toEqual(unknown);
    expect(readAppBuild(root, () => "invalid commit")).toEqual(unknown);
  });
});
