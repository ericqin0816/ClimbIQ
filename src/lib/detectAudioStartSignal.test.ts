import { describe, expect, it } from "vitest";
import { analyzeBeepSequence } from "./detectAudioStartSignal";

const SAMPLE_RATE = 8_000;

describe("audio final-beep detection", () => {
  it("selects the final beep in a regular four-tone countdown", () => {
    const audio = synthesize(5, [
      { time: 1, frequency: 850 },
      { time: 1.5, frequency: 850 },
      { time: 2, frequency: 850 },
      { time: 2.5, frequency: 1_250 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.5, 1);
    expect(result.confidence).toBe("High");
    expect(result.sequence).toHaveLength(4);
  });

  it("supports three-beep start systems but lowers confidence", () => {
    const audio = synthesize(4, [
      { time: 0.8, frequency: 900 },
      { time: 1.3, frequency: 900 },
      { time: 1.8, frequency: 1_300 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(1.8, 1);
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

  it("falls back to the single prominent loud beep when no countdown exists", () => {
    const audio = synthesize(5, [
      { time: 0.6, frequency: 500, amplitude: 0.1 },
      { time: 2.2, frequency: 1_000, duration: 0.5, amplitude: 0.8 },
    ]);
    const result = analyzeBeepSequence(audio, SAMPLE_RATE);

    expect(result.found).toBe(true);
    expect(result.rawTime).toBeCloseTo(2.2, 1);
    expect(result.confidence).toBe("Medium");
  });

  it("does not treat equally loud unrelated sounds as a start beep", () => {
    const audio = synthesize(5, [
      { time: 0.8, frequency: 700, duration: 0.3 },
      { time: 3.1, frequency: 750, duration: 0.3 },
    ]);
    expect(analyzeBeepSequence(audio, SAMPLE_RATE).found).toBe(false);
  });
});

function synthesize(
  durationSeconds: number,
  beeps: Array<{ time: number; frequency: number; duration?: number; amplitude?: number }>,
): Float32Array {
  const samples = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * 0.731) * 0.0015;
  }
  for (const beep of beeps) {
    const start = Math.round(beep.time * SAMPLE_RATE);
    const length = Math.round((beep.duration ?? 0.14) * SAMPLE_RATE);
    for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
      const envelope = Math.min(1, offset / 60, (length - offset) / 60);
      samples[start + offset] += Math.sin(2 * Math.PI * beep.frequency * offset / SAMPLE_RATE) * (beep.amplitude ?? 0.75) * envelope;
    }
  }
  return samples;
}
