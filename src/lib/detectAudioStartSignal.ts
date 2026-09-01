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
  pitchStabilityCents?: number;
  meanSpectralProminenceDb?: number;
  meanSpectralConcentration?: number;
  qualifiedFrames?: number;
}

interface AudioFrameFeature {
  time: number;
  rms: number;
  tonality: number;
  frequency?: number;
  spectralProminenceDb: number;
  spectralConcentration: number;
  spectralAmplitude: number;
}

export interface AudioStartResult {
  found: boolean;
  rawTime?: number;
  confidence: Confidence;
  reason: string;
  matchedPattern?: "two-same-then-different" | "regular-countdown" | "single-prominent-beep";
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
    const decoded = await context.decodeAudioData(bytes);
    checkCancelled(signal);
    if (!decoded.numberOfChannels || !decoded.length) {
      return emptyAudioResult("The uploaded video has no usable audio samples.");
    }
    const startFrame = Math.max(0, Math.floor(searchStart * decoded.sampleRate));
    const endFrame = Math.min(decoded.length, Math.ceil(searchEnd * decoded.sampleRate));
    if (endFrame - startFrame < decoded.sampleRate) {
      return emptyAudioResult("The audio search window is too short for a countdown sequence.");
    }
    onProgress?.("Listening for two matching beeps and the different-pitch start beep…");
    const mono = resampleMixedChannels(
      Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index)),
      decoded.sampleRate,
      startFrame,
      endFrame,
      TARGET_SAMPLE_RATE,
    );
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
  const features: AudioFrameFeature[] = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += hopSize) {
    const frame = samples.subarray(offset, offset + frameSize);
    const rms = rootMeanSquare(frame);
    const tone = estimateTonality(frame, sampleRate);
    features.push({
      time: timeOffset + offset / sampleRate,
      rms,
      tonality: tone.tonality,
      frequency: tone.frequency,
      spectralProminenceDb: tone.spectralProminenceDb,
      spectralConcentration: tone.spectralConcentration,
      spectralAmplitude: tone.spectralAmplitude,
    });
  }
  if (features.length < 20) {
    return emptyAudioResult("Not enough audio frames were available.");
  }

  const rmsValues = features.map((feature) => feature.rms);
  const baseline = median(rmsValues);
  const deviation = median(rmsValues.map((value) => Math.abs(value - baseline)));
  // A loud spoken "ready" must not raise the threshold enough to hide quieter
  // beeps, so use robust background statistics rather than a fraction of peak.
  const threshold = Math.max(baseline * 1.8, baseline + deviation * 4, 0.004);
  const onsetFloor = Math.max(baseline + deviation * 1.5, threshold * 0.2, 0.002);
  const segments = buildToneSegments(features, threshold, onsetFloor, HOP_SECONDS)
    .filter((segment) => segment.duration >= 0.04 && segment.duration <= 1.4)
    .filter((segment) =>
      segment.meanTonality >= 0.28 || (segment.meanSpectralProminenceDb ?? 0) >= 14,
    );
  if (!segments.length) {
    return {
      ...emptyAudioResult("No tonal beeps stood out from the background audio."),
      segments,
    };
  }

  // A countdown beep can overlap speech, music, or another sustained tone. In
  // that case the broad activity segment's median pitch no longer represents
  // the beep (the 12.24 reference clip contains exactly this failure mode).
  // Recover only dense, pitch-stable sub-runs and use them for the strict
  // protocol matcher; generic countdown fallbacks still use the broad segments.
  const stablePitchSegments = extractPitchStableSubsegments(features, segments, HOP_SECONDS);
  const targetedOctaveSegments = extractTargetedOctaveFinalSegments(
    samples,
    sampleRate,
    timeOffset,
    features,
    stablePitchSegments,
  );
  const broadPitchSegments = segments.filter((segment) =>
    !stablePitchSegments.some((stable) =>
      toneCandidatesOverlap(segment, stable, 120) &&
      stable.startTime - segment.startTime > HOP_SECONDS * 2.1,
    ),
  );
  const pitchCandidates = [...broadPitchSegments, ...stablePitchSegments, ...targetedOctaveSegments]
    .sort((left, right) => left.startTime - right.startTime);
  const pitchCoded = pitchCandidates.length >= 3
    ? findPitchCodedStartSequence(pitchCandidates)
    : undefined;
  if (pitchCoded) {
    const finalBeep = pitchCoded.sequence[pitchCoded.sequence.length - 1];
    const confidence: Confidence = pitchCoded.samePitchError <= 0.08 &&
        pitchCoded.finalPitchDifference >= 0.18 &&
        isOfficialStartProtocol(pitchCoded.sequence, pitchCoded.finalPitchRatio) &&
        pitchCoded.regularity >= 0.72
      ? "High"
      : "Medium";
    return {
      found: true,
      rawTime: roundMetric(finalBeep.startTime),
      confidence,
      reason: `Detected ${pitchCoded.sequence.length - 1} matching-pitch countdown beeps followed by the different-pitch start beep.`,
      matchedPattern: "two-same-then-different",
      sequence: pitchCoded.sequence,
      segments,
    };
  }

  const best = segments.length >= 3 ? findCountdownSequence(segments) : undefined;
  if (best) {
    const finalBeep = best.sequence[best.sequence.length - 1];
    return {
      found: true,
      rawTime: roundMetric(finalBeep.startTime),
      confidence: "Low",
      reason: `Detected ${best.sequence.length} regularly spaced tones, but they did not match the two-same-pitch then different-pitch start signature. Review the suggested final tone.`,
      matchedPattern: "regular-countdown",
      sequence: best.sequence,
      segments,
    };
  }

  const standout = findProminentSingleBeep(segments, threshold);
  if (standout) {
    return {
      found: true,
      rawTime: roundMetric(standout.startTime),
      confidence: "Low",
      reason: "One tonal beep stood out, but the complete two-same-pitch then different-pitch start signature was not found. Review this suggestion.",
      matchedPattern: "single-prominent-beep",
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

/**
 * Official start audio: at least two same-pitch countdown beeps followed by a
 * distinctly different-pitch start beep. Spoken "ready" is naturally excluded
 * because it does not satisfy the stable-pitch and interval constraints.
 */
function findPitchCodedStartSequence(
  segments: AudioToneSegment[],
): {
  sequence: AudioToneSegment[];
  score: number;
  regularity: number;
  samePitchError: number;
  finalPitchDifference: number;
  finalPitchRatio: number;
} | undefined {
  const matches: Array<{
    sequence: AudioToneSegment[];
    score: number;
    regularity: number;
    samePitchError: number;
    finalPitchDifference: number;
    finalPitchRatio: number;
  }> = [];
  for (let firstIndex = 0; firstIndex < segments.length - 2; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length - 1; secondIndex += 1) {
      const firstGap = segments[secondIndex].startTime - segments[firstIndex].startTime;
      if (firstGap < 0.25 || firstGap > 1.5) {
        continue;
      }
      for (let finalIndex = secondIndex + 1; finalIndex < segments.length; finalIndex += 1) {
        const secondGap = segments[finalIndex].startTime - segments[secondIndex].startTime;
        if (secondGap < 0.25 || secondGap > 1.5) {
          continue;
        }
        const meanGap = (firstGap + secondGap) / 2;
        if (Math.abs(firstGap - secondGap) > Math.max(0.12, meanGap * 0.2)) {
          continue;
        }
        const sequence = [segments[firstIndex], segments[secondIndex], segments[finalIndex]];
    const frequencies = sequence.map((segment) => segment.dominantFrequencyHz);
    if (frequencies.some((frequency) => !frequency || !Number.isFinite(frequency))) {
      continue;
    }
    if (sequence.some((segment) => (segment.pitchStabilityCents ?? Infinity) > 140)) {
      continue;
    }
    if (sequence.some((segment) => (segment.qualifiedFrames ?? 0) < 4)) {
      continue;
    }
    const countdownFrequencies = frequencies.slice(0, -1) as number[];
    const finalFrequency = frequencies[frequencies.length - 1]!;
    const countdownPitch = median(countdownFrequencies);
    // The two countdown tones are the same pitch. Comparing each one with their
    // midpoint halves their apparent disagreement and let the unrelated
    // 572/492 Hz pair near the end of 12.42 masquerade as a match. Use the
    // pairwise difference directly.
    const samePitchError = Math.max(
      ...countdownFrequencies.slice(1).map((frequency, index) =>
        relativeFrequencyDifference(frequency, countdownFrequencies[index]),
      ),
    );
    const finalPitchDifference = relativeFrequencyDifference(finalFrequency, countdownPitch);
    const finalPitchRatio = finalFrequency / Math.max(countdownPitch, 1e-6);
    if (samePitchError > 0.12 || finalPitchDifference < 0.13) {
      continue;
    }

    const intervals = [firstGap, secondGap];
    const meanInterval = meanGap;
    const intervalSpread = standardDeviation(intervals) / Math.max(meanInterval, 1e-6);
    const regularity = Math.max(0, 1 - intervalSpread);
    if (intervalSpread > 0.2) {
      continue;
    }
    const countdownDurations = sequence.slice(0, -1).map((segment) => segment.duration);
    const durationSpread = standardDeviation(countdownDurations) /
      Math.max(average(countdownDurations), 1e-6);
    const meanTonality = average(sequence.map((segment) => segment.meanTonality));
    const meanProminence = average(sequence.map((segment) => segment.meanSpectralProminenceDb ?? 0));
    if (durationSpread > 0.65 || meanTonality < 0.38 || meanProminence < 12) {
      continue;
    }
    const score = meanTonality * 30 + Math.min(meanProminence, 40) * 1.5 + finalPitchDifference * 80 -
      samePitchError * 100 - intervalSpread * 45 - durationSpread * 15;
    matches.push({ sequence, score, regularity, samePitchError, finalPitchDifference, finalPitchRatio });
      }
    }
  }
  // The official cue is an approximately octave-up final beep. Prefer the
  // earliest such complete protocol: later crowd/music tones can be cleaner and
  // louder, but they cannot retroactively become the race start. Other pitch
  // changes remain available as Medium-confidence review evidence.
  const officialMatches = matches.filter((match) =>
    isOfficialStartProtocol(match.sequence, match.finalPitchRatio),
  );
  return officialMatches.sort((left, right) =>
    left.sequence[2].startTime - right.sequence[2].startTime || right.score - left.score,
  )[0] ?? matches.sort((left, right) => right.score - left.score)[0];
}

function isOfficialStartProtocol(sequence: AudioToneSegment[], finalPitchRatio: number): boolean {
  const countdownPitch = median(sequence.slice(0, 2).map((segment) => segment.dominantFrequencyHz ?? 0));
  const firstGap = sequence[1].startTime - sequence[0].startTime;
  const secondGap = sequence[2].startTime - sequence[1].startTime;
  return finalPitchRatio >= 1.8 && finalPitchRatio <= 2.2 &&
    relativeFrequencyDifference(
      sequence[0].dominantFrequencyHz ?? 0,
      sequence[1].dominantFrequencyHz ?? 0,
    ) <= 0.08 &&
    countdownPitch >= 480 && countdownPitch <= 650 &&
    firstGap >= 0.7 && firstGap <= 1.3 &&
    secondGap >= 0.7 && secondGap <= 1.3;
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
 * A lone tonal burst is retained only as a Low-confidence review suggestion when
 * the complete pitch-coded start signature is unavailable.
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

/**
 * Mixes decoded channels and resamples them with a low-pass windowed-sinc
 * filter. A nearest-neighbour downsample aliases high-frequency gym noise into
 * the 550/1100 Hz start-beep bands (12.42.mov exposed this in the browser even
 * though the same detector worked on ffmpeg-decoded 8 kHz audio).
 *
 * Keep this pure/exported so the exact browser preprocessing path can be
 * regression-tested without constructing an AudioBuffer.
 */
export function resampleMixedChannels(
  channels: readonly Float32Array[],
  sourceRate: number,
  startFrame: number,
  endFrame: number,
  targetRate: number,
): Float32Array {
  if (!channels.length || sourceRate <= 0 || targetRate <= 0) {
    return new Float32Array();
  }
  const availableLength = Math.min(...channels.map((channel) => channel.length));
  const boundedStart = Math.max(0, Math.min(availableLength, Math.floor(startFrame)));
  const boundedEnd = Math.max(boundedStart, Math.min(availableLength, Math.ceil(endFrame)));
  const sourceLength = boundedEnd - boundedStart;
  if (!sourceLength) {
    return new Float32Array();
  }
  const outputLength = Math.max(1, Math.floor(sourceLength * targetRate / sourceRate));
  const output = new Float32Array(outputLength);

  // Direct mixing avoids needlessly filtering the uncommon already-8 kHz path.
  if (sourceRate === targetRate) {
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      let mixed = 0;
      for (const channel of channels) {
        mixed += channel[boundedStart + outputIndex] ?? 0;
      }
      output[outputIndex] = mixed / channels.length;
    }
    return output;
  }

  const sourcePerOutput = sourceRate / targetRate;
  const halfTaps = 32;
  // 90% of the lower Nyquist frequency leaves a transition band before the
  // target Nyquist limit. This is what prevents ultrasonic/high-pitched sound
  // from folding into the official beep frequencies during downsampling.
  const cutoff = Math.min(0.45, 0.45 * targetRate / sourceRate);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const position = boundedStart + (outputIndex + 0.5) * sourcePerOutput - 0.5;
    const center = Math.floor(position);
    let weightedSample = 0;
    let weightSum = 0;
    for (let sourceIndex = center - halfTaps + 1; sourceIndex <= center + halfTaps; sourceIndex += 1) {
      if (sourceIndex < boundedStart || sourceIndex >= boundedEnd) {
        continue;
      }
      const distance = sourceIndex - position;
      const scaledDistance = 2 * cutoff * distance;
      const sinc = Math.abs(scaledDistance) < 1e-12
        ? 1
        : Math.sin(Math.PI * scaledDistance) / (Math.PI * scaledDistance);
      const windowPosition = (distance + halfTaps) / (2 * halfTaps);
      const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * windowPosition) +
        0.08 * Math.cos(4 * Math.PI * windowPosition);
      const weight = 2 * cutoff * sinc * blackman;
      let mixed = 0;
      for (const channel of channels) {
        mixed += channel[sourceIndex] ?? 0;
      }
      weightedSample += mixed / channels.length * weight;
      weightSum += weight;
    }
    output[outputIndex] = Math.abs(weightSum) > 1e-12 ? weightedSample / weightSum : 0;
  }
  return output;
}

function buildToneSegments(
  features: AudioFrameFeature[],
  threshold: number,
  onsetFloor: number,
  hopSeconds: number,
): AudioToneSegment[] {
  const segments: AudioToneSegment[] = [];
  let start = -1;
  let lastActive = -1;
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const frequencyInProtocolRange = feature.frequency !== undefined &&
      feature.frequency >= 300 && feature.frequency <= 2_200;
    const narrowbandProtocolTone = frequencyInProtocolRange &&
      feature.spectralProminenceDb >= 14 &&
      feature.spectralConcentration >= 0.14 &&
      feature.tonality >= 0.4;
    const active = narrowbandProtocolTone ||
      (feature.rms >= threshold && feature.tonality >= 0.28 && feature.spectralProminenceDb >= 6);
    if (active) {
      if (start < 0) {
        start = index;
      }
      lastActive = index;
    }
    const gapFrames = lastActive >= 0 ? index - lastActive : 0;
    if (start >= 0 && (!active && gapFrames > 2 || index === features.length - 1)) {
      const end = lastActive;
      const coreSlice = features.slice(start, end + 1);
      const frequencies = coreSlice.map((item) => item.frequency).filter((value): value is number => value !== undefined);
      const dominantFrequencyHz = frequencies.length ? median(frequencies) : undefined;
      // Tonality needs a few cycles to become obvious, so the hard threshold can
      // lag a fading-in beep. Walk back through continuous low-level energy for at
      // most 80 ms. A quiet cue may be below ambient RMS, so same-frequency spectral
      // lead-in also counts. The cap prevents preceding speech from being joined.
      let onsetStart = start;
      const maxBacktrackFrames = Math.max(1, Math.round(0.08 / hopSeconds));
      while (onsetStart > 0 && start - onsetStart < maxBacktrackFrames) {
        const previous = features[onsetStart - 1];
        const spectralLeadIn = dominantFrequencyHz !== undefined && previous.frequency !== undefined &&
          centsDifference(previous.frequency, dominantFrequencyHz) <= 180 &&
          previous.spectralProminenceDb >= 6;
        if (previous.rms < onsetFloor && !spectralLeadIn) {
          break;
        }
        onsetStart -= 1;
      }
      const fullSlice = features.slice(onsetStart, end + 1);
      segments.push({
        startTime: roundMetric(features[onsetStart].time),
        endTime: roundMetric(features[end].time + FRAME_SECONDS),
        duration: roundMetric(features[end].time + FRAME_SECONDS - features[onsetStart].time),
        peakRms: Math.max(...fullSlice.map((item) => item.rms)),
        meanTonality: average(coreSlice.map((item) => item.tonality)),
        dominantFrequencyHz,
        pitchStabilityCents: dominantFrequencyHz
          ? median(frequencies.map((frequency) => centsDifference(frequency, dominantFrequencyHz)))
          : undefined,
        meanSpectralProminenceDb: average(coreSlice.map((item) => item.spectralProminenceDb)),
        meanSpectralConcentration: average(coreSlice.map((item) => item.spectralConcentration)),
        qualifiedFrames: coreSlice.filter((item) =>
          item.frequency !== undefined && item.frequency >= 300 && item.frequency <= 2_200 &&
          item.spectralProminenceDb >= 14 && item.spectralConcentration >= 0.14 && item.tonality >= 0.4,
        ).length,
      });
      start = -1;
      lastActive = -1;
    }
  }
  return mergeNearbySegments(segments, hopSeconds * 8);
}

/**
 * Extract a protocol-tone track from inside a longer/noisy activity segment.
 *
 * Each candidate is tied to a narrow pitch band and must contain at least four
 * already-qualified narrowband frames. Up to 20 ms of interference is allowed,
 * but unrelated stable sounds form their own candidates. This lets an audible
 * beep survive overlap without relaxing any of the speech-rejection gates used
 * by the final two-same-then-different matcher.
 */
function extractPitchStableSubsegments(
  features: AudioFrameFeature[],
  parentSegments: AudioToneSegment[],
  hopSeconds: number,
): AudioToneSegment[] {
  const candidates: AudioToneSegment[] = [];
  const maxMissingFrames = 2;
  const pitchToleranceCents = 120;

  for (const parent of parentSegments) {
    const parentFrames = features.filter((feature) =>
      feature.time >= parent.startTime - hopSeconds &&
      feature.time <= parent.endTime,
    );
    const seedFrequencies = parentFrames
      .filter(isQualifiedProtocolFrame)
      .map((feature) => feature.frequency!);

    for (const seedFrequency of seedFrequencies) {
      let matchingFrames: AudioFrameFeature[] = [];
      let runStartIndex = -1;
      let lastMatchIndex = -1;

      const finishRun = (): void => {
        if (matchingFrames.length >= 4 && runStartIndex >= 0 && lastMatchIndex >= runStartIndex) {
          const frequencies = matchingFrames.map((feature) => feature.frequency!);
          const dominantFrequencyHz = median(frequencies);
          const firstMatch = matchingFrames[0];
          const lastMatch = matchingFrames[matchingFrames.length - 1];
          // Consecutive 20 ms frames overlap by 10 ms. Move back one hop to
          // estimate the acoustic onset hidden in the preceding mixed frame.
          const startTime = Math.max(parent.startTime, firstMatch.time - hopSeconds);
          const endTime = lastMatch.time + FRAME_SECONDS;
          const spanFrames = parentFrames.slice(runStartIndex, lastMatchIndex + 1);
          const duration = endTime - startTime;
          if (duration >= 0.04 && duration <= 1.4) {
            candidates.push({
              startTime: roundMetric(startTime),
              endTime: roundMetric(endTime),
              duration: roundMetric(duration),
              peakRms: Math.max(...spanFrames.map((feature) => feature.rms)),
              meanTonality: average(matchingFrames.map((feature) => feature.tonality)),
              dominantFrequencyHz,
              pitchStabilityCents: median(frequencies.map((frequency) =>
                centsDifference(frequency, dominantFrequencyHz),
              )),
              meanSpectralProminenceDb: average(matchingFrames.map((feature) =>
                feature.spectralProminenceDb,
              )),
              meanSpectralConcentration: average(matchingFrames.map((feature) =>
                feature.spectralConcentration,
              )),
              qualifiedFrames: matchingFrames.length,
            });
          }
        }
        matchingFrames = [];
        runStartIndex = -1;
        lastMatchIndex = -1;
      };

      for (let index = 0; index < parentFrames.length; index += 1) {
        const feature = parentFrames[index];
        const matchesPitch = isQualifiedProtocolFrame(feature) &&
          centsDifference(feature.frequency!, seedFrequency) <= pitchToleranceCents;
        if (matchesPitch) {
          if (runStartIndex < 0) {
            runStartIndex = index;
          }
          matchingFrames.push(feature);
          lastMatchIndex = index;
        } else if (runStartIndex >= 0 && index - lastMatchIndex > maxMissingFrames) {
          finishRun();
        }
      }
      finishRun();
    }
  }

  // Every frame in a beep is also tried as a seed. Collapse those overlapping
  // views to the strongest representation of each physical tone.
  const strongestFirst = candidates.sort((left, right) =>
    pitchSubsegmentQuality(right) - pitchSubsegmentQuality(left),
  );
  const unique: AudioToneSegment[] = [];
  for (const candidate of strongestFirst) {
    const duplicate = unique.some((kept) => {
      if (!kept.dominantFrequencyHz || !candidate.dominantFrequencyHz ||
          centsDifference(kept.dominantFrequencyHz, candidate.dominantFrequencyHz) > pitchToleranceCents) {
        return false;
      }
      const overlap = Math.max(0, Math.min(kept.endTime, candidate.endTime) -
        Math.max(kept.startTime, candidate.startTime));
      return overlap / Math.max(0.001, Math.min(kept.duration, candidate.duration)) >= 0.6;
    });
    if (!duplicate) {
      unique.push(candidate);
    }
  }
  return unique.sort((left, right) => left.startTime - right.startTime);
}

/**
 * Recover a quiet octave-up final beep even when speech is the frame's dominant
 * spectral peak. A strong, stable matching pair establishes both the expected
 * pitch and the expected final-beep time, so this secondary-band search remains
 * much narrower than general tone detection.
 */
function extractTargetedOctaveFinalSegments(
  samples: Float32Array,
  sampleRate: number,
  timeOffset: number,
  features: AudioFrameFeature[],
  stablePitchSegments: AudioToneSegment[],
): AudioToneSegment[] {
  const countdownTones = stablePitchSegments.filter((segment) =>
    segment.dominantFrequencyHz !== undefined &&
    segment.dominantFrequencyHz >= 450 && segment.dominantFrequencyHz <= 700 &&
    (segment.pitchStabilityCents ?? Infinity) <= 80 &&
    (segment.qualifiedFrames ?? 0) >= 6 &&
    segment.duration >= 0.08 &&
    (segment.meanSpectralProminenceDb ?? 0) >= 18,
  );
  const candidates: AudioToneSegment[] = [];

  for (let firstIndex = 0; firstIndex < countdownTones.length - 1; firstIndex += 1) {
    const first = countdownTones[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < countdownTones.length; secondIndex += 1) {
      const second = countdownTones[secondIndex];
      const gap = second.startTime - first.startTime;
      if (gap < 0.25 || gap > 1.5 ||
          relativeFrequencyDifference(first.dominantFrequencyHz!, second.dominantFrequencyHz!) > 0.08) {
        continue;
      }
      const countdownPitch = (first.dominantFrequencyHz! + second.dominantFrequencyHz!) / 2;
      const expectedFinalTime = second.startTime + gap;
      const timingTolerance = Math.max(0.12, gap * 0.2);
      const searchStart = expectedFinalTime - timingTolerance;
      const searchEnd = expectedFinalTime + timingTolerance;
      const searchFrames = features.filter((feature) =>
        feature.time >= searchStart && feature.time <= searchEnd,
      );
      let run: Array<{
        feature: AudioFrameFeature;
        frequency: number;
        prominenceDb: number;
        concentration: number;
      }> = [];

      const finishRun = (): void => {
        if (run.length >= 4) {
          const frequencies = run.map((item) => item.frequency);
          const dominantFrequencyHz = median(frequencies);
          const startTime = run[0].feature.time;
          const endTime = run[run.length - 1].feature.time + FRAME_SECONDS;
          candidates.push({
            startTime: roundMetric(startTime),
            endTime: roundMetric(endTime),
            duration: roundMetric(endTime - startTime),
            peakRms: Math.max(...run.map((item) => item.feature.rms)),
            meanTonality: average(run.map((item) => item.feature.tonality)),
            dominantFrequencyHz,
            pitchStabilityCents: median(frequencies.map((frequency) =>
              centsDifference(frequency, dominantFrequencyHz),
            )),
            meanSpectralProminenceDb: average(run.map((item) => item.prominenceDb)),
            meanSpectralConcentration: average(run.map((item) => item.concentration)),
            qualifiedFrames: run.length,
          });
        }
        run = [];
      };

      for (const feature of searchFrames) {
        const sampleOffset = Math.round((feature.time - timeOffset) * sampleRate);
        if (sampleOffset < 0 || sampleOffset + Math.round(sampleRate * FRAME_SECONDS) > samples.length) {
          finishRun();
          continue;
        }
        const frame = samples.subarray(sampleOffset, sampleOffset + Math.round(sampleRate * FRAME_SECONDS));
        const band = estimateSpectralBand(
          frame,
          sampleRate,
          countdownPitch * 1.85,
          countdownPitch * 2.15,
        );
        if (band.frequency !== undefined && band.prominenceDb >= 14) {
          run.push({
            feature,
            frequency: band.frequency,
            prominenceDb: band.prominenceDb,
            concentration: band.concentration,
          });
        } else {
          finishRun();
        }
      }
      finishRun();
    }
  }

  return deduplicateToneCandidates(candidates, 120);
}

function estimateSpectralBand(
  frame: Float32Array,
  sampleRate: number,
  minFrequency: number,
  maxFrequency: number,
): { frequency?: number; prominenceDb: number; concentration: number } {
  const size = frame.length;
  const fullMinBin = Math.max(1, Math.ceil(120 * size / sampleRate));
  const fullMaxBin = Math.min(Math.floor(size / 2) - 1, Math.floor(2_500 * size / sampleRate));
  const bandMinBin = Math.max(fullMinBin, Math.ceil(minFrequency * size / sampleRate));
  const bandMaxBin = Math.min(fullMaxBin, Math.floor(maxFrequency * size / sampleRate));
  if (bandMaxBin < bandMinBin) {
    return { prominenceDb: 0, concentration: 0 };
  }
  const powers: number[] = [];
  let bestBandBin = bandMinBin;
  let bestBandPower = 0;
  let totalPower = 0;
  for (let bin = fullMinBin; bin <= fullMaxBin; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < size; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, size - 1));
      const angle = 2 * Math.PI * bin * index / size;
      const value = frame[index] * window;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    powers.push(power);
    totalPower += power;
    if (bin >= bandMinBin && bin <= bandMaxBin && power > bestBandPower) {
      bestBandPower = power;
      bestBandBin = bin;
    }
  }
  if (bestBandPower <= 1e-10) {
    return { prominenceDb: 0, concentration: 0 };
  }
  const floor = Math.max(1e-12, median(powers));
  return {
    frequency: bestBandBin * sampleRate / size,
    prominenceDb: Math.min(80, 10 * Math.log10(bestBandPower / floor)),
    concentration: bestBandPower / Math.max(totalPower, 1e-12),
  };
}

function deduplicateToneCandidates(
  candidates: AudioToneSegment[],
  pitchToleranceCents: number,
): AudioToneSegment[] {
  const strongestFirst = candidates.sort((left, right) =>
    pitchSubsegmentQuality(right) - pitchSubsegmentQuality(left),
  );
  const unique: AudioToneSegment[] = [];
  for (const candidate of strongestFirst) {
    const duplicate = unique.some((kept) => {
      if (!kept.dominantFrequencyHz || !candidate.dominantFrequencyHz ||
          centsDifference(kept.dominantFrequencyHz, candidate.dominantFrequencyHz) > pitchToleranceCents) {
        return false;
      }
      const overlap = Math.max(0, Math.min(kept.endTime, candidate.endTime) -
        Math.max(kept.startTime, candidate.startTime));
      return overlap / Math.max(0.001, Math.min(kept.duration, candidate.duration)) >= 0.6;
    });
    if (!duplicate) {
      unique.push(candidate);
    }
  }
  return unique.sort((left, right) => left.startTime - right.startTime);
}

function toneCandidatesOverlap(
  left: AudioToneSegment,
  right: AudioToneSegment,
  pitchToleranceCents: number,
): boolean {
  if (!left.dominantFrequencyHz || !right.dominantFrequencyHz ||
      centsDifference(left.dominantFrequencyHz, right.dominantFrequencyHz) > pitchToleranceCents) {
    return false;
  }
  const overlap = Math.max(0, Math.min(left.endTime, right.endTime) -
    Math.max(left.startTime, right.startTime));
  return overlap / Math.max(0.001, Math.min(left.duration, right.duration)) >= 0.6;
}

function isQualifiedProtocolFrame(feature: AudioFrameFeature): boolean {
  return feature.frequency !== undefined &&
    feature.frequency >= 300 && feature.frequency <= 2_200 &&
    feature.spectralProminenceDb >= 14 &&
    feature.spectralConcentration >= 0.14 &&
    feature.tonality >= 0.4;
}

function pitchSubsegmentQuality(segment: AudioToneSegment): number {
  return (segment.qualifiedFrames ?? 0) * 2 +
    segment.meanTonality * 10 +
    (segment.meanSpectralProminenceDb ?? 0) * 0.2 -
    (segment.pitchStabilityCents ?? 0) * 0.02;
}

function mergeNearbySegments(segments: AudioToneSegment[], maxGap: number): AudioToneSegment[] {
  const merged: AudioToneSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const sameTrack = previous?.dominantFrequencyHz !== undefined && segment.dominantFrequencyHz !== undefined &&
      centsDifference(previous.dominantFrequencyHz, segment.dominantFrequencyHz) <= 180;
    if (previous && sameTrack && segment.startTime - previous.endTime <= maxGap) {
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
      previous.pitchStabilityCents = Math.max(
        previous.pitchStabilityCents ?? 0,
        segment.pitchStabilityCents ?? 0,
      );
      previous.meanSpectralProminenceDb = weightedAverageOptional(
        previous.meanSpectralProminenceDb,
        segment.meanSpectralProminenceDb,
        previousDuration,
        segment.duration,
      );
      previous.meanSpectralConcentration = weightedAverageOptional(
        previous.meanSpectralConcentration,
        segment.meanSpectralConcentration,
        previousDuration,
        segment.duration,
      );
      previous.qualifiedFrames = (previous.qualifiedFrames ?? 0) + (segment.qualifiedFrames ?? 0);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function estimateTonality(frame: Float32Array, sampleRate: number): {
  tonality: number;
  frequency?: number;
  spectralProminenceDb: number;
  spectralConcentration: number;
  spectralAmplitude: number;
} {
  let energy = 0;
  for (const sample of frame) {
    energy += sample * sample;
  }
  if (energy < 1e-10) {
    return { tonality: 0, spectralProminenceDb: 0, spectralConcentration: 0, spectralAmplitude: 0 };
  }
  let bestCorrelation = 0;
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
    }
  }
  const spectral = estimateSpectralPeak(frame, sampleRate);
  return {
    tonality: Math.max(0, Math.min(1, bestCorrelation)),
    frequency: spectral.frequency,
    spectralProminenceDb: spectral.prominenceDb,
    spectralConcentration: spectral.concentration,
    spectralAmplitude: spectral.amplitude,
  };
}

export function analyzeAudioFrameFeatures(frame: Float32Array, sampleRate: number): {
  tonality: number;
  frequency?: number;
  spectralProminenceDb: number;
  spectralConcentration: number;
  spectralAmplitude: number;
} {
  return estimateTonality(frame, sampleRate);
}

/** Hann-windowed spectral pitch avoids the subharmonic returned by selecting the
 * strongest raw autocorrelation lag. Fifty-hertz bins are sufficient to tell the
 * matching preparation tones from the changed-pitch final tone. */
function estimateSpectralPeak(
  frame: Float32Array,
  sampleRate: number,
): { frequency?: number; prominenceDb: number; concentration: number; amplitude: number } {
  const size = frame.length;
  const minBin = Math.max(1, Math.ceil(120 * size / sampleRate));
  const maxBin = Math.min(Math.floor(size / 2) - 1, Math.floor(2_500 * size / sampleRate));
  if (maxBin <= minBin) {
    return { prominenceDb: 0, concentration: 0, amplitude: 0 };
  }
  const powers = new Float64Array(maxBin + 2);
  let bestBin = minBin;
  let bestPower = 0;
  let windowSum = 0;
  for (let index = 0; index < size; index += 1) {
    windowSum += 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, size - 1));
  }
  for (let bin = minBin; bin <= maxBin; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < size; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, size - 1));
      const angle = 2 * Math.PI * bin * index / size;
      const value = frame[index] * window;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    powers[bin] = power;
    if (power > bestPower) {
      bestPower = power;
      bestBin = bin;
    }
  }
  if (bestPower <= 1e-10) {
    return { prominenceDb: 0, concentration: 0, amplitude: 0 };
  }
  const bandPowers = Array.from(powers.slice(minBin, maxBin + 1));
  const spectralFloor = Math.max(1e-12, median(bandPowers));
  const totalPower = Math.max(1e-12, bandPowers.reduce((sum, power) => sum + power, 0));
  const left = powers[bestBin - 1] || bestPower;
  const center = powers[bestBin];
  const right = powers[bestBin + 1] || bestPower;
  const denominator = left - 2 * center + right;
  const offset = Math.abs(denominator) > 1e-12
    ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator))
    : 0;
  return {
    frequency: (bestBin + offset) * sampleRate / size,
    prominenceDb: Math.min(80, 10 * Math.log10(bestPower / spectralFloor)),
    concentration: bestPower / totalPower,
    amplitude: 2 * Math.sqrt(bestPower) / Math.max(1e-6, windowSum),
  };
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function relativeFrequencyDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(left, right, 1e-6);
}

function centsDifference(left: number, right: number): number {
  return Math.abs(1_200 * Math.log2(Math.max(left, 1e-6) / Math.max(right, 1e-6)));
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

function weightedAverageOptional(
  left: number | undefined,
  right: number | undefined,
  leftWeight: number,
  rightWeight: number,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return (left * leftWeight + right * rightWeight) / Math.max(1e-6, leftWeight + rightWeight);
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
