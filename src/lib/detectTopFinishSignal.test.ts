import { describe, expect, it } from "vitest";
import type { NormalizedZone, RGB, StartLightCalibration } from "../types";
import { normalizedZoneToPixelRect } from "./videoFrameSampler";
import {
  analyzeTopFinishColorSamples,
  analyzeReviewedFinishColorSamples,
  asMarkedFinishIndicatorReview,
  analyzeTopFinishFrames,
  analyzeTopContactFrames,
  requireUpperFinishCorroboration,
  hasDistinctIndicatorHue,
  type TopFinishColorSample,
  type TopFinishFrame,
} from "./detectTopFinishSignal";

const darkRed: RGB = { r: 88, g: 24, b: 23 };
const brightGreen: RGB = { r: 34, g: 142, b: 48 };

describe("perspective-aware upper finish indicator", () => {
  it.each([{ x: 12, y: 2 }, { x: 10, y: 2 }, { x: 14, y: 2 }])(
    "preserves a tiny discovered light through temporal refinement at $x/$y",
    (indicator) => {
      const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], indicator);
      const discovery = analyzeTopFinishFrames(frames, 0.82);
      expect(discovery.found).toBe(true);
      const rect = normalizedZoneToPixelRect(discovery.zone!, 20, 20, "cover");
      // Model the browser's refinement crop, not the discovery helper's private
      // patch. These must observe the same area and color calibration.
      const cropAverage = (frame: TopFinishFrame): RGB => {
        let r = 0; let g = 0; let b = 0;
        for (let y = rect.y; y < rect.y + rect.height; y += 1) {
          for (let x = rect.x; x < rect.x + rect.width; x += 1) {
            const offset = (y * frame.width + x) * 4;
            r += frame.data[offset]; g += frame.data[offset + 1]; b += frame.data[offset + 2];
          }
        }
        const count = rect.width * rect.height;
        return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
      };
      const before = cropAverage(frames[0]);
      const after = cropAverage(frames[frames.length - 1]);
      expect(before, JSON.stringify({ rect, zone: discovery.zone })).toEqual(discovery.calibration!.beforeStartRGB);
      expect(after).toEqual(discovery.calibration!.afterStartRGB);
      const samples = [...repeat(before, 24), ...repeat(after, 38)]
        .map((averageRgb, index) => ({ time: 0.8 + index / 30, averageRgb }));
      const refined = analyzeTopFinishColorSamples(samples, discovery.calibration!);
      expect(refined.detected).toBe(true);
      expect(refined.rawTime).toBeCloseTo(1.6, 3);
      expect(requireUpperFinishCorroboration(refined, { found: false }).detected).toBe(false);
    },
  );
  it("rejects stopped red digits and brightness-only changes as finish indicators", () => {
    expect(hasDistinctIndicatorHue({ r: 180, g: 162, b: 145 }, { r: 220, g: 64, b: 63 })).toBe(false);
    expect(hasDistinctIndicatorHue(darkRed, { r: 176, g: 48, b: 46 })).toBe(false);
    expect(hasDistinctIndicatorHue({ r: 60, g: 60, b: 60 }, brightGreen)).toBe(false);
    expect(hasDistinctIndicatorHue(darkRed, brightGreen)).toBe(true);
    expect(hasDistinctIndicatorHue({ r: 48, g: 76, b: 49 }, { r: 48, g: 49, b: 77 })).toBe(true);
    expect(hasDistinctIndicatorHue({ r: NaN, g: 0, b: 0 }, brightGreen)).toBe(false);
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat({ r: 176, g: 48, b: 46 }, 12)], { x: 12, y: 2 });
    expect(analyzeTopFinishFrames(frames, 0.82).found).toBe(false);
  });
  it("finds a persistent tiny top light even when the upper lane shifts inward", () => {
    const frames = makeFrames([
      ...repeat(darkRed, 8),
      ...repeat(brightGreen, 12),
    ], { x: 12, y: 2 });

    const result = analyzeTopFinishFrames(frames, 0.82);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.6, 3);
    expect(result.zone?.id).toBe("finishLight");
  });

  it("rejects a short upper-wall occlusion and keeps the later settled light", () => {
    const skin = { r: 150, g: 92, b: 66 };
    const frames = makeFrames([
      ...repeat(darkRed, 7),
      skin,
      skin,
      ...repeat(darkRed, 5),
      ...repeat(brightGreen, 10),
    ], { x: 12, y: 2 });

    const result = analyzeTopFinishFrames(frames, 0.8);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.8, 3);
  });

  it("removes frame-wide exposure changes from localized light scoring", () => {
    const frames = makeFrames(repeat(darkRed, 18), { x: 12, y: 2 }, (index) => index < 8 ? 0 : 35);
    expect(analyzeTopFinishFrames(frames, 0.8).found).toBe(false);
  });

  it.each([
    { r: 192, g: 193, b: 184 },
    { r: 62, g: 108, b: 117 },
  ])("keeps a disappearing colored object's cursor explicitly unverified: %j", (wall) => {
    // Both transitions pass the old hue gate. A persistent new color alone
    // does not establish an indicator when it has become the surrounding wall.
    expect(hasDistinctIndicatorHue(darkRed, wall)).toBe(true);
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(wall, 12)], { x: 12, y: 2 }, () => 0, wall);
    const result = analyzeTopFinishFrames(frames, 0.8);
    expect(result.found).toBe(true);
    expect(result.rawTime).toBe(1.6);
    expect(result.targetLocalized).toBe(false);
    expect(result.confidence).toBe("Low");
    expect(result.reason).toContain("no electronic finish was established");
  });

  it.each([0, 35])("preserves a faint single-pixel indicator with frame exposure shift %s", (shift) => {
    const background = { r: 54, g: 55, b: 57 };
    const frames = makeFrames([...repeat({ r: 48, g: 76, b: 49 }, 8), ...repeat({ r: 48, g: 49, b: 77 }, 12)],
      { x: 12, y: 3 }, index => index < 8 ? 0 : shift, background);
    for (const frame of frames) for (const [x, y] of [[13, 3], [12, 4], [13, 4]]) {
      const exposure = frame.time < 1.6 ? 0 : shift;
      frame.data.set([background.r + exposure, background.g + exposure, background.b + exposure], (y * frame.width + x) * 4);
    }
    const result = analyzeTopFinishFrames(frames, 0.8);
    expect(result.found).toBe(true);
    expect(result.targetLocalized).toBe(true);
    expect(result.rawTime).toBe(1.6);
  });

  it("preserves a blurred indicator whose pale edge still contrasts with the wall", () => {
    const background = { r: 54, g: 55, b: 57 };
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 12, y: 2 });
    for (const frame of frames) {
      const color = frame.time < 1.6 ? darkRed : brightGreen;
      for (let y = 1; y <= 4; y++) for (let x = 11; x <= 14; x++) {
        if (x >= 12 && x <= 13 && y >= 2 && y <= 3) continue;
        const edge = mix(background, color, 0.22);
        frame.data.set([edge.r, edge.g, edge.b], (y * frame.width + x) * 4);
      }
    }
    expect(analyzeTopFinishFrames(frames, 0.8)).toMatchObject({ found: true, targetLocalized: true });
  });

  it("uses available context at an image edge without requiring invented surrounding pixels", () => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 1, y: 1 });
    expect(analyzeTopFinishFrames(frames)).toMatchObject({ found: true, targetLocalized: true });
  });

  it("does not replace missing ring pixels with a black high-contrast background", () => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 12, y: 1 });
    for (const frame of frames) frame.data = frame.data.slice(0, (frame.width + 13) * 4);
    const result = analyzeTopFinishFrames(frames, 0.8);
    expect(result.targetLocalized ?? false).toBe(false);
    expect(result.confidence).not.toBe("High");
  });

  it("rejects a persistent finish-like color when a foreground person covers the frame", () => {
    const frames = makeFrames([
      ...repeat(darkRed, 8),
      ...repeat(brightGreen, 10),
    ], { x: 12, y: 2 });
    for (let frameIndex = 8; frameIndex < frames.length; frameIndex += 1) {
      for (let index = 0; index < frames[frameIndex].data.length; index += 4) {
        frames[frameIndex].data[index] = 158;
        frames[frameIndex].data[index + 1] = 92;
        frames[frameIndex].data[index + 2] = 70;
      }
    }

    expect(analyzeTopFinishFrames(frames, 0.8).found).toBe(false);
  });

  it("refines the first faint connected transition at 30 fps", () => {
    const calibration: StartLightCalibration = {
      beforeStartRGB: darkRed,
      afterStartRGB: brightGreen,
      colorDelta: 150,
    };
    const faint = mix(darkRed, brightGreen, 0.12);
    const samples: TopFinishColorSample[] = [
      ...repeat(darkRed, 12),
      faint,
      faint,
      mix(darkRed, brightGreen, 0.55),
      ...repeat(brightGreen, 16),
    ].map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeTopFinishColorSamples(samples, calibration);

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
    expect(result.confidence).toBe("High");
  });

  it("does not backdate a green-to-red transition to a preceding same-hue darkening", () => {
    const before = { r: 40, g: 180, b: 80 };
    const after = { r: 190, g: 50, b: 45 };
    const samples = [
      ...repeat(before, 12),
      ...repeat({ r: 22, g: 99, b: 44 }, 3),
      ...repeat(mix(before, after, 0.12), 2),
      mix(before, after, 0.55),
      ...repeat(after, 20),
    ].map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after });

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(15 / 30, 3);
  });

  it("rejects a persistent darkening that retains the pre-finish hue", () => {
    const before = { r: 50, g: 210, b: 120 };
    const after = { r: 150, g: 40, b: 40 };
    const samples = [...repeat(before, 12), ...repeat({ r: 5, g: 21, b: 12 }, 24)]
      .map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after });

    expect(result.detected).toBe(false);
    expect(result.rawTime).toBeUndefined();
  });

  it.each([0.3, 0.6, 1])("preserves a real transition when its settled indicator brightness is scaled by %s", factor => {
    const samples = [...repeat(darkRed, 12), ...repeat({
      r: brightGreen.r * factor, g: brightGreen.g * factor, b: brightGreen.b * factor,
    }, 24)].map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: darkRed, afterStartRGB: brightGreen });

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
  });

  it.each([1, 2, 8])("anchors a connected %s-frame quiet ramp to the stable state before its first faint frame", rampFrames => {
    const before = { r: 40, g: 180, b: 80 };
    const after = { r: 190, g: 60, b: 50 };
    const samples = [...repeat(before, 12), ...repeat(mix(before, after, 0.14), rampFrames),
      mix(before, after, 0.55), ...repeat(after, 24)]
      .map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after });

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
  });

  it("does not bridge two observed source-state frames to preceding target-directed noise", () => {
    const before = { r: 40, g: 180, b: 80 };
    const after = { r: 190, g: 60, b: 50 };
    const samples = [...repeat(before, 8), ...repeat(mix(before, after, 0.1), 2), ...repeat(before, 2), ...repeat(after, 24)]
      .map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after });

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(12 / 30, 3);
  });

  it.each([
    { r: 2, g: 0, b: 0 },
    { r: 8, g: 0, b: 0 },
    { r: 12, g: 0, b: 0 },
    { r: 16, g: 0, b: 0 },
    { r: 24, g: 0, b: 0 },
    { r: 0, g: 0, b: 180 },
    { r: 180, g: 0, b: 180 },
  ])("does not turn a low-signal or third-hue patch into a settled target: %j", color => {
    const before = { r: 40, g: 180, b: 80 };
    const after = { r: 190, g: 50, b: 45 };
    const samples = [...repeat(before, 12), ...repeat(color, 24)]
      .map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    expect(analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after }).detected).toBe(false);
  });

  it("does not connect an unrelated third-hue obstruction to a later true transition", () => {
    const before = { r: 40, g: 180, b: 80 };
    const after = { r: 190, g: 50, b: 45 };
    const samples = [...repeat(before, 12), ...repeat({ r: 180, g: 0, b: 180 }, 2), ...repeat(after, 24)]
      .map((averageRgb, index) => ({ time: index / 30, averageRgb }));

    const result = analyzeReviewedFinishColorSamples(samples, { beforeStartRGB: before, afterStartRGB: after });

    expect(result.detected).toBe(true);
    expect(result.rawTime).toBeCloseTo(14 / 30, 3);
  });

  it("searches an explicitly selected sensor region outside the default upper band", () => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 14, y: 10 });
    const region: NormalizedZone = { id: "finishIndicator", label: "User-selected indicator search", x1: 0.7, y1: 0.5, x2: 0.9, y2: 0.7 };

    expect(analyzeTopFinishFrames(frames, 0.1).found).toBe(false);
    const result = analyzeTopFinishFrames(frames, 0.1, undefined, region);

    expect(result.found).toBe(true);
    expect(result.targetLocalized).toBe(true);
    expect(result.zone!.x1).toBeGreaterThanOrEqual(region.x1);
    expect(result.zone!.y1).toBeGreaterThanOrEqual(region.y1);
    expect(result.zone!.x2).toBeLessThanOrEqual(region.x2);
    expect(result.zone!.y2).toBeLessThanOrEqual(region.y2);
    expect(result.zone!.label).toContain("user-selected");
    expect(result.zone!.id).toBe("finishIndicator");
  });

  it("does not replace an empty user-selected region with another lane's changing indicator", () => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 12, y: 2 });
    const region: NormalizedZone = { id: "finishIndicator", label: "User-selected indicator search", x1: 0.1, y1: 0.5, x2: 0.3, y2: 0.7 };

    expect(analyzeTopFinishFrames(frames, undefined, undefined, region).found).toBe(false);
  });

  it.each([
    { x1: 0.6, y1: 0.1, x2: 0.5, y2: 0.2 },
    { x1: -0.1, y1: 0.1, x2: 0.8, y2: 0.2 },
    { x1: 0.1, y1: 0.1, x2: 1.1, y2: 0.2 },
    { x1: 0.1, y1: 0.1, x2: 0.8, y2: NaN },
    { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.2 },
  ])("rejects an invalid explicit region instead of falling back to automatic discovery: %j", bounds => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 12, y: 2 });
    const region: NormalizedZone = { id: "finishIndicator", label: "Invalid selected indicator", ...bounds };

    expect(analyzeTopFinishFrames(frames, undefined, undefined, region).found).toBe(false);
  });

  it.each(["finishPad", "finishLight"] as const)("does not reinterpret a %s region as a manual indicator", id => {
    const frames = makeFrames([...repeat(darkRed, 8), ...repeat(brightGreen, 12)], { x: 12, y: 2 });
    expect(analyzeTopFinishFrames(frames, undefined, undefined,
      { id, label: "Different region role", x1: .4, y1: .05, x2: .8, y2: .2 }).found).toBe(false);
  });

  it("caps an explicitly marked indicator even when its raw proposal was High and corroborated", () => {
    const outcome = asMarkedFinishIndicatorReview({ result: finishResult(7),
      zone: { id: "finishLight", label: "Raw discovery", x1: .7, y1: .1, x2: .8, y2: .2 } });
    expect(outcome).toMatchObject({ authority: "navigation-only", automaticAcceptanceAllowed: false, createsLaneIdentity: false });
    expect(outcome.result).toMatchObject({ detected: false, confidence: "Low" });
    expect(outcome.result.rawTime).toBeUndefined();
    expect(outcome.result.debug.detectedRawTime).toBeUndefined();
    expect(outcome.result.candidates?.[0]).toMatchObject({ rawTime: 7, confidence: "Low" });
    expect(outcome.zone?.id).toBe("finishIndicator");
  });

  it("keeps a debug-only discovered region in the manual role", () => {
    const raw = finishResult(7);
    const outcome = asMarkedFinishIndicatorReview({ result: { ...raw, debug: { ...raw.debug,
      normalizedZone: { id: "finishLight", label: "Raw discovery", x1: .7, y1: .1, x2: .8, y2: .2 } } } });
    expect(outcome.zone?.id).toBe("finishIndicator");
    expect(outcome.result.debug.normalizedZone?.id).toBe("finishIndicator");
    expect(outcome.result).toMatchObject({ detected: false, confidence: "Low" });
  });

  it("timestamps a physical top reach only when a descent follows", () => {
    const result = analyzeTopContactFrames(makeContactFrames([8, 7, 5, 3, 2, 2, 4, 6]), 0.8);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(1, 3);
    expect(result.confidence).toBe("Medium");
    expect(result.candidates[0].kind).toBe("Physical top reach");
  });

  it("does not call an upper-wall appearance a finish without downward reversal", () => {
    const result = analyzeTopContactFrames(makeContactFrames([8, 7, 5, 3, 2, 2, 2, 2]), 0.8);
    expect(result.found).toBe(false);
  });

  it("rejects a finish-like trajectory after the camera cuts away from the start view", () => {
    const laterCamera = makeContactFrames([8, 7, 5, 3, 2, 2, 4, 6]);
    // The trajectory is plausible when evaluated inside only the cropped later
    // shot, which is exactly why the post-start camera reference is required.
    expect(analyzeTopContactFrames(laterCamera, 0.8).found).toBe(true);

    const anchoredAcrossCut = [makeDifferentCameraFrame(), ...laterCamera.slice(1)];
    const result = analyzeTopContactFrames(anchoredAcrossCut, 0.8);
    expect(result.found).toBe(false);
    expect(result.reason).toContain("continuous, occlusion-free");
  });

  it("withholds an isolated upper color change instead of claiming a finish time", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: false });
    expect(result.confidence).toBe("Low");
    expect(result.detected).toBe(false);
    expect(result.rawTime).toBeUndefined();
    expect(result.reason).toContain("not independently corroborated");
    expect(result.candidates?.[0].confidence).toBe("Low");
    expect(result.candidates?.[0].rawTime).toBe(14.29);
    expect(requireUpperFinishCorroboration({ ...finishResult(14.29), confidence: "Medium" }, { found: false }).detected).toBe(false);
  });

  it("keeps coincident upper motion review-only without an official cross-check", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: true, rawTime: 13.7 });
    expect(result.confidence).toBe("Medium");
    expect(result.detected).toBe(true);
    expect(result.reason).toContain("foreground person");
  });

  it("cannot accept a timer reset corroborated by a late foreground-person trajectory", () => {
    // Observed failure times from the silent 9076 stress copy, not contact labels.
    const result = requireUpperFinishCorroboration(finishResult(29.717), { found: true, rawTime: 30.317 });
    expect(result.confidence).toBe("Medium");
    expect(result.rawTime).toBe(29.717);
    expect(result.reason).toContain("no official-time cross-check");
  });

  it("keeps a high upper light when an official total agrees", () => {
    const result = requireUpperFinishCorroboration(finishResult(14.29), { found: false }, 14.31);
    expect(result.confidence).toBe("High");
  });

  it("does not let a much earlier physical event corroborate a late timer reset", () => {
    const result = requireUpperFinishCorroboration(finishResult(20), { found: true, rawTime: 14.2 });
    expect(result.confidence).toBe("Low");
  });
});

function finishResult(rawTime: number) {
  return {
    detected: true,
    rawTime,
    confidence: "High" as const,
    reason: "Upper light changed.",
    threshold: 1,
    candidates: [{
      rawTime,
      confidence: "High" as const,
      reason: "Upper light changed.",
      score: 10,
      kind: "Upper light",
    }],
    debug: {
      zoneExists: true,
      framesSampled: 20,
      maxColorDistance: 50,
      threshold: 1,
      detectedCrossings: [{ time: rawTime, colorDistance: 50 }],
      samples: [],
    },
  };
}

function makeFrames(
  indicatorColors: RGB[],
  indicator: { x: number; y: number },
  exposureShift: (index: number) => number = () => 0,
  background: RGB = { r: 54, g: 55, b: 57 },
): TopFinishFrame[] {
  const width = 20;
  const height = 20;
  return indicatorColors.map((indicatorColor, frameIndex) => {
    const shift = exposureShift(frameIndex);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = background.r + shift;
      data[index + 1] = background.g + shift;
      data[index + 2] = background.b + shift;
      data[index + 3] = 255;
    }
    for (let y = indicator.y; y <= indicator.y + 1; y += 1) {
      for (let x = indicator.x; x <= indicator.x + 1; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = indicatorColor.r + shift;
        data[offset + 1] = indicatorColor.g + shift;
        data[offset + 2] = indicatorColor.b + shift;
      }
    }
    return { time: frameIndex / 5, width, height, data };
  });
}

function repeat(color: RGB, count: number): RGB[] {
  return Array.from({ length: count }, () => ({ ...color }));
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

function makeContactFrames(topRows: number[]): TopFinishFrame[] {
  const width = 30;
  const height = 30;
  const background = { r: 62, g: 64, b: 66 };
  const makeFrame = (time: number, topRow?: number): TopFinishFrame => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = background.r;
      data[index + 1] = background.g;
      data[index + 2] = background.b;
      data[index + 3] = 255;
    }
    if (topRow !== undefined) {
      for (let y = topRow; y < Math.min(height, topRow + 4); y += 1) {
        for (let x = 20; x < 24; x += 1) {
          const offset = (y * width + x) * 4;
          data[offset] = 25;
          data[offset + 1] = 118;
          data[offset + 2] = 178;
        }
      }
    }
    return { time, width, height, data };
  };
  return [makeFrame(0), ...topRows.map((row, index) => makeFrame((index + 1) / 5, row))];
}

function makeDifferentCameraFrame(): TopFinishFrame {
  const width = 30;
  const height = 30;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = (x + y) % 2 === 0 ? 18 : 190;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { time: 0, width, height, data };
}
