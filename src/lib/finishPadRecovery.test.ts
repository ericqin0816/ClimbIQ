import { describe, expect, it } from "vitest";
import {
  assessPadHandApproach,
  locateFinishTargets,
  locatePadApproach,
  type PadHandSample,
} from "./finishPadRecovery";
import type { NormalizedZone, PoseLandmarkPoint } from "../types";
import type { TopFinishFrame } from "./detectTopFinishSignal";

const pad: NormalizedZone = {
  id: "finishPad",
  label: "Test target",
  x1: 0.49,
  x2: 0.51,
  y1: 0.095,
  y2: 0.105,
};
function frame(time: number): TopFinishFrame {
  return {
    time,
    width: 200,
    height: 200,
    data: new Uint8ClampedArray(200 * 200 * 4).fill(40),
  };
}
function box(
  f: TopFinishFrame,
  x: number,
  y: number,
  w = 6,
  h = 2,
  rgb = [20, 180, 30],
) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      f.data.set([...rgb, 255], ((y + dy) * f.width + x + dx) * 4);
  return f;
}
function targets(xs = [55, 105], rgb = [20, 180, 30]) {
  return Array.from({ length: 5 }, (_, i) => {
    const f = frame(i * 0.2);
    xs.forEach((x) => box(f, x, 20, 6, 2, rgb));
    return f;
  });
}
function trajectory(): PadHandSample[] {
  return [0.18, 0.16, 0.14, 0.12, 0.105, 0.105].map((y, i) => ({
    rawTime: 1 + i * 0.1,
    nativeTimed: true,
    landmarks: [
      ...[11, 12, 23, 24].map((index, j) => ({
        index,
        x: 0.5,
        y: j < 2 ? 0.17 : 0.22,
        z: 0,
        visibility: 0.9,
      })),
      ...[15, 17, 19, 21].map((index) => ({
        index,
        x: 0.5,
        y,
        z: 0,
        visibility: 0.9,
      })),
    ],
  }));
}

describe("automatic finish-target localization (review only)", () => {
  it("uses separated target ordering for perspective-shifted lanes", () => {
    expect(locateFinishTargets(targets(), 0.8)[0].zone.x1).toBe(0.525);
    expect(locateFinishTargets(targets(), 0.2)[0].zone.x1).toBe(0.275);
    expect(locateFinishTargets(targets(), 0.8)[0].zone.label).toContain(
      "candidate",
    );
  });
  it("allows one nearby target but refuses unsupported lane assignment", () => {
    expect(locateFinishTargets(targets([105]), 0.7)).toHaveLength(1);
    expect(locateFinishTargets(targets([105]), 0.1)).toEqual([]);
    for (const hint of [undefined, NaN, -1, 2])
      expect(locateFinishTargets(targets(), hint)).toEqual([]);
  });
  it("rejects ambiguous groups and closely spaced targets", () => {
    expect(locateFinishTargets(targets([35, 85, 135]), 0.8)).toEqual([]);
    expect(locateFinishTargets(targets([90, 108]), 0.8)).toEqual([]);
  });
  it.each([
    [180, 20, 20],
    [180, 180, 180],
    [40, 40, 40],
  ])("does not call a red clock or white lamp a target: %s", (...rgb) => {
    expect(locateFinishTargets(targets([105], rgb), 0.7)).toEqual([]);
  });
  it("does not manufacture persistence from duplicate native frames", () => {
    const f = targets([105])[0];
    expect(locateFinishTargets([f, f, f, f], 0.7)).toEqual([]);
  });
  it("rejects moving components and malformed frames", () => {
    expect(
      locateFinishTargets(
        Array.from({ length: 5 }, (_, i) =>
          box(frame(i * 0.2), 90 + i * 4, 20),
        ),
        0.7,
      ),
    ).toEqual([]);
    const f = frame(0);
    f.data = new Uint8ClampedArray(10);
    expect(locateFinishTargets([f, f, f], 0.7)).toEqual([]);
    expect(locateFinishTargets([], 0.7)).toEqual([]);
  });
  it("requires sustained upward movement, not a flashing target alone", () => {
    const frames = Array.from({ length: 25 }, (_, i) => {
      const f = frame(i * 0.2);
      if (i >= 8 && i <= 15)
        box(f, 108, 58 - (i - 8) * 5, 6, 10, [170, 160, 150]);
      return f;
    });
    const result = locatePadApproach(frames, pad);
    expect(result).toBeGreaterThanOrEqual(2.6);
    expect(result).toBeLessThanOrEqual(3);
    expect(locatePadApproach([...frames].reverse(), pad)).toBe(result);
    expect(locatePadApproach(targets([98]), pad)).toBeUndefined();
    expect(
      locatePadApproach(
        Array.from({ length: 25 }, (_, i) =>
          box(frame(i * 0.2), 98, 19, 6, 2, i % 2 ? [0, 180, 0] : [180, 0, 0]),
        ),
        pad,
      ),
    ).toBeUndefined();
  });
  it("rejects malformed target geometry", () => {
    const invalid = { ...pad, x1: NaN };
    expect(
      locatePadApproach(
        Array.from({ length: 8 }, (_, i) => frame(i)),
        invalid,
      ),
    ).toBeUndefined();
    expect(assessPadHandApproach(trajectory(), invalid).found).toBe(false);
  });
});

describe("experimental hand approach", () => {
  it("returns only review evidence for continuous approach and successive nearby frames", () => {
    const result = assessPadHandApproach(trajectory(), pad);
    expect(result.found).toBe(true);
    expect(result.reason).toContain("does not verify a pad press");
    expect(result).not.toHaveProperty("accepted");
  });
  it("rejects a single-frame flyby and static hovering", () => {
    expect(assessPadHandApproach(trajectory().slice(0, -1), pad).found).toBe(
      false,
    );
    const hover = trajectory().map((s) => ({
      ...s,
      landmarks: s.landmarks.map((p) =>
        p.index >= 15 ? { ...p, y: 0.105 } : p,
      ),
    }));
    expect(assessPadHandApproach(hover, pad).found).toBe(false);
  });
  it("rejects occluded hands, large foreground torsos and gaps", () => {
    const modify = (fn: (p: PoseLandmarkPoint) => PoseLandmarkPoint) =>
      trajectory().map((s) => ({ ...s, landmarks: s.landmarks.map(fn) }));
    expect(
      assessPadHandApproach(
        modify((p) => (p.index >= 15 ? { ...p, visibility: 0.1 } : p)),
        pad,
      ).found,
    ).toBe(false);
    expect(
      assessPadHandApproach(
        modify((p) =>
          p.index === 23 || p.index === 24 ? { ...p, y: 0.5 } : p,
        ),
        pad,
      ).found,
    ).toBe(false);
    expect(
      assessPadHandApproach(
        trajectory().filter((_, i) => i !== 2 && i !== 3),
        pad,
      ).found,
    ).toBe(false);
  });
  it("cannot turn repeated copies of one frame into an approach", () => {
    const sample = trajectory()[4];
    expect(assessPadHandApproach(Array(10).fill(sample), pad).found).toBe(
      false,
    );
  });
});
