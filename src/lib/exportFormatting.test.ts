import { describe, expect, it } from "vitest";
import { yamlNumber, yamlString } from "./exportFormatting";

describe("export formatting", () => {
  it("escapes quotes, slashes, newlines, and tabs in YAML strings", () => {
    expect(yamlString("Gym \"A\"\\lane\nnext\tvalue")).toBe('"Gym \\"A\\"\\\\lane\\nnext\\tvalue"');
  });

  it("writes only finite YAML numbers", () => {
    expect(yamlNumber(4.385)).toBe("4.385");
    expect(yamlNumber(Number.NaN)).toBe("");
    expect(yamlNumber(Number.POSITIVE_INFINITY)).toBe("");
    expect(yamlNumber(null)).toBe("");
  });
});
