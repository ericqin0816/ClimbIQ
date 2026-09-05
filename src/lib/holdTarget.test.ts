import { describe, expect, it } from "vitest";
import type { NormalizedZone } from "../types";
import type { RouteAlignmentResult } from "./routeAlignment";
import { resolveHold10Target } from "./holdTarget";
import { getStandardSpeedHold, projectStandardSpeedHoldToImage } from "./standardSpeedRoute";
import { buildWallCalibration } from "./wallCalibration";

const fullFrameCalibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);

describe("Hold 10 target resolution", () => {
  it("projects only directly observed route neighbors into the current wall plane", () => {
    const alignment = alignedRoute({ x: 0.4, y: 0.5 }, { xMeters: 1.2, yMeters: 7.5 });
    alignment.holds = [
      { holdId: 9, originalImage: { x: 0.35, y: 0.55 }, image: { x: 0.35, y: 0.55 }, observedImage: { x: 0.35, y: 0.55 } },
      { holdId: 10, originalImage: { x: 0.4, y: 0.5 }, image: { x: 0.4, y: 0.5 }, observedImage: { x: 0.4, y: 0.5 } },
      { holdId: 11, originalImage: { x: 0.48, y: 0.44 }, image: { x: 0.48, y: 0.44 }, observedImage: { x: 0.48, y: 0.44 } },
      { holdId: 12, originalImage: { x: 0.42, y: 0.4 }, image: { x: 0.42, y: 0.4 } },
    ];
    const target = resolveHold10Target({ calibration: fullFrameCalibration, visualAlignment: alignment });
    expect(target.observedRouteHolds?.map(hold => hold.id)).toEqual([9, 10, 11]);
    expect(target.observedRouteHolds?.[1].wall.xMeters).toBeCloseTo(1.2, 8);
    expect(target.observedRouteHolds?.[1].wall.yMeters).toBeCloseTo(7.5, 8);
  });

  it("sanitizes a valid reversed manual zone and returns its projected center", () => {
    const result = resolveHold10Target({
      manualZone: zone({ x1: 0.5, y1: 0.6, x2: 0.3, y2: 0.4 }),
      calibration: fullFrameCalibration,
    });

    expect(result.source).toBe("manual-zone");
    if (result.source !== "manual-zone") throw new Error("Expected a manual Hold 10 target.");
    expect(result.manualZone).toMatchObject({ x1: 0.3, y1: 0.4, x2: 0.5, y2: 0.6 });
    expect(result.imagePoint).toEqual({ x: 0.4, y: 0.5 });
    expect(result.wallTarget.xMeters).toBeCloseTo(1.2, 8);
    expect(result.wallTarget.yMeters).toBeCloseTo(7.5, 8);
    expect(result.reason).toContain("validated manual");
  });

  it("falls back explicitly when a valid manual zone has no wall calibration", () => {
    const result = resolveHold10Target({ manualZone: zone({}) });

    expect(result).toMatchObject({
      source: "standard-template",
      fallbackReason: "invalid-calibration",
      wallTarget: getStandardSpeedHold(10).wall,
      imagePoint: undefined,
    });
    expect(result.reason).toContain("wall calibration is invalid");
  });

  it.each([
    ["a malformed value", "not a zone"],
    ["a missing coordinate", { x1: 0.4, y1: 0.4, x2: 0.6 }],
    ["a NaN coordinate", zone({ x1: Number.NaN })],
    ["an infinite coordinate", zone({ y2: Number.POSITIVE_INFINITY })],
  ])("falls back for %s", (_label, manualZone) => {
    const result = resolveHold10Target({ manualZone, calibration: fullFrameCalibration });

    expect(result.source).toBe("standard-template");
    if (result.source !== "standard-template") throw new Error("Expected the template fallback.");
    expect(result.fallbackReason).toBe("invalid-zone");
    expect(result.wallTarget).toEqual(getStandardSpeedHold(10).wall);
    expect(result.imagePoint).toEqual(projectStandardSpeedHoldToImage(10, fullFrameCalibration));
    expect(result.reason).toContain("invalid or out-of-frame");
  });

  it("rejects a manual zone whose coordinates leave the normalized video frame", () => {
    const result = resolveHold10Target({
      manualZone: zone({ x1: 1.1, x2: 1.3 }),
      calibration: fullFrameCalibration,
    });

    expect(result).toMatchObject({
      source: "standard-template",
      fallbackReason: "invalid-zone",
    });
  });

  it("rejects an in-frame manual center that projects outside the calibrated wall", () => {
    const centralLaneCalibration = buildWallCalibration([
      { x: 0.25, y: 0.9 },
      { x: 0.75, y: 0.9 },
      { x: 0.7, y: 0.1 },
      { x: 0.3, y: 0.1 },
    ], 0, true);
    const result = resolveHold10Target({
      manualZone: zone({ x1: 0.93, x2: 0.97, y1: 0.48, y2: 0.52 }),
      calibration: centralLaneCalibration,
    });

    expect(result.source).toBe("standard-template");
    if (result.source !== "standard-template") throw new Error("Expected the template fallback.");
    expect(result.fallbackReason).toBe("outside-wall");
    expect(result.reason).toContain("outside the calibrated wall");
    expect(result.imagePoint).toEqual(projectStandardSpeedHoldToImage(10, centralLaneCalibration));
  });

  it("uses a stable template fallback when no manual zone was supplied", () => {
    const result = resolveHold10Target({ calibration: fullFrameCalibration });

    expect(result).toMatchObject({
      source: "standard-template",
      fallbackReason: "not-provided",
      wallTarget: getStandardSpeedHold(10).wall,
    });
    expect(result.reason).toContain("No manual Hold 10 Zone");
  });

  it("uses a visually registered Hold 10 instead of the compressed template", () => {
    const visualAlignment = alignedRoute({ x: 0.62, y: 0.44 }, { xMeters: 1.86, yMeters: 8.4 });
    const result = resolveHold10Target({
      calibration: fullFrameCalibration,
      visualAlignment,
    });

    expect(result).toMatchObject({
      source: "visual-alignment",
      imagePoint: { x: 0.62, y: 0.44 },
      wallTarget: { xMeters: 1.86, yMeters: 8.4 },
    });
  });

  it("keeps a valid manual Hold 10 zone authoritative over visual registration", () => {
    const result = resolveHold10Target({
      manualZone: zone({}),
      calibration: fullFrameCalibration,
      visualAlignment: alignedRoute({ x: 0.7, y: 0.3 }, { xMeters: 2.1, yMeters: 10.5 }),
    });

    expect(result.source).toBe("manual-zone");
  });
});

function alignedRoute(
  hold10Image: { x: number; y: number },
  hold10WallTarget: { xMeters: number; yMeters: number },
): RouteAlignmentResult {
  return {
    aligned: true,
    confidence: "High",
    reason: "20/20 holds aligned.",
    holds: [],
    hold10Image,
    hold10WallTarget,
    diagnostics: {
      framesUsed: 5,
      sourceWidth: 480,
      sourceHeight: 854,
      gridWidth: 202,
      gridHeight: 360,
      persistentCells: 100,
      segmentedComponents: 20,
      retainedCandidates: 20,
      hypothesesEvaluated: 20,
      matchedHoldIds: [10],
      ambiguous: false,
      candidates: [],
      matches: [],
    },
  };
}

function zone(overrides: Partial<NormalizedZone>): NormalizedZone {
  return {
    id: "hold10",
    label: "Hold 10 Zone",
    x1: 0.35,
    y1: 0.45,
    x2: 0.45,
    y2: 0.55,
    ...overrides,
  };
}
