import { waitForAudioOperation } from "./abortableAudioOperation";
import {
  analyzeAudioChannelWindow,
  estimateSpectralBand,
  extractAudioToneComponents,
  resampleMixedChannels,
  type AudioFrameFeature,
  type AudioToneSegment,
} from "./detectAudioStartSignal";

const ANALYSIS_RATE = 8_000;
const PREPARATION_HZ = 880;
const FINAL_HZ = 1_760;
const PROFILE_ERROR = 0.08;

export interface AudioStartReviewSource {
  readonly file: File;
  /** Current recording/video source token, never a filename identity. */
  readonly sourceKey: string;
  readonly sourceGeneration: number;
}

interface ReviewOwnership extends AudioStartReviewSource {
  readonly signal?: AbortSignal;
  readonly isCurrentSource: (file: File, sourceKey: string, sourceGeneration: number) => boolean;
  readonly onProgress?: (message: string) => void;
}

export interface AudioStartReviewProposal {
  readonly rawTime: number;
  readonly confidence: "Medium";
  readonly authority: "navigation-only";
  readonly automaticVoteAllowed: false;
  readonly searchHintTime: null;
  readonly profile: "secondary-880-1760";
  readonly sequence: readonly Readonly<AudioToneSegment>[];
  readonly reason: string;
  readonly supportMeaning: string;
}

export interface AudioStartReviewOutcome {
  readonly source: AudioStartReviewSource;
  readonly proposal: AudioStartReviewProposal | null;
  readonly reason: string;
}

export interface FindAudioStartReviewOptions extends ReviewOwnership {
  readonly searchStart: number;
  readonly searchEnd: number;
}

export interface AnalyzeAudioStartReviewWindowOptions extends ReviewOwnership {
  readonly channels: readonly Float32Array[];
  readonly sourceSampleRate: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly timeOffset: number;
}

type Tone = Readonly<AudioToneSegment>;
type Frame = Readonly<AudioFrameFeature>;
interface BandFrame { feature: Frame; frequency: number; prominenceDb: number; concentration: number }

/** Explicit manual action. Nothing from this API is automatic fusion evidence. */
export async function findAudioStartReview(options: FindAudioStartReviewOptions): Promise<AudioStartReviewOutcome> {
  const ownership = captureOwnership(options);
  ownership.check();
  const { searchStart, searchEnd } = options;
  if (!Number.isFinite(searchStart) || !Number.isFinite(searchEnd) || searchStart < 0 || searchEnd <= searchStart) {
    throw new Error("Choose a valid source-time window for audio review.");
  }
  const Constructor = typeof window === "undefined" ? undefined : window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return outcome(ownership.source, null, "This browser cannot decode audio for manual review.");
  let context: AudioContext | undefined;
  let closing: Promise<void> | undefined;
  const closeOwnedContext = () => closing ??= Promise.resolve().then(async () => {
    try { await context?.close(); } catch { /* Preserve the analysis/cancellation error. */ }
  });
  try {
    const bytes = await waitForAudioOperation(() => ownership.source.file.arrayBuffer(), options.signal,
      "Audio review cancelled while reading the recording.");
    ownership.check();
    try { context = new Constructor({ sampleRate: ANALYSIS_RATE }); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== "NotSupportedError") throw error;
      context = new Constructor();
    }
    options.onProgress?.("Decoding audio for a separate review suggestion…");
    ownership.check();
    const decoded = await waitForAudioOperation(() => context!.decodeAudioData(bytes), options.signal,
      "Audio review cancelled while decoding.", () => { void closeOwnedContext(); });
    ownership.check();
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const startFrame = Math.max(0, Math.floor(searchStart * decoded.sampleRate));
    const endFrame = Math.min(decoded.length, Math.ceil(searchEnd * decoded.sampleRate));
    const result = await analyzeAudioStartReviewWindow({
      ...options, ...ownership.source, channels, sourceSampleRate: decoded.sampleRate,
      startFrame, endFrame, timeOffset: searchStart,
    });
    ownership.check();
    return result;
  } finally {
    if (context) await closeOwnedContext();
    // Context cleanup can yield after the last analysis check. The result must
    // still belong to the same exact recording when the promise is published.
    ownership.check();
  }
}

/** Testable PCM seam. It reads the original channels; it never changes an
 * automatic result or returns an automatic-result replacement.
 */
export async function analyzeAudioStartReviewWindow(options: AnalyzeAudioStartReviewWindowOptions): Promise<AudioStartReviewOutcome> {
  const ownership = captureOwnership(options);
  ownership.check();
  const { channels, sourceSampleRate, startFrame, endFrame, timeOffset } = options;
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate < 2_000 ||
      !Number.isFinite(startFrame) || !Number.isFinite(endFrame) || startFrame < 0 || endFrame <= startFrame ||
      !Number.isFinite(timeOffset) || timeOffset < 0) {
    throw new Error("Audio review needs valid sample bounds and an original source clock.");
  }
  if (!channels.length || Math.min(...channels.map(channel => channel.length)) < endFrame ||
      endFrame - startFrame < sourceSampleRate) {
    return outcome(ownership.source, null, "Not enough audio is available in the selected review window.");
  }
  // This remains the original mixed/stereo policy. Its snapshot is only read
  // to protect an existing profile; it is never replaced or returned as new state.
  const automatic = await analyzeAudioChannelWindow([...channels], sourceSampleRate, startFrame, endFrame, timeOffset, options.signal);
  ownership.check();
  if (automatic.searchHintTime !== undefined && automatic.matchedPattern === "two-same-then-different" && automatic.sequence?.length === 3) {
    return outcome(ownership.source, null, "The existing automatic audio profile already supplies a cue; its result was preserved.");
  }
  await yieldForOwnership(ownership.check);
  options.onProgress?.("Finding a bounded 880/1760 Hz review suggestion…");
  ownership.check();
  const samples = resampleMixedChannels(channels, sourceSampleRate, startFrame, endFrame, ANALYSIS_RATE);
  ownership.check();
  const components = extractAudioToneComponents(samples, ANALYSIS_RATE, timeOffset);
  ownership.check();
  const preparations = components.stablePitchSegments.filter(isStrongPreparation);
  const candidates: Array<{ sequence: readonly Tone[]; score: number }> = [];
  for (let firstIndex = 0; firstIndex < preparations.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < preparations.length; secondIndex += 1) {
      ownership.check();
      const first = preparations[firstIndex], second = preparations[secondIndex];
      const gap = second.startTime - first.startTime;
      if (gap < 0.7 || gap > 1.3 || relative(first.dominantFrequencyHz!, second.dominantFrequencyHz!) > PROFILE_ERROR) continue;
      const pitch = (first.dominantFrequencyHz! + second.dominantFrequencyHz!) / 2;
      const expected = second.startTime + gap, tolerance = Math.max(0.12, gap * 0.2);
      const minimum = Math.max(pitch * 1.85, FINAL_HZ * (1 - PROFILE_ERROR));
      const maximum = Math.min(pitch * 2.15, FINAL_HZ / (1 - PROFILE_ERROR));
      const frames = components.features.filter(frame => frame.time >= expected - tolerance && frame.time <= expected + tolerance);
      for (const final of recoverFinals(samples, frames, minimum, maximum, timeOffset, components.frameSize)) {
        const sequence = [first, second, final];
        const score = secondarySequenceScore(sequence);
        if (score !== undefined) candidates.push({ sequence, score });
      }
      // A visible narrowband final can already be represented by the common
      // stable extractor. Retain it rather than requiring secondary recovery.
      for (const final of components.stablePitchSegments) {
        if (final.startTime < expected - tolerance || final.startTime > expected + tolerance) continue;
        const sequence = [first, second, final];
        const score = secondarySequenceScore(sequence);
        if (score !== undefined) candidates.push({ sequence, score });
      }
    }
  }
  candidates.sort((left, right) => left.sequence[2].startTime - right.sequence[2].startTime || right.score - left.score);
  await yieldForOwnership(ownership.check);
  const selected = candidates[0];
  if (!selected) return outcome(ownership.source, null, "No complete bounded 880/1760 Hz review pattern was found.");
  const sequence = Object.freeze(selected.sequence.map(segment => Object.freeze({ ...segment })));
  const proposal: AudioStartReviewProposal = Object.freeze({
    rawTime: sequence[2].startTime, confidence: "Medium", authority: "navigation-only",
    automaticVoteAllowed: false, searchHintTime: null, profile: "secondary-880-1760", sequence,
    reason: "A bounded 880/1760 Hz recorded-tone pattern provides a cursor for manual review. It does not establish an electronic or athlete Start.",
    supportMeaning: "Qualified overlapping feature windows are not a measured physical tone duration or an event-error bound. Short pulse suggestions can occur.",
  });
  ownership.check();
  return outcome(ownership.source, proposal, proposal.reason);
}

function recoverFinals(samples: Float32Array, frames: readonly Frame[], minimum: number, maximum: number, timeOffset: number, frameSize: number): Tone[] {
  if (maximum < minimum) return [];
  const results: Tone[] = [];
  let run: BandFrame[] = [], missing = 0;
  const finish = () => {
    if (run.length >= 4) {
      const frequencies = run.map(frame => frame.frequency), frequency = median(frequencies);
      const startTime = round(run[0].feature.time), endTime = round(run[run.length - 1].feature.time + frameSize / ANALYSIS_RATE);
      results.push({ startTime, endTime, duration: round(endTime - startTime), peakRms: Math.max(...run.map(frame => frame.feature.rms)),
        meanTonality: mean(run.map(frame => frame.feature.tonality)), dominantFrequencyHz: frequency,
        pitchStabilityCents: median(frequencies.map(value => cents(value, frequency))),
        meanSpectralProminenceDb: mean(run.map(frame => frame.prominenceDb)), meanSpectralConcentration: mean(run.map(frame => frame.concentration)), qualifiedFrames: run.length });
    }
    run = []; missing = 0;
  };
  for (const feature of frames) {
    const offset = Math.round((feature.time - timeOffset) * ANALYSIS_RATE);
    const band = offset < 0 || offset + frameSize > samples.length ? undefined :
      estimateSpectralBand(samples.subarray(offset, offset + frameSize), ANALYSIS_RATE, minimum, maximum);
    if (band?.frequency !== undefined && band.prominenceDb >= 14) {
      if (run.length && cents(band.frequency, run[0].frequency) > 120) finish();
      run.push({ feature, frequency: band.frequency, prominenceDb: band.prominenceDb, concentration: band.concentration });
      missing = 0;
    } else if (run.length && ++missing > 1) finish();
  }
  finish();
  return results;
}

function isStrongPreparation(segment: Tone): boolean {
  return segment.dominantFrequencyHz !== undefined && relative(segment.dominantFrequencyHz, PREPARATION_HZ) <= PROFILE_ERROR &&
    (segment.qualifiedFrames ?? 0) >= 6 && segment.duration >= 0.08 &&
    (segment.meanSpectralProminenceDb ?? 0) >= 18 && (segment.pitchStabilityCents ?? Infinity) <= 80;
}

function secondarySequenceScore(sequence: readonly Tone[]): number | undefined {
  const [first, second, final] = sequence;
  if (!isStrongPreparation(first) || !isStrongPreparation(second) || final.dominantFrequencyHz === undefined ||
      relative(final.dominantFrequencyHz, FINAL_HZ) > PROFILE_ERROR || (final.qualifiedFrames ?? 0) < 4 ||
      (final.meanSpectralProminenceDb ?? 0) < 14 || (final.pitchStabilityCents ?? Infinity) > 140) return undefined;
  const samePitch = relative(first.dominantFrequencyHz!, second.dominantFrequencyHz!);
  const ratio = final.dominantFrequencyHz / mean([first.dominantFrequencyHz!, second.dominantFrequencyHz!]);
  const gap1 = second.startTime - first.startTime, gap2 = final.startTime - second.startTime;
  const meanGap = mean([gap1, gap2]), spread = deviation([gap1, gap2]) / Math.max(meanGap, 1e-6);
  const durationSpread = deviation([first.duration, second.duration]) / Math.max(mean([first.duration, second.duration]), 1e-6);
  const tonality = mean(sequence.map(segment => segment.meanTonality));
  const prominence = mean(sequence.map(segment => segment.meanSpectralProminenceDb ?? 0));
  if (samePitch > PROFILE_ERROR || ratio < 1.8 || ratio > 2.2 || gap1 < 0.7 || gap1 > 1.3 || gap2 < 0.7 || gap2 > 1.3 ||
      Math.abs(gap1 - gap2) > Math.max(0.12, meanGap * 0.2) || spread > 0.2 || durationSpread > 0.65 || tonality < 0.38 || prominence < 12) return undefined;
  return tonality * 30 + Math.min(prominence, 40) * 1.5 + relative(final.dominantFrequencyHz, mean([first.dominantFrequencyHz!, second.dominantFrequencyHz!])) * 80 -
    samePitch * 100 - spread * 45 - durationSpread * 15;
}

function captureOwnership(options: ReviewOwnership) {
  if (!options.sourceKey.trim() || !Number.isSafeInteger(options.sourceGeneration) || options.sourceGeneration < 0 || typeof options.isCurrentSource !== "function") {
    throw new Error("Audio review needs an exact recording source and generation.");
  }
  const source = Object.freeze({ file: options.file, sourceKey: options.sourceKey, sourceGeneration: options.sourceGeneration });
  const isCurrent = options.isCurrentSource, signal = options.signal;
  const check = () => {
    if (signal?.aborted || !isCurrent(source.file, source.sourceKey, source.sourceGeneration)) {
      const error = new Error("Audio review cancelled because its recording or analysis context changed.");
      error.name = "AbortError"; throw error;
    }
  };
  return { source, check };
}

async function yieldForOwnership(check: () => void) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
function outcome(source: AudioStartReviewSource, proposal: AudioStartReviewProposal | null, reason: string): AudioStartReviewOutcome { return Object.freeze({ source, proposal, reason }); }
function relative(left: number, right: number) { return Math.abs(left - right) / Math.max(left, right, 1e-6); }
function cents(left: number, right: number) { return Math.abs(1_200 * Math.log2(Math.max(left, 1e-6) / Math.max(right, 1e-6))); }
function mean(values: readonly number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: readonly number[]) { const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function deviation(values: readonly number[]) { const average = mean(values); return Math.sqrt(mean(values.map(value => (value - average) ** 2))); }
function round(value: number) { return Math.round(value * 1_000) / 1_000; }
