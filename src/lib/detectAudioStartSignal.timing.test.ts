import { describe, expect, it } from "vitest";
import { analyzeBeepSequence } from "./detectAudioStartSignal";

const RATE = 8_000;

describe("qualified audio analysis-window provenance", () => {
  it.each([0, .003, .005, .007, .00975])("preserves the leading frame clock across sharp-tone hop phase %s", phase => {
    const result = analyzeBeepSequence(protocol({ phase, attack: 0, noise: .02, amplitude: .08 }), RATE);
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBe(2.79);
    expect(result.searchHintTime).toBe(2.79);
    expect(result.sequence?.at(-1)?.startTime).toBe(2.79);
    expect(result.timingWindow).toEqual({
      startRawTime: 2.79, endRawTime: 2.81, hopSeconds: .01, isEventAccuracyBound: false,
    });
    // The reported leading 20 ms feature window can precede PCM insertion.
    // It is neither a corrected arrival clock nor an accuracy claim.
    expect(result.rawTime!).toBeLessThan(2.8 + phase);
    expect(result.reason).not.toMatch(/localized|resolved/i);
    expect(result).not.toHaveProperty("onsetRefinement");
  });

  it.each([.01, .015, .03])("does not replace a quiet tone lead with its louder amplitude step at %ss", quietLead => {
    const result = analyzeBeepSequence(protocol({ phase: .001, noise: .02, quietLead, quietAmplitude: .002 }), RATE);
    expect(result.confidence).toBe("High");
    // Original clock is 1 ms before PCM insertion, rather than 10–30 ms late
    // at the much louder step. The quiet lead can be masked by this noise.
    expect(result.rawTime).toBe(2.8);
    expect(result.searchHintTime).toBe(2.8);
    expect(result.timingWindow?.isEventAccuracyBound).toBe(false);
    expect(result).not.toHaveProperty("onsetRefinement");
  });

  it("does not label an unrelated leading pulse as a resolved final-tone arrival", () => {
    const result = analyzeBeepSequence(protocol({ finalStart: 2.808, attack: 0, noise: 0, pulse: true }), RATE);
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBe(2.79);
    expect(result.sequence?.at(-1)?.startTime).toBe(2.79);
    expect(result.timingWindow?.isEventAccuracyBound).toBe(false);
    expect(result).not.toHaveProperty("onsetRefinement");
  });

  it("does not treat window support as an error bracket when another tone overlaps", () => {
    const result = analyzeBeepSequence(protocol({ phase: .003, attack: 0, noise: .02, overlap: true }), RATE);
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBe(2.78);
    // Known final-tone insertion (2.803 s) lies beyond this nominal window.
    // That is why even this explicit 20 ms window is not an event-error bound.
    expect(result.timingWindow?.endRawTime).toBe(2.8);
    expect(result.timingWindow?.endRawTime).toBeLessThan(2.803);
    expect(result.timingWindow?.isEventAccuracyBound).toBe(false);
  });

  it.each([.02, .08])("preserves weak noisy %ss attack behavior without claiming refined precision", attack => {
    const result = analyzeBeepSequence(protocol({ phase: .005, attack, noise: .02, amplitude: .08 }), RATE);
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBe(result.sequence?.at(-1)?.startTime);
    expect(result.timingWindow?.hopSeconds).toBe(.01);
    expect(result.timingWindow?.isEventAccuracyBound).toBe(false);
    expect(result).not.toHaveProperty("onsetRefinement");
  });

  it("keeps window support in the original recording clock with a nonzero offset", () => {
    const result = analyzeBeepSequence(protocol({ phase: .003, attack: 0, noise: .02, amplitude: .08 }), RATE, 7.25);
    expect(result.rawTime).toBe(10.04);
    expect(result.searchHintTime).toBe(10.04);
    expect(result.timingWindow?.startRawTime).toBeCloseTo(10.04, 10);
    expect(result.timingWindow?.endRawTime).toBeCloseTo(10.06, 10);
    expect(result.timingWindow?.hopSeconds).toBe(.01);
  });

  it("keeps generic, approximate-pitch and absent cues free of High-protocol provenance", () => {
    const generic = analyzeBeepSequence(protocol({ finalPitch: 554 }), RATE);
    expect(generic.confidence).toBe("Low");
    expect(generic.timingWindow).toBeUndefined();
    const approximate = analyzeBeepSequence(protocol({ secondPitch: 585, finalPitch: 1_064, attack: .005 }), RATE);
    expect(approximate.confidence).toBe("Medium");
    expect(approximate.timingWindow).toBeUndefined();
    const absent = analyzeBeepSequence(new Float32Array(RATE * 4), RATE);
    expect(absent.found).toBe(false);
    expect(absent.timingWindow).toBeUndefined();
  });
});

interface ProtocolOptions {
  phase?: number;
  attack?: number;
  noise?: number;
  amplitude?: number;
  finalPitch?: number;
  secondPitch?: number;
  finalStart?: number;
  quietLead?: number;
  quietAmplitude?: number;
  pulse?: boolean;
  overlap?: boolean;
}

function protocol({ phase = 0, attack = .001, noise = .0015, amplitude = .3,
  finalPitch = 1_108, secondPitch = 554, finalStart = 2.8 + phase,
  quietLead = 0, quietAmplitude = 0, pulse = false, overlap = false }: ProtocolOptions): Float32Array {
  let state = 0x18acb3;
  const samples = Float32Array.from({ length: RATE * 4 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0xffffffff * 2 - 1) * noise;
  });
  for (const [time, frequency, rise, final] of [
    [.8 + phase, 554, .001, false], [1.8 + phase, secondPitch, .001, false], [finalStart, finalPitch, attack, true],
  ] as const) {
    const start = Math.round(time * RATE), length = Math.round(.16 * RATE), attackFrames = Math.round(rise * RATE);
    for (let index = 0; index < length; index++) samples[start + index] +=
      (final && index < Math.round(quietLead * RATE) ? quietAmplitude : amplitude) *
      Math.sin(2 * Math.PI * frequency * index / RATE) *
      Math.min(1, attackFrames ? index / attackFrames : 1, (length - index) / 40);
  }
  if (pulse) for (let index = Math.round(2.802 * RATE); index < Math.round(2.806 * RATE); index++) {
    samples[index] += .004 * Math.sin(2 * Math.PI * 700 * (index / RATE - 2.802));
  }
  if (overlap) for (let index = Math.round(2.72 * RATE); index < Math.round(3.05 * RATE); index++) {
    samples[index] += .03 * Math.sin(2 * Math.PI * 700 * (index / RATE - 2.72));
  }
  return samples;
}
