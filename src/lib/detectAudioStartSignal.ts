import type { Confidence } from "../types";

const TARGET_SAMPLE_RATE = 8_000;
const FRAME_SECONDS = 0.02;
const HOP_SECONDS = 0.01;

export interface AudioToneSegment {
  startTime: number;
  endTime: number;
  duration: number;
  peakRms: number;
  meanTonality: number;
  dominantFrequencyHz?: number;
}

export interface AudioStartResult {
  found: boolean;
  rawTime?: number;
  confidence: Confidence;
  reason: string;
  sequence?: AudioToneSegment[];
  segments: AudioToneSegment[];
}

interface DetectAudioStartOptions {
  file: File;
  searchStart: number;
  searchEnd: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export async function detectAudioStartSignal({
  file,
  searchStart,
  searchEnd,
  signal,
  onProgress,
}: DetectAudioStartOptions): Promise<AudioStartResult> {
  checkCancelled(signal);
  const AudioContextConstructor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!AudioContextConstructor) {
    return emptyAudioResult("This browser cannot decode the video's audio track.");
  }

  onProgress?.("Decoding the local audio track…");
  const bytes = await file.arrayBuffer();
  checkCancelled(signal);
  const context = new AudioContextConstructor();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    checkCancelled(signal);
    if (!decoded.numberOfChannels || !decoded.length) {
      return emptyAudioResult("The uploaded video has no usable audio samples.");
    }
    const startFrame = Math.max(0, Math.floor(searchStart * decoded.sampleRate));
    const endFrame = Math.min(decoded.length, Math.ceil(searchEnd * decoded.sampleRate));
    if (endFrame - startFrame < decoded.sampleRate) {
      return emptyAudioResult("The audio search window is too short for a countdown sequence.");
    }
    onProgress?.("Listening for the repeated countdown beeps…");
    const mono = mixAndResample(decoded, startFrame, endFrame, TARGET_SAMPLE_RATE);
    return analyzeBeepSequence(mono, TARGET_SAMPLE_RATE, searchStart);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return emptyAudioResult(
      error instanceof Error
        ? `The audio track could not be analyzed: ${error.message}`
        : "The audio track could not be analyzed.",
    );
  } finally {
    void context.close().catch(() => undefined);
  }
}

export function analyzeBeepSequence(
  samples: Float32Array,
  sampleRate: number,
  timeOffset = 0,
): AudioStartResult {
  if (sampleRate < 2_000 || samples.length < sampleRate) {
    return emptyAudioResult("Not enough audio was available for countdown detection.");
  }

  const frameSize = Math.max(32, Math.round(sampleRate * FRAME_SECONDS));
  const hopSize = Math.max(16, Math.round(sampleRate * HOP_SECONDS));
  const features: Array<{ time: number; rms: number; tonality: number; frequency?: number }> = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += hopSize) {
    const frame = samples.subarray(offset, offset + frameSize);
    const rms = rootMeanSquare(frame);
    const tone = estimateTonality(frame, sampleRate);
    features.push({
      time: timeOffset + offset / sampleRate,
      rms,
      tonality: tone.tonality,
      frequency: tone.frequency,
    });
  }
  if (features.length < 20) {
    return emptyAudioResult("Not enough audio frames were available.");
  }

  const rmsValues = features.map((feature) => feature.rms);
  const baseline = median(rmsValues);
  const deviation = median(rmsValues.map((value) => Math.abs(value - baseline)));
  const peak = Math.max(...rmsValues);
  const threshold = Math.max(baseline * 2.2, baseline + deviation * 4, peak * 0.12, 0.006);
  const segments = buildToneSegments(features, threshold, HOP_SECONDS)
    .filter((segment) => segment.duration >= 0.04 && segment.duration <= 1.4)
    .filter((segment) => segment.meanTonality >= 0.28);
  if (!segments.length) {
    return {
      ...emptyAudioResult("No tonal beeps stood out from the background audio."),
      segments,
    };
  }

  const best = segments.length >= 3 ? findCountdownSequence(segments) : undefined;
  if (best) {
    const finalBeep = best.sequence[best.sequence.length - 1];
    const confidence: Confidence = best.sequence.length >= 4 && best.regularity >= 0.78
      ? "High"
      : "Medium";
    return {
      found: true,
      rawTime: roundMetric(finalBeep.startTime),
      confidence,
      reason: `Detected ${best.sequence.length} repeated tonal beeps; the final beep is the audio start cue.`,
      sequence: best.sequence,
      segments,
    };
  }

  const standout = findProminentSingleBeep(segments, threshold);
  if (standout) {
    return {
      found: true,
      rawTime: roundMetric(standout.startTime),
      confidence: "Medium",
      reason: "No repeated countdown pattern was found, but one loud tonal beep clearly stood out; it is treated as the start beep.",
      sequence: [standout],
      segments,
    };
  }

  return {
    ...emptyAudioResult(
      segments.length >= 3
        ? "Tonal sounds were present, but they did not form a regular countdown and no single beep stood out."
        : "No repeated tonal countdown sequence was found.",
    ),
    segments,
  };
}

function findCountdownSequence(
  segments: AudioToneSegment[],
): { sequence: AudioToneSegment[]; score: number; regularity: number } | undefined {
  const sequences: Array<{ sequence: AudioToneSegment[]; score: number; regularity: number }> = [];
  for (let length = 5; length >= 3; length -= 1) {
    for (let end = length; end <= segments.length; end += 1) {
      const sequence = segments.slice(end - length, end);
      const intervals = sequence.slice(1).map((segment, index) => segment.startTime - sequence[index].startTime);
      const meanInterval = average(intervals);
      if (meanInterval < 0.14 || meanInterval > 1.6) {
        continue;
      }
      const intervalSpread = standardDeviation(intervals) / Math.max(meanInterval, 1e-6);
      if (intervalSpread > 0.34) {
        continue;
      }
      // The final beep is routinely longer and louder than the countdown beeps,
      // so duration regularity is judged on the earlier beeps only.
      const coreDurations = sequence.slice(0, -1).map((segment) => segment.duration);
      const durationSpread = standardDeviation(coreDurations) / Math.max(average(coreDurations), 1e-6);
      const meanTonality = average(sequence.map((segment) => segment.meanTonality));
      if (durationSpread > 0.65 || meanTonality < 0.34) {
        continue;
      }
      const finalBeep = sequence[sequence.length - 1];
      const earlierLoudness = average(sequence.slice(0, -1).map((segment) => segment.peakRms));
      const finalLoudnessRatio = finalBeep.peakRms / Math.max(earlierLoudness, 1e-6);
      const score = length * 30 + meanTonality * 35 - intervalSpread * 45 - durationSpread * 15 +
        Math.min(20, average(sequence.map((segment) => segment.peakRms)) * 120) +
        Math.min(12, finalLoudnessRatio * 4);
      sequences.push({ sequence, score, regularity: 1 - intervalSpread });
    }
  }
  return sequences.sort((left, right) => right.score - left.score)[0];
}

/**
 * Start systems always end on one loud beep. When no repeated countdown pattern
 * is present, a single tonal burst that is clearly louder than everything else
 * in the window is still a usable start cue.
 */
function findProminentSingleBeep(segments: AudioToneSegment[], threshold: number): AudioToneSegment | undefined {
  const candidates = segments.filter((segment) =>
    segment.duration >= 0.05 && segment.duration <= 1.4 &&
    segment.meanTonality >= 0.42 && segment.peakRms >= threshold * 1.3,
  );
  if (!candidates.length) {
    return undefined;
  }
  const loudest = candidates.reduce((best, segment) => (segment.peakRms > best.peakRms ? segment : best));
  const nextLoudest = segments
    .filter((segment) => segment !== loudest)
    .reduce((max, segment) => Math.max(max, segment.peakRms), 0);
  return nextLoudest === 0 || loudest.peakRms >= nextLoudest * 1.8 ? loudest : undefined;
}

function mixAndResample(
  decoded: AudioBuffer,
  startFrame: number,
  endFrame: number,
  targetRate: number,
): Float32Array {
  const sourceRate = decoded.sampleRate;
  const sourceLength = endFrame - startFrame;
  const outputLength = Math.max(1, Math.floor(sourceLength * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceIndex = Math.min(endFrame - 1, startFrame + Math.floor(outputIndex * sourceRate / targetRate));
    let sample = 0;
    for (const channel of channels) {
      sample += channel[sourceIndex] ?? 0;
    }
    output[outputIndex] = sample / channels.length;
  }
  return output;
}

function buildToneSegments(
  features: Array<{ time: number; rms: number; tonality: number; frequency?: number }>,
  threshold: number,
  hopSeconds: number,
): AudioToneSegment[] {
  const segments: AudioToneSegment[] = [];
  let start = -1;
  let lastActive = -1;
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const active = feature.rms >= threshold && feature.tonality >= 0.22;
    if (active) {
      if (start < 0) {
        start = index;
      }
      lastActive = index;
    }
    const gapFrames = lastActive >= 0 ? index - lastActive : 0;
    if (start >= 0 && (!active && gapFrames > 5 || index === features.length - 1)) {
      const end = lastActive;
      const slice = features.slice(start, end + 1);
      const frequencies = slice.map((item) => item.frequency).filter((value): value is number => value !== undefined);
      segments.push({
        startTime: roundMetric(features[start].time),
        endTime: roundMetric(features[end].time + FRAME_SECONDS),
        duration: roundMetric(features[end].time + FRAME_SECONDS - features[start].time),
        peakRms: Math.max(...slice.map((item) => item.rms)),
        meanTonality: average(slice.map((item) => item.tonality)),
        dominantFrequencyHz: frequencies.length ? average(frequencies) : undefined,
      });
      start = -1;
      lastActive = -1;
    }
  }
  return mergeNearbySegments(segments, hopSeconds * 8);
}

function mergeNearbySegments(segments: AudioToneSegment[], maxGap: number): AudioToneSegment[] {
  const merged: AudioToneSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && segment.startTime - previous.endTime <= maxGap) {
      const previousDuration = previous.duration;
      const totalDuration = previousDuration + segment.duration;
      previous.meanTonality = (previous.meanTonality * previousDuration + segment.meanTonality * segment.duration) /
        Math.max(totalDuration, 1e-6);
      previous.endTime = segment.endTime;
      previous.duration = roundMetric(previous.endTime - previous.startTime);
      previous.peakRms = Math.max(previous.peakRms, segment.peakRms);
      previous.dominantFrequencyHz = previous.dominantFrequencyHz && segment.dominantFrequencyHz
        ? (previous.dominantFrequencyHz + segment.dominantFrequencyHz) / 2
        : previous.dominantFrequencyHz ?? segment.dominantFrequencyHz;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function estimateTonality(frame: Float32Array, sampleRate: number): { tonality: number; frequency?: number } {
  let energy = 0;
  for (const sample of frame) {
    energy += sample * sample;
  }
  if (energy < 1e-10) {
    return { tonality: 0 };
  }
  let bestCorrelation = 0;
  let bestLag = 0;
  const minLag = Math.max(2, Math.floor(sampleRate / 2_500));
  const maxLag = Math.min(frame.length - 2, Math.ceil(sampleRate / 90));
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < frame.length - lag; index += 1) {
      const left = frame[index];
      const right = frame[index + lag];
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const normalized = correlation / Math.sqrt(Math.max(1e-12, leftEnergy * rightEnergy));
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }
  return {
    tonality: Math.max(0, Math.min(1, bestCorrelation)),
    frequency: bestLag ? sampleRate / bestLag : undefined,
  };
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[]): number {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Audio start detection cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function emptyAudioResult(reason: string): AudioStartResult {
  return { found: false, confidence: "None", reason, segments: [] };
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
