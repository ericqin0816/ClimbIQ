import { describe, expect, it } from "vitest";
import { adaptiveMotionThreshold, causalSmoothMotion } from "./motionSignal";

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
});
