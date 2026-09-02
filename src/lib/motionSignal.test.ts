import { describe, expect, it } from "vitest";
import { adaptiveMotionThreshold, causalSmoothMotion, selectMotionBaseline } from "./motionSignal";

describe("robust motion signal helpers", () => {
  it("raises the threshold above a noisy passerby baseline", () => {
    expect(adaptiveMotionThreshold([2.1, 2.4, 2.2, 2.5, 2.3], 1, 1)).toBeGreaterThan(3.2);
  });

  it("keeps the fixed threshold in a quiet lane", () => {
    expect(adaptiveMotionThreshold([0.05, 0.08, 0.04, 0.07], 1, 1)).toBeLessThan(1.2);
  });

  it("does not leak future launch motion into the preceding frame", () => {
    const samples = [
      { motionScore: 0, smoothedMotionScore: 0 },
      { motionScore: 0, smoothedMotionScore: 0 },
      { motionScore: 9, smoothedMotionScore: 9 },
    ];
    causalSmoothMotion(samples);
    expect(samples[1].smoothedMotionScore).toBe(0);
    expect(samples[2].smoothedMotionScore).toBe(6);
  });

  it("does not contaminate a short pre-start baseline with launch frames", () => {
    const samples = [
      { time: 0.04, smoothedMotionScore: 0.1 },
      { time: 0.11, smoothedMotionScore: 6 },
      { time: 0.18, smoothedMotionScore: 8 },
    ];
    expect(selectMotionBaseline(samples, 0.1)).toEqual([0.1]);
  });

  it("falls back to early samples only when the clip has no pre-start frame", () => {
    const samples = [
      { time: 0.1, smoothedMotionScore: 0.2 },
      { time: 0.2, smoothedMotionScore: 0.4 },
    ];
    expect(selectMotionBaseline(samples, 0, 2)).toEqual([0.2, 0.4]);
  });
});
