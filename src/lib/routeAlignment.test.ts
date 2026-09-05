import { describe, expect, it } from "vitest";
import type { NormalizedPoint, RGB } from "../types";
import { buildWallCalibration } from "./wallCalibration";
import { projectStandardSpeedRouteToImage, projectWallPointToImage } from "./standardSpeedRoute";
import { SPEED_ROUTE_BOLTS } from "./speedRouteBoltGrid";
import {
  alignStandardSpeedRouteWithFallback,
  alignStandardSpeedRouteVisually,
  type RouteAlignmentResult,
} from "./routeAlignment";

const calibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);
const projected = projectStandardSpeedRouteToImage(calibration).map((entry) => entry.image);
const pink: RGB = { r: 224, g: 74, b: 122 };
const red: RGB = { r: 205, g: 45, b: 55 };
const background: RGB = { r: 102, g: 105, b: 108 };

describe("persistent visual route alignment", () => {
  it("keeps neighboring identities when the closer greedy pairing would strand Hold 8", () => {
    const from = projected[7], to = projected[8];
    const delta = { x: to.x - from.x, y: to.y - from.y };
    const eight = { x: from.x + delta.x * 0.52, y: from.y + delta.y * 0.52 };
    const nine = { x: to.x + delta.x * 0.60, y: to.y + delta.y * 0.60 };
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, IDENTITY, new Set([8, 9]), pink, 4);
      drawDisc(image, eight, 4, pink);
      drawDisc(image, nine, 4, pink);
      return image;
    });
    const result = alignStandardSpeedRouteVisually(frames, calibration, { matchRadiusNormalized: 0.04 });
    expect(result.aligned, result.reason).toBe(true);
    expect(result.holds[7].observedImage).toBeDefined();
    expect(pointDistance(result.holds[7].observedImage!, eight)).toBeLessThan(0.006);
    expect(pointDistance(result.holds[8].observedImage!, nine)).toBeLessThan(0.006);
  });
  const gridAnchor = { id: "startBody" as const, label: "Selected athlete", x1: 0.68, x2: 0.86, y1: 0.8, y2: 0.98 };
  function gridFrames(missing = new Set<number>()) {
    return Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      for (const bolt of SPEED_ROUTE_BOLTS) {
        if (!missing.has(bolt.id)) drawDisc(image, projectWallPointToImage(bolt.wall, calibration), 4, pink);
      }
      return image;
    });
  }

  it("recovers a published-grid route with strong direct support and an athlete anchor", () => {
    const result = alignStandardSpeedRouteWithFallback(gridFrames(), calibration, { startBodyZone: gridAnchor }).result;
    expect(result.aligned).toBe(true);
    expect(result.referenceGeometry).toBe("ifsc-2022-bolt-grid");
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(19);
    expect(pointDistance(result.hold10Image!, projectWallPointToImage(SPEED_ROUTE_BOLTS[9].wall, calibration))).toBeLessThan(0.004);
    expect(result.reason).toContain("Hold centers come from the video");
  });

  it("does not run the wider published-grid recovery without athlete identity", () => {
    const result = alignStandardSpeedRouteWithFallback(gridFrames(), calibration).result;
    expect(result.referenceGeometry).not.toBe("ifsc-2022-bolt-grid");
  });

  it("does not lower recovery support to accept a sparse grid", () => {
    const result = alignStandardSpeedRouteWithFallback(gridFrames(new Set([1, 2, 3, 4, 5, 6])), calibration, { startBodyZone: gridAnchor }).result;
    expect(result.referenceGeometry).not.toBe("ifsc-2022-bolt-grid");
  });

  it("requires direct Hold 10 and neighboring evidence for published-grid recovery", () => {
    for (const missing of [9, 10, 11]) {
      const result = alignStandardSpeedRouteWithFallback(gridFrames(new Set([missing])), calibration, { startBodyZone: gridAnchor }).result;
      expect(result.referenceGeometry, `missing Hold ${missing}`).not.toBe("ifsc-2022-bolt-grid");
    }
  });

  it("jointly aligns the full route despite missing holds, moving red distractors, and climber occlusion", () => {
    const transform: Matrix = [1.02, 0.012, -0.018, -0.008, 0.975, 0.016, 0, 0, 1];
    const missing = new Set([3, 7, 12, 18]);
    const frames = Array.from({ length: 3 }, (_, frameIndex) => {
      const image = makeFrame(320, 640);
      drawRoute(image, transform, missing, frameIndex % 2 ? red : pink);
      // Moving red objects are absent from the same cells in the other frames.
      drawDisc(image, { x: 0.16 + frameIndex * 0.11, y: 0.3 + frameIndex * 0.13 }, 5, red);
      drawDisc(image, { x: 0.78 - frameIndex * 0.09, y: 0.72 - frameIndex * 0.08 }, 4, pink);
      if (frameIndex === 0) {
        // A climber-shaped occlusion hides several real holds in one frame.
        fillRect(image, 0.39, 0.34, 0.24, 0.28, { r: 45, g: 48, b: 51 });
      }
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned, result.reason).toBe(true);
    expect(result.confidence).toBe("High");
    expect(result.holds).toHaveLength(20);
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(14);
    expect(result.diagnostics.medianResidualNormalized).toBeLessThan(0.009);
    expect(result.hold10Image).toBeDefined();
    expect(pointDistance(result.hold10Image!, apply(transform, projected[9]))).toBeLessThan(0.009);
    expect(result.hold10WallTarget).toBeDefined();
    expect(result.diagnostics.retainedCandidates).toBeLessThanOrEqual(20);
  });

  it("upgrades to a bounded projective correction when perspective residual improves materially", () => {
    const transform: Matrix = [1.015, 0.006, -0.012, 0.004, 1.005, 0.006, 0.075, 0.055, 1];
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, transform, new Set([6, 17]), pink, 4);
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(true);
    expect(result.model).toBe("projective");
    expect(result.correctionMatrix).toHaveLength(9);
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(16);
    expect(maximumRouteError(result, transform)).toBeLessThan(0.012);
  });

  it("caps single-frame evidence below High confidence", () => {
    const image = makeFrame(300, 600);
    drawRoute(image, IDENTITY, new Set(), red);

    const result = alignStandardSpeedRouteVisually([image], calibration);

    expect(result.aligned).toBe(true);
    expect(result.confidence).toBe("Medium");
    expect(result.diagnostics.matchedHoldIds).toHaveLength(20);
  });

  it("refuses low-support red components instead of snapping Hold 10 independently", () => {
    const image = makeFrame(300, 600);
    drawRoute(image, [1, 0, 0.025, 0, 1, -0.012, 0, 0, 1],
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), pink);
    // Add unrelated persistent red blobs, deliberately outside route geometry.
    drawDisc(image, { x: 0.12, y: 0.2 }, 4, red);
    drawDisc(image, { x: 0.84, y: 0.5 }, 4, red);

    const result = alignStandardSpeedRouteVisually([image, cloneFrame(image)], calibration);

    expect(result.aligned).toBe(false);
    expect(result.confidence).toBe("None");
    expect(result.hold10Image).toBeUndefined();
    expect(result.reason).toMatch(/at least 10|consistent 20-hold route/);
  });

  it("retains the best-hypothesis diagnostics when consensus is just below policy", () => {
    const image = makeFrame(360, 720);
    drawRoute(image, IDENTITY, new Set([12, 13, 14, 15, 16, 17, 18, 19, 20]), pink, 4);
    drawDisc(image, { x: projected[5].x + 0.055, y: projected[5].y }, 4, red);

    const result = alignStandardSpeedRouteVisually([image, cloneFrame(image)], calibration, {
      minimumMatchedHolds: 12,
    });

    expect(result.aligned).toBe(false);
    expect(result.diagnostics.matchedHoldIds).toHaveLength(11);
    expect(result.diagnostics.matches).toHaveLength(11);
    expect(result.diagnostics.medianResidualNormalized).toBeDefined();
  });

  it("refuses two equally supported route copies as ambiguous", () => {
    const left: Matrix = [1, 0, -0.027, 0, 1, 0.004, 0, 0, 1];
    const right: Matrix = [1, 0, 0.027, 0, 1, 0.004, 0, 0, 1];
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, left, new Set(), pink, 3);
      drawRoute(image, right, new Set(), red, 3);
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(false);
    expect(result.diagnostics.ambiguous).toBe(true);
    expect(result.reason).toContain("Two different route placements");
  });

  it("uses the selected athlete start zone to choose between two valid macro routes", () => {
    const left: Matrix = [1, 0, -0.035, 0, 1, 0.004, 0, 0, 1];
    const right: Matrix = [1, 0, 0.035, 0, 1, 0.004, 0, 0, 1];
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, left, new Set(), pink, 3);
      drawRoute(image, right, new Set(), red, 3);
      return image;
    });
    const rightStart = {
      x: (apply(right, projected[0]).x + apply(right, projected[1]).x) / 2,
      y: (apply(right, projected[0]).y + apply(right, projected[1]).y) / 2,
    };

    const result = alignStandardSpeedRouteVisually(frames, calibration, {
      startBodyZone: {
        id: "startBody",
        label: "selected athlete",
        x1: rightStart.x - 0.04,
        x2: rightStart.x + 0.04,
        y1: rightStart.y - 0.07,
        y2: rightStart.y + 0.07,
      },
    });

    expect(result.aligned, result.reason).toBe(true);
    expect(result.diagnostics.ambiguous).toBe(false);
    expect(result.diagnostics.startAnchorDistanceNormalized).toBeLessThan(0.015);
    expect(pointDistance(result.holds[9].observedImage!, apply(right, projected[9]))).toBeLessThan(0.01);
  });

  it("ignores yellow rope and large red regions while retaining faint pink holds", () => {
    const frames = Array.from({ length: 2 }, () => {
      const image = makeFrame(320, 640);
      drawRoute(image, IDENTITY, new Set([4, 15]), { r: 148, g: 88, b: 105 }, 4);
      fillRect(image, 0.2, 0.1, 0.015, 0.78, { r: 210, g: 185, b: 35 });
      fillRect(image, 0.72, 0.35, 0.18, 0.2, red);
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(true);
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(16);
    expect(result.diagnostics.segmentedComponents).toBeGreaterThanOrEqual(18);
  });

  it("prefers real speed-hold silhouettes over a dense persistent field of tiny red bolt dots", () => {
    const realTransform: Matrix = [1.01, 0.006, 0.018, -0.004, 0.99, 0.012, 0, 0, 1];
    const wrongDotRoute: Matrix = [1, 0, -0.046, 0, 1, 0.006, 0, 0, 1];
    const realHoldColor = { r: 154, g: 87, b: 111 };
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, realTransform, new Set([5, 16]), realHoldColor, 4);
      // A geometrically perfect but physically impossible route made only of
      // tiny hardware is the failure mode seen in the real wall screenshot.
      drawRoute(image, wrongDotRoute, new Set(), { r: 176, g: 45, b: 50 }, 1);
      for (let y = 0.08; y <= 0.92; y += 0.052) {
        for (let x = 0.17; x <= 0.78; x += 0.057) {
          drawDisc(image, { x, y }, 1, { r: 172, g: 47, b: 52 });
        }
      }
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(true);
    expect(result.holds[9].observedImage).toBeDefined();
    expect(pointDistance(result.holds[9].observedImage!, apply(realTransform, projected[9]))).toBeLessThan(0.012);
    expect(pointDistance(result.holds[9].observedImage!, apply(wrongDotRoute, projected[9]))).toBeGreaterThan(0.04);
    expect(result.diagnostics.matches.find((match) => match.holdId === 10)).toBeDefined();
    const hold10CandidateId = result.diagnostics.matches.find((match) => match.holdId === 10)!.candidateId;
    expect(result.diagnostics.candidates.find((candidate) => candidate.id === hold10CandidateId)!.silhouetteScore)
      .toBeGreaterThan(0.6);
  });

  it("refuses a geometrically perfect route made entirely from tiny red hardware", () => {
    const dotRoute: Matrix = [1, 0, -0.025, 0, 1, 0.008, 0, 0, 1];
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, dotRoute, new Set(), { r: 182, g: 43, b: 48 }, 1);
      for (let y = 0.1; y < 0.9; y += 0.06) {
        for (let x = 0.2; x < 0.75; x += 0.065) {
          drawDisc(image, { x, y }, 1, { r: 175, g: 48, b: 50 });
        }
      }
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(false);
    expect(result.hold10Image).toBeUndefined();
    expect(result.reason).toMatch(/at least 10|consistent 20-hold route/);
  });

  it("refuses to invent Hold 10 when the rest of the macro route is visible", () => {
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, IDENTITY, new Set([10]), pink, 4);
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(false);
    expect(result.reason).toContain("Hold 10 did not have a direct macro-hold match");
    expect(result.hold10Image).toBeUndefined();
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(15);
    expect(result.holds.length).toBe(result.diagnostics.matchedHoldIds.length);
    expect(result.holds.every((hold) => hold.observedImage)).toBe(true);
  });

  it("recovers one unique unused macro Hold 10 only between matched route neighbors", () => {
    const recoveredPoint = { x: projected[9].x + 0.043, y: projected[9].y };
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, IDENTITY, new Set([10]), pink, 4);
      drawDisc(image, recoveredPoint, 4, pink);
      return image;
    });
    const startX = (projected[0].x + projected[1].x) / 2;

    const result = alignStandardSpeedRouteVisually(frames, calibration, {
      startBodyZone: {
        id: "startBody",
        label: "selected athlete",
        x1: startX - 0.04,
        x2: startX + 0.04,
        y1: 0.72,
        y2: 0.92,
      },
    });

    expect(result.aligned).toBe(true);
    expect(result.diagnostics.hold10Recovered).toBe(true);
    expect(result.holds[9].observedImage).toBeDefined();
    expect(pointDistance(result.holds[9].observedImage!, recoveredPoint)).toBeLessThan(0.006);
    expect(result.diagnostics.matches.find((match) => match.holdId === 10)?.association)
      .toBe("topology-recovery");
  });

  it("keeps Hold 10 centered when a pale star silhouette has one dark saturated lobe", () => {
    const frames = Array.from({ length: 3 }, () => {
      const image = makeFrame(360, 720);
      projected.forEach((point, index) => {
        drawDisc(image, point, 5, { r: 154, g: 103, b: 122 });
        if (index === 9) {
          drawDisc(image, { x: point.x + 5 / image.width, y: point.y }, 2, { r: 235, g: 24, b: 35 });
        }
      });
      return image;
    });

    const result = alignStandardSpeedRouteVisually(frames, calibration);

    expect(result.aligned).toBe(true);
    expect(result.holds[9].observedImage).toBeDefined();
    expect(pointDistance(result.holds[9].observedImage!, projected[9])).toBeLessThan(0.004);
    expect(result.holds[9].observedImage!.x).toBeLessThan(projected[9].x + 2 / 360);
  });

  it("uses the strict wider pass for a strongly oblique real-video-sized correction", () => {
    const obliqueTransform: Matrix = [
      1.6106, -0.0208, -0.339,
      -0.0566, 0.9851, 0.1529,
      0, 0, 1,
    ];
    const frames = Array.from({ length: 5 }, () => {
      const image = makeFrame(360, 720);
      drawRoute(image, obliqueTransform, new Set(), pink, 4);
      return image;
    });
    const automaticCalibration = { ...calibration, source: "automatic-approximate" as const };

    const { result, usedExpandedSearch } = alignStandardSpeedRouteWithFallback(frames, automaticCalibration);

    expect(usedExpandedSearch).toBe(true);
    expect(result.aligned).toBe(true);
    expect(result.diagnostics.matchedHoldIds.length).toBeGreaterThanOrEqual(15);
    expect(result.diagnostics.medianResidualNormalized).toBeLessThan(0.018);
    expect(result.diagnostics.maximumCorrectionNormalized).toBeGreaterThan(0.1);
    expect(result.hold10Image).toBeDefined();
  });

  it("refuses missing, mismatched, or invalid frame inputs deterministically", () => {
    expect(alignStandardSpeedRouteVisually([], calibration)).toMatchObject({ aligned: false, confidence: "None" });
    const first = makeFrame(200, 400);
    const second = makeFrame(201, 400);
    expect(alignStandardSpeedRouteVisually([first, second], calibration).reason).toContain("matching dimensions");
    expect(alignStandardSpeedRouteVisually([first], undefined).reason).toContain("valid wall calibration");
  });
});

type Matrix = readonly [number, number, number, number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function makeFrame(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = background.r;
    data[index * 4 + 1] = background.g;
    data[index * 4 + 2] = background.b;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

function cloneFrame(frame: ImageData): ImageData {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data), colorSpace: "srgb" } as ImageData;
}

function drawRoute(
  image: ImageData,
  transform: Matrix,
  missing: Set<number>,
  color: RGB,
  radius = 4,
): void {
  projected.forEach((point, index) => {
    if (!missing.has(index + 1)) drawDisc(image, apply(transform, point), radius, color);
  });
}

function drawDisc(image: ImageData, center: NormalizedPoint, radius: number, color: RGB): void {
  const centerX = Math.round(center.x * (image.width - 1));
  const centerY = Math.round(center.y * (image.height - 1));
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if (x < 0 || x >= image.width || y < 0 || y >= image.height ||
          (x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) continue;
      const offset = (y * image.width + x) * 4;
      image.data[offset] = color.r;
      image.data[offset + 1] = color.g;
      image.data[offset + 2] = color.b;
      image.data[offset + 3] = 255;
    }
  }
}

function fillRect(
  image: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
  color: RGB,
): void {
  const left = Math.max(0, Math.floor(x * image.width));
  const top = Math.max(0, Math.floor(y * image.height));
  const right = Math.min(image.width, Math.ceil((x + width) * image.width));
  const bottom = Math.min(image.height, Math.ceil((y + height) * image.height));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      const offset = (py * image.width + px) * 4;
      image.data[offset] = color.r;
      image.data[offset + 1] = color.g;
      image.data[offset + 2] = color.b;
      image.data[offset + 3] = 255;
    }
  }
}

function apply(matrix: Matrix, point: NormalizedPoint): NormalizedPoint {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function maximumRouteError(result: RouteAlignmentResult, transform: Matrix): number {
  return Math.max(...result.holds.map((hold, index) => pointDistance(hold.image, apply(transform, projected[index]))));
}

function pointDistance(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
