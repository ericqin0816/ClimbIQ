import { describe, expect, it } from "vitest";
import { deriveAutomaticStartBodyZone, resolveAnalysisBodyZone } from "./startRegion";

describe("automatic lane-local start body region", () => {
  it("covers the reference climber while excluding most of the central passerby", () => {
    const zone = deriveAutomaticStartBodyZone({
      id: "startLight",
      label: "Reference faint light",
      x1: 0.68,
      y1: 0.73,
      x2: 0.71,
      y2: 0.76,
    });

    expect(zone.x1).toBeGreaterThanOrEqual(0.49);
    expect(zone.x2).toBeGreaterThan(0.8);
    expect(zone.y1).toBeGreaterThanOrEqual(0.4);
    expect(zone.y2).toBeLessThan(0.74 + 0.03);
  });

  it("mirrors the region for a left-lane light", () => {
    const zone = deriveAutomaticStartBodyZone({
      id: "startLight",
      label: "Left light",
      x1: 0.2,
      y1: 0.75,
      x2: 0.23,
      y2: 0.79,
    });
    expect(zone.x1).toBeLessThan(0.1);
    expect(zone.x2).toBeLessThanOrEqual(0.5);
  });

  it("does not create a tracking region when no light cue supported the fused start", () => {
    expect(resolveAnalysisBodyZone(undefined, undefined)).toBeUndefined();
  });

  it("uses the supported lane while preserving a user-selected body zone", () => {
    const supportedLight = {
      id: "startLight" as const,
      label: "Supported right-lane light",
      x1: 0.68,
      y1: 0.73,
      x2: 0.71,
      y2: 0.76,
    };
    expect(resolveAnalysisBodyZone(undefined, supportedLight)?.x1).toBeGreaterThanOrEqual(0.5);

    const trustedBody = {
      id: "startBody" as const,
      label: "User-selected body region",
      x1: 0.1,
      y1: 0.5,
      x2: 0.4,
      y2: 0.9,
    };
    expect(resolveAnalysisBodyZone(trustedBody, supportedLight)).toBe(trustedBody);
  });
});
