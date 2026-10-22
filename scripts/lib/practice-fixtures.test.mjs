import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

describe("redistributable practice fixtures", () => {
  it("ships exact hashed originals with ordered authored source-frame references", async () => {
    const root = new URL("../../public/samples/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("reference.json", root), "utf8"));
    expect(manifest.synthetic).toBe(true);
    expect(manifest.license).toBe("CC0-1.0");
    expect(await readFile(new URL("LICENSE.txt", root), "utf8")).toContain("not independently reviewed");
    expect(manifest.attempts).toHaveLength(2);
    for (const attempt of manifest.attempts) {
      expect(createHash("sha256").update(await readFile(new URL(attempt.file, root))).digest("hex")).toBe(attempt.sha256);
      expect(attempt.start).toBeLessThan(attempt.hold10);
      expect(attempt.hold10).toBeLessThan(attempt.finish);
      expect(attempt.finish).toBeLessThan(manifest.duration);
      for (const time of [attempt.start, attempt.hold10, attempt.finish]) expect(time * manifest.fps).toBeCloseTo(Math.round(time * manifest.fps));
    }
    expect(manifest.attempts[0].sha256).not.toBe(manifest.attempts[1].sha256);
  });
});
