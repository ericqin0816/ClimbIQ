import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeAudioFrameFeatures } from "./detectAudioStartSignal";

afterEach(() => vi.restoreAllMocks());

describe("audio spectral basis reuse", () => {
  it.each([
    [160, 8_000], [160, 16_000], [320, 16_000], [441, 22_050],
    [128, 8_000], [33, 44_100], [1_024, 2_000], [4_097, 8_000],
  ])("preserves direct-transform results exactly for %s samples at %s Hz", (size, rate) => {
    let seed = 0x12345678;
    const noise = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return (seed / 0xffffffff * 2 - 1) * 0.005;
    };
    // Include off-bin pitches, equal neighboring tones, noise and silence.
    // Unusual sizes/rates exercise cache invalidation and the bounded fallback.
    for (const tones of [[], [554], [1_108], [500, 550], [777.777]]) {
      const frame = Float32Array.from({ length: size }, (_, index) =>
        noise() + tones.reduce((sum, frequency) => sum + 0.2 * Math.sin(2 * Math.PI * frequency * index / rate), 0));
      const { frequency, spectralProminenceDb, spectralConcentration, spectralAmplitude } = analyzeAudioFrameFeatures(frame, rate);
      expect({ frequency, spectralProminenceDb, spectralConcentration, spectralAmplitude }).toEqual(directSpectralFeatures(frame, rate));
    }
    const silent = new Float32Array(size);
    const result = analyzeAudioFrameFeatures(silent, rate);
    expect(result.tonality).toBe(0);
    expect(result.spectralAmplitude).toBe(0);
    expect(result.frequency).toBeUndefined();
  });

  it("reuses trigonometry for repeated frames and releases the previous transform shape", () => {
    const frame = Float32Array.from({ length: 160 }, (_, index) => Math.sin(2 * Math.PI * 554 * index / 8_000));
    const other = frame.subarray(0, 128);
    analyzeAudioFrameFeatures(other, 8_000);
    const cosine = vi.spyOn(Math, "cos");
    const sine = vi.spyOn(Math, "sin");
    const first = analyzeAudioFrameFeatures(frame, 8_000);
    const coldCalls = [cosine.mock.calls.length, sine.mock.calls.length];
    expect(coldCalls.every(count => count > 0)).toBe(true);
    expect(analyzeAudioFrameFeatures(frame, 8_000)).toEqual(first);
    expect([cosine.mock.calls.length, sine.mock.calls.length]).toEqual(coldCalls);
    analyzeAudioFrameFeatures(other, 8_000);
    const changedCalls = cosine.mock.calls.length;
    expect(changedCalls).toBeGreaterThan(coldCalls[0]);
    expect(analyzeAudioFrameFeatures(frame, 8_000)).toEqual(first);
    // One retained shape, rather than an unbounded cache of every input size.
    expect(cosine.mock.calls.length).toBeGreaterThan(changedCalls);
  });
});

// Original direct DFT is an independent reference for the numerical contract:
// preserve peak selection, spectral floor, interpolation and amplitude exactly.
function directSpectralFeatures(frame: Float32Array, sampleRate: number) {
  const size = frame.length;
  const minBin = Math.max(1, Math.ceil(120 * size / sampleRate));
  const maxBin = Math.min(Math.floor(size / 2) - 1, Math.floor(2_500 * size / sampleRate));
  const empty = { frequency: undefined, spectralProminenceDb: 0, spectralConcentration: 0, spectralAmplitude: 0 };
  if (maxBin <= minBin) return empty;
  const powers = new Float64Array(maxBin + 2);
  let bestBin = minBin, bestPower = 0, windowSum = 0;
  for (let index = 0; index < size; index++) windowSum += 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, size - 1));
  for (let bin = minBin; bin <= maxBin; bin++) {
    let real = 0, imaginary = 0;
    for (let index = 0; index < size; index++) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, size - 1));
      const angle = 2 * Math.PI * bin * index / size;
      const value = frame[index] * window;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    powers[bin] = power;
    if (power > bestPower) { bestPower = power; bestBin = bin; }
  }
  if (bestPower <= 1e-10) return empty;
  const bandPowers = Array.from(powers.slice(minBin, maxBin + 1));
  const sorted = [...bandPowers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const floor = Math.max(1e-12, sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  const total = Math.max(1e-12, bandPowers.reduce((sum, power) => sum + power, 0));
  const left = powers[bestBin - 1] || bestPower, center = powers[bestBin], right = powers[bestBin + 1] || bestPower;
  const denominator = left - 2 * center + right;
  const offset = Math.abs(denominator) > 1e-12 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator)) : 0;
  return { frequency: (bestBin + offset) * sampleRate / size,
    spectralProminenceDb: Math.min(80, 10 * Math.log10(bestPower / floor)), spectralConcentration: bestPower / total,
    spectralAmplitude: 2 * Math.sqrt(bestPower) / Math.max(1e-6, windowSum) };
}
