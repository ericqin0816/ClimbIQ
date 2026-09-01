import { describe, expect, it } from "vitest";
import { analyzeBeepSequence, resampleMixedChannels } from "./detectAudioStartSignal";

const SAMPLE_RATE = 8_000;

describe("audio final-beep detection", () => {
  it("selects the different-pitch final beep after matching countdown tones", () => {
    const audio = synthesize(5, [
      { time: 0.5, frequency: 554 },
      { time: 1.5, frequency: 554 },
      { time: 2.5, frequency: 554 },
      { time: 3.5, frequency: 1_108 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(3.5, 1);
    expect(result.confidence).toBe("High");
    expect(result.sequence).toHaveLength(3);
    expect(result.matchedPattern).toBe("two-same-then-different");
  });

  it("gives the exact three-beep signature high confidence", () => {
    const audio = synthesize(4, [
      { time: 0.8, frequency: 554 },
      { time: 1.8, frequency: 554 },
      { time: 2.8, frequency: 1_108 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.8, 1);
    expect(result.confidence).toBe("High");
    expect(result.matchedPattern).toBe("two-same-then-different");
  });

  it("does not treat three same-pitch tones as the exact start signature", () => {
    const result = analyzeBeepSequence(synthesize(4, [
      { time: 0.8, frequency: 900 },
      { time: 1.3, frequency: 900 },
      { time: 1.8, frequency: 900 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).not.toBe("two-same-then-different");
    expect(result.confidence).toBe("Low");
  });

  it("does not treat three arbitrary rising pitches as the exact signature", () => {
    const result = analyzeBeepSequence(synthesize(4, [
      { time: 0.8, frequency: 700 },
      { time: 1.3, frequency: 1_000 },
      { time: 1.8, frequency: 1_800 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).not.toBe("two-same-then-different");
    expect(result.confidence).toBe("Low");
  });

  it("ignores spoken-ready-like tones and a later unrelated tone", () => {
    const result = analyzeBeepSequence(synthesize(5, [
      { time: 0.2, frequency: 330, duration: 0.35, amplitude: 1 },
      { time: 0.9, frequency: 900, amplitude: 0.12 },
      { time: 1.4, frequency: 900, amplitude: 0.12 },
      { time: 1.9, frequency: 1_300, amplitude: 0.12 },
      { time: 2.4, frequency: 700, amplitude: 0.4 },
    ]), SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.rawTime).toBeCloseTo(1.9, 1);
  });

  it("requires a meaningful final pitch change", () => {
    const result = analyzeBeepSequence(synthesize(4, [
      { time: 0.8, frequency: 900 },
      { time: 1.3, frequency: 900 },
      { time: 1.8, frequency: 970 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).not.toBe("two-same-then-different");
    expect(result.confidence).toBe("Low");
  });

  it("supports a lower-pitch final start beep", () => {
    const result = analyzeBeepSequence(synthesize(4, [
      { time: 0.8, frequency: 1_200 },
      { time: 1.3, frequency: 1_200 },
      { time: 1.8, frequency: 800 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.rawTime).toBeCloseTo(1.8, 1);
  });

  it("finds the quiet reference-style 554/554/1105 Hz cue below ambient RMS", () => {
    const audio = synthesizeNoisyReferenceCue();
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeGreaterThanOrEqual(4.24);
    expect(result.rawTime).toBeLessThanOrEqual(4.32);
  });

  it("recovers a matching beep swallowed inside a longer different-pitch segment", () => {
    const audio = synthesize(5, [
      { time: 0.8, frequency: 554, duration: 0.22, amplitude: 0.16 },
      { time: 1.8, frequency: 430, duration: 0.68, amplitude: 0.09 },
      { time: 1.8, frequency: 554, duration: 0.22, amplitude: 0.18 },
      { time: 2.8, frequency: 1_108, duration: 0.16, amplitude: 0.16 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeCloseTo(2.8, 1);
    expect(result.sequence?.map((segment) => segment.dominantFrequencyHz)).toEqual([
      expect.closeTo(554, -1),
      expect.closeTo(554, -1),
      expect.closeTo(1_108, -1),
    ]);
  });

  it("recovers a quiet octave-up final beep beneath a louder speech-like tone", () => {
    const audio = synthesize(5, [
      { time: 0.8, frequency: 554, duration: 0.22, amplitude: 0.16 },
      { time: 1.8, frequency: 554, duration: 0.22, amplitude: 0.16 },
      { time: 2.8, frequency: 1_108, duration: 0.16, amplitude: 0.045 },
      { time: 2.76, frequency: 650, duration: 0.32, amplitude: 0.2 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeCloseTo(2.8, 1);
  });

  it("prefers the earliest octave-coded protocol over a louder later pitch change", () => {
    const audio = synthesize(8, [
      { time: 0.8, frequency: 554, amplitude: 0.12 },
      { time: 1.8, frequency: 554, amplitude: 0.12 },
      { time: 2.8, frequency: 1_108, amplitude: 0.1 },
      { time: 4.2, frequency: 310, amplitude: 0.7 },
      { time: 5.2, frequency: 310, amplitude: 0.7 },
      { time: 6.2, frequency: 1_070, amplitude: 0.9 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBeCloseTo(2.8, 1);
  });

  it("does not promote a non-octave pitch change to high confidence", () => {
    const result = analyzeBeepSequence(synthesize(5, [
      { time: 0.8, frequency: 554 },
      { time: 1.8, frequency: 554 },
      { time: 2.8, frequency: 1_550 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.confidence).toBe("Medium");
  });

  it("does not call visibly different countdown pitches a same-pitch protocol", () => {
    const result = analyzeBeepSequence(synthesize(5, [
      { time: 0.8, frequency: 573 },
      { time: 1.8, frequency: 492 },
      { time: 2.8, frequency: 927 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).not.toBe("two-same-then-different");
  });

  it("does not promote a too-fast octave pattern to high confidence", () => {
    const result = analyzeBeepSequence(synthesize(4, [
      { time: 0.8, frequency: 554 },
      { time: 1.25, frequency: 554 },
      { time: 1.7, frequency: 1_108 },
    ]), SAMPLE_RATE);

    expect(result.matchedPattern).toBe("two-same-then-different");
    expect(result.confidence).toBe("Medium");
  });

  it("rejects irregular isolated sounds that do not form a countdown", () => {
    const audio = synthesize(5, [
      { time: 0.5, frequency: 700 },
      { time: 0.72, frequency: 1_100 },
      { time: 2.3, frequency: 600 },
    ]);
    expect(analyzeBeepSequence(audio, SAMPLE_RATE).found).toBe(false);
  });

  it("keeps a countdown whose final beep is much longer than the earlier beeps", () => {
    const audio = synthesize(5, [
      { time: 1, frequency: 850 },
      { time: 1.5, frequency: 850 },
      { time: 2, frequency: 850 },
      { time: 2.5, frequency: 1_250, duration: 0.55 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.5, 1);
  });

  it("backtracks through a gradual final-beep fade-in to its first audible onset", () => {
    const audio = synthesize(5, [
      { time: 1, frequency: 850 },
      { time: 1.5, frequency: 850 },
      { time: 2, frequency: 850 },
      { time: 2.5, frequency: 1_250, duration: 0.5, attackSeconds: 0.22 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeGreaterThanOrEqual(2.48);
    expect(result.rawTime).toBeLessThanOrEqual(2.52);
  });

  it("falls back to the single prominent loud beep when no countdown exists", () => {
    const audio = synthesize(5, [
      { time: 0.6, frequency: 500, amplitude: 0.1 },
      { time: 2.2, frequency: 1_000, duration: 0.5, amplitude: 0.8 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.2, 1);
    expect(result.confidence).toBe("Low");
  });

  it("does not treat equally loud unrelated sounds as a start beep", () => {
    const audio = synthesize(5, [
      { time: 0.8, frequency: 700, duration: 0.3 },
      { time: 3.1, frequency: 750, duration: 0.3 },
    ]);
    expect(analyzeBeepSequence(audio, SAMPLE_RATE).found).toBe(false);
  });
});

describe("browser audio preprocessing", () => {
  it("preserves the real in-band cue when downsampling 44.1 kHz audio", () => {
    const sourceRate = 44_100;
    const source = synthesizeAtRate(sourceRate, 6, [
      { time: 2, frequency: 554, duration: 0.12 },
      { time: 3, frequency: 554, duration: 0.12 },
      { time: 4, frequency: 1_108, duration: 0.14 },
    ]);
    const resampled = resampleMixedChannels([source], sourceRate, 0, source.length, SAMPLE_RATE);

    const result = analyzeBeepSequence(resampled, SAMPLE_RATE);
    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(4, 1);
    expect(result.confidence).toBe("High");
  });

  it("does not alias out-of-band tones into a false official cue", () => {
    const sourceRate = 44_100;
    const source = synthesizeAtRate(sourceRate, 6, [
      { time: 2, frequency: 8_554, duration: 0.12 },
      { time: 3, frequency: 8_554, duration: 0.12 },
      { time: 4, frequency: 9_108, duration: 0.14 },
    ]);
    const resampled = resampleMixedChannels([source], sourceRate, 0, source.length, SAMPLE_RATE);

    const result = analyzeBeepSequence(resampled, SAMPLE_RATE);
    expect(result.matchedPattern).not.toBe("two-same-then-different");
  });

  it("mixes channels without changing their constant mean", () => {
    const left = new Float32Array(4_410).fill(0.25);
    const right = new Float32Array(4_410).fill(0.75);
    const resampled = resampleMixedChannels([left, right], 44_100, 0, left.length, SAMPLE_RATE);

    expect(resampled.length).toBe(800);
    expect(Math.min(...resampled)).toBeCloseTo(0.5, 5);
    expect(Math.max(...resampled)).toBeCloseTo(0.5, 5);
  });
});

function synthesize(
  durationSeconds: number,
  beeps: Array<{ time: number; frequency: number; duration?: number; amplitude?: number; attackSeconds?: number }>,
): Float32Array {
  const samples = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  let noiseState = 0x9e3779b9;
  for (let index = 0; index < samples.length; index += 1) {
    noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = ((noiseState / 0xffffffff) * 2 - 1) * 0.0015;
  }
  for (const beep of beeps) {
    const start = Math.round(beep.time * SAMPLE_RATE);
    const length = Math.round((beep.duration ?? 0.14) * SAMPLE_RATE);
    const attackSamples = Math.max(1, Math.round((beep.attackSeconds ?? 60 / SAMPLE_RATE) * SAMPLE_RATE));
    for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
      const envelope = Math.min(1, offset / attackSamples, (length - offset) / 60);
      samples[start + offset] += Math.sin(2 * Math.PI * beep.frequency * offset / SAMPLE_RATE) * (beep.amplitude ?? 0.75) * envelope;
    }
  }
  return samples;
}

function synthesizeAtRate(
  sampleRate: number,
  durationSeconds: number,
  beeps: Array<{ time: number; frequency: number; duration: number; amplitude?: number }>,
): Float32Array {
  const samples = new Float32Array(Math.ceil(sampleRate * durationSeconds));
  for (const beep of beeps) {
    const start = Math.round(beep.time * sampleRate);
    const length = Math.round(beep.duration * sampleRate);
    for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
      const fadeSamples = Math.max(1, Math.round(sampleRate * 0.005));
      const envelope = Math.min(1, offset / fadeSamples, (length - offset) / fadeSamples);
      samples[start + offset] += Math.sin(2 * Math.PI * beep.frequency * offset / sampleRate) *
        (beep.amplitude ?? 0.75) * envelope;
    }
  }
  return samples;
}

function synthesizeNoisyReferenceCue(): Float32Array {
  const samples = new Float32Array(9 * SAMPLE_RATE);
  let state = 0x12345678;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = ((state / 0xffffffff) * 2 - 1) * 0.02;
  }
  addTone(samples, 2.26, 554, 0.24, 0.04);
  addTone(samples, 3.26, 554, 0.24, 0.035);
  addTone(samples, 4.264, 1_105, 0.09, 0.018);
  addTone(samples, 7.08, 400, 0.16, 0.18);
  addTone(samples, 7.37, 760, 0.16, 0.2);
  addTone(samples, 7.68, 540, 0.2, 0.3);
  return samples;
}

function addTone(
  samples: Float32Array,
  time: number,
  frequency: number,
  duration: number,
  amplitude: number,
): void {
  const start = Math.round(time * SAMPLE_RATE);
  const length = Math.round(duration * SAMPLE_RATE);
  for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
    const envelope = Math.min(1, offset / 40, (length - offset) / 40);
    samples[start + offset] += Math.sin(2 * Math.PI * frequency * offset / SAMPLE_RATE) * amplitude * envelope;
  }
}
