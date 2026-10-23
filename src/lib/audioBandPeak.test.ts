import { describe, expect, it } from "vitest";
import { analyzeAudioChannelWindow, analyzeBeepSequence, estimateSpectralBand } from "./detectAudioStartSignal";

const RATE = 8_000;

describe("targeted audio band peaks", () => {
  const band = (tones: Array<[number, number]>) => estimateSpectralBand(
    Float32Array.from({ length: 160 }, (_, index) => tones.reduce((sum, [frequency, amplitude]) =>
      sum + amplitude * Math.sin(2 * Math.PI * frequency * index / RATE), 0)),
    RATE, 550 * 1.85, 550 * 2.15,
  );

  it("does not label the shoulder of a stronger outside-band tone as a peak", () => {
    // The 1000 Hz peak lies outside this band. Its Hann-window shoulder at
    // 1050 Hz is strong inside the band, but it is not a separate tone.
    expect(band([[1000, .5]]).frequency).toBeUndefined();
  });

  it("finds a weaker real peak behind the strongest in-band shoulder", () => {
    const result = band([[1150, .1], [1000, .5]]);
    expect(result.frequency).toBe(1150);
    expect(result.prominenceDb).toBeGreaterThan(14);
  });

  it.each([1050, 1100, 1150])("preserves a true %i Hz peak, including band boundaries", frequency => {
    expect(band([[frequency, .5]]).frequency).toBe(frequency);
  });

  it("preserves a half-bin tone rather than requiring strict neighboring inequalities", () => {
    expect([1050, 1100]).toContain(band([[1075, .5]]).frequency);
  });

  it("preserves a quiet final tone below a louder outside-band tone", () => {
    const result = band([[1100, .05], [300, .5]]);
    expect(result.frequency).toBe(1100);
    expect(result.prominenceDb).toBeGreaterThan(14);
  });
});

describe("audio timing countercontrols", () => {
  it.each([.0015, .02].flatMap(noise => [.002, .005, .01, .02].map(quiet => ({ noise, quiet }))))(
    "retains the observed quiet leading edge with noise $noise and leading amplitude $quiet", ({ noise, quiet }) => {
      let state = 0x18acb3;
      const samples = Float32Array.from({ length: 4 * RATE }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return (state / 0xffffffff * 2 - 1) * noise;
      });
      for (const [baseTime, frequency] of [[.8, 554], [1.8, 554], [2.8, 1108]]) {
        const start = Math.round((baseTime + .003) * RATE), length = Math.round(.16 * RATE);
        for (let index = 0; index < length; index++) {
          const amplitude = baseTime > 2 && index / RATE < .02 ? quiet : .3;
          samples[start + index] += amplitude * Math.sin(2 * Math.PI * frequency * index / RATE) *
            Math.min(1, index / 8, (length - index) / 40);
        }
      }
      const result = analyzeBeepSequence(samples, RATE);
      expect(result.confidence).toBe("High");
      // The authored quiet attack starts at 2.803 s, before its louder part.
      // Preserve a nominal feature window containing that attack; do not move
      // the clock forward to the loud transition at 2.823 s.
      expect(result.timingWindow!.startRawTime).toBeLessThanOrEqual(2.803);
      expect(result.timingWindow!.endRawTime).toBeGreaterThanOrEqual(2.803);
    },
  );

  it("keeps an earlier real mixed protocol when both noisy channels prefer a later protocol", async () => {
    const base = new Float32Array(10 * RATE);
    for (const [times, amplitude] of [[[.8, 1.8, 2.8], .1], [[5.8, 6.8, 7.8], .3]] as const) {
      times.forEach((time, beep) => {
        const start = Math.round(time * RATE), length = Math.round(.16 * RATE);
        for (let index = 0; index < length; index++) base[start + index] += amplitude *
          Math.sin(2 * Math.PI * [550, 550, 1100][beep] * index / RATE) * Math.min(1, index / 40, (length - index) / 40);
      });
    }
    let state = 0x2468ace;
    const channels = [base.slice(), base.slice()];
    for (let index = 0; index < 4 * RATE; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = (state / 0xffffffff * 2 - 1) * .7;
      channels[0][index] += noise;
      channels[1][index] -= noise;
    }
    for (const channel of channels) {
      const individual = analyzeBeepSequence(channel, RATE);
      expect(individual.confidence).toBe("High");
      expect(individual.rawTime).toBeCloseTo(7.79, 2);
    }
    const result = await analyzeAudioChannelWindow(channels, RATE, 0, base.length, 0);
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeCloseTo(2.79, 2);
    expect(result.channelRecovery).toBeUndefined();
  });
});
