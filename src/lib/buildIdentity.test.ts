import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { formatBuildIdentity, resolveAppBuild, sanitizeAppBuildIdentity } from "./buildIdentity";

describe("portable build provenance", () => {
  it("keeps a validated original identity without copying unrelated data", () => {
    const value = { schemaVersion: 1, appVersion: "0.29.0", commitSha: "A".repeat(40), workingTreeDirty: false, privatePath: "never retain" };
    const sanitized = sanitizeAppBuildIdentity(value);
    expect(sanitized).toEqual({ schemaVersion: 1, appVersion: "0.29.0", commitSha: "a".repeat(40), workingTreeDirty: false });
    expect(value.commitSha).toBe("A".repeat(40));
    expect(formatBuildIdentity(sanitized)).toBe("0.29.0 · aaaaaaa");
  });

  it("preserves unknown identity rather than attributing imports to the current build", () => {
    expect(sanitizeAppBuildIdentity(undefined)).toBeUndefined();
    expect(resolveAppBuild(undefined)).toEqual({ schemaVersion: 1, appVersion: pkg.version, commitSha: null, workingTreeDirty: null });
    expect(formatBuildIdentity(resolveAppBuild(undefined))).toContain("source identity unknown");
  });

  it("distinguishes modified source and rejects malformed or falsely clean provenance", () => {
    const known = { schemaVersion: 1, appVersion: "0.30.0", commitSha: "a".repeat(40), workingTreeDirty: true };
    expect(formatBuildIdentity(sanitizeAppBuildIdentity(known))).toContain("modified source");
    for (const value of [{ ...known, commitSha: "short" }, { ...known, commitSha: null }, { ...known, workingTreeDirty: null },
      { ...known, appVersion: "secret\nvalue" }, { ...known, schemaVersion: 2 }]) expect(sanitizeAppBuildIdentity(value)).toBeUndefined();
  });
});
