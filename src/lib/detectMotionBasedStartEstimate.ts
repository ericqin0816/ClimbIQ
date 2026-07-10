import type {
  Confidence,
  DetectionCandidate,
  NormalizedZone,
  Sensitivity,
  StartSignalDebug,
  StartSignalDetectionResult,
} from "../types";
import { captureZoneImageData, normalizedZoneToPixelRect, sampleFramesInRange, seekTo } from "./videoFrameSampler";

interface DetectMotionBasedStartOptions {
  video: HTMLVideoElement;
  zone?: NormalizedZone;
  searchStart: number;
  searchEnd: number;
  reactionOffset: number;
  sensitivity: Sensitivity;
  fps?: number;
}

const FIXED_THRESHOLDS: Record<Sensitivity, number> = {
  low: 4,
  medium: 1,
  high: 0.5,
};

const DYNAMIC_ADDS: Record<Sensitivity, number> = {
  low: 3,
  medium: 1,
  high: 0.5,
};

const REQUIRED_FRAMES: Record<Sensitivity, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

export async function detectMotionBasedStartEstimate({
  video,
  zone,
  searchStart,
  searchEnd,
  reactionOffset,
  sensitivity,
  fps = 15,
}: DetectMotionBasedStartOptions): Promise<StartSignalDetectionResult> {
  const threshold = FIXED_THRESHOLDS[sensitivity];
  const debug: StartSignalDebug = {
    zoneExists: Boolean(zone),
    normalizedZone: zone,
    pixelZone: zone ? normalizedZoneToPixelRect(zone, video.videoWidth, video.videoHeight) : undefined,
    detectionMethod: "Motion-based start estimate",
    framesSampled: 0,
    maxColorDistance: 0,
    threshold,
    detectedCrossings: [],
    samples: [],
  };

  if (!zone) {
    debug.failureReason = "Start Body Zone is required for motion-based start estimate.";
    return result(false, "Start Signal not detected. Draw Start Body Zone first.", "None", threshold, debug);
  }

  const times = sampleFramesInRange(searchStart, searchEnd, fps);
  if (times.length < 5) {
    debug.failureReason = "Search window is too short for motion-based start estimate.";
    return result(false, "Start Signal not detected.", "None", threshold, debug);
  }

  const motionSamples: Array<{ time: number; motionScore: number; smoothedMotionScore: number }> = [];

  try {
    let previousImageData: ImageData | null = null;
    for (const time of times) {
      await seekTo(video, time);
      const current = captureZoneImageData(video, zone);
      if (previousImageData) {
        const motionScore = computeSensitiveMotionScore(previousImageData, current.imageData);
        motionSamples.push({
          time: roundMetric(video.currentTime),
          motionScore,
          smoothedMotionScore: motionScore,
        });
      }
      previousImageData = current.imageData;
      debug.pixelZone = current.pixelZone;
    }
  } catch (error) {
    debug.framesSampled = motionSamples.length;
    debug.failureReason = error instanceof Error ? error.message : "Unknown motion-based start error.";
    return result(false, "Start Signal not detected. Motion sampling failed.", "None", threshold, debug);
  }

  smoothMotionSamples(motionSamples);
  debug.framesSampled = times.length;
  debug.maxColorDistance = roundMetric(motionSamples.reduce((max, sample) => Math.max(max, sample.smoothedMotionScore), 0));

  const baseline = median(motionSamples.slice(0, Math.min(5, motionSamples.length)).map((sample) => sample.smoothedMotionScore));
  const finalThreshold = Math.min(FIXED_THRESHOLDS[sensitivity], baseline + DYNAMIC_ADDS[sensitivity]);
  debug.threshold = roundMetric(finalThreshold);
  const requiredFrames = REQUIRED_FRAMES[sensitivity];
  const candidates = buildCandidates({
    samples: motionSamples,
    threshold: debug.threshold,
    requiredFrames,
    searchStart,
    searchEnd,
    reactionOffset,
  });
  debug.topCandidates = candidates;

  const selected = candidates.find((candidate) => !candidate.boundaryRisk && (candidate.persistenceFrames ?? 0) >= requiredFrames) ?? candidates[0];
  if (!selected || debug.maxColorDistance < debug.threshold * 0.5) {
    debug.failureReason = "Motion signal was weak. Check that Start Body Zone covers the climber at the starting position.";
    return result(false, "Start Signal not detected.", "None", debug.threshold, debug, undefined, candidates);
  }

  debug.detectedRawTime = selected.rawTime;
  debug.selectedCandidateTime = selected.rawTime;
  debug.selectedCandidateReason = selected.reason;
  return result(
    true,
    `Start light was weak, so start was estimated as ${reactionOffset.toFixed(2)}s before first detected body movement.`,
    selected.confidence,
    debug.threshold,
    debug,
    selected.rawTime,
    candidates,
  );
}

function buildCandidates({
  samples,
  threshold,
  requiredFrames,
  searchStart,
  searchEnd,
  reactionOffset,
}: {
  samples: Array<{ time: number; motionScore: number; smoothedMotionScore: number }>;
  threshold: number;
  requiredFrames: number;
  searchStart: number;
  searchEnd: number;
  reactionOffset: number;
}): DetectionCandidate[] {
  const candidates = new Map<string, DetectionCandidate>();
  const strongest = samples.reduce<typeof samples[number] | undefined>((best, sample) => {
    return !best || sample.smoothedMotionScore > best.smoothedMotionScore ? sample : best;
  }, undefined);

  if (strongest) {
    const spikeIndex = samples.indexOf(strongest);
    const onsetIndex = findMotionOnsetIndex(samples, spikeIndex, threshold);
    const onset = samples[onsetIndex] ?? strongest;
    addCandidate(candidates, samples, onsetIndex, onset, "Earliest motion onset", "Earliest sustained body motion onset.", threshold, requiredFrames, searchStart, searchEnd, reactionOffset);
    addCandidate(candidates, samples, spikeIndex, strongest, "Largest motion spike", "Largest body-motion spike for manual review.", threshold, requiredFrames, searchStart, searchEnd, reactionOffset);
  }

  const firstCrossing = samples.find((sample, index) =>
    sample.smoothedMotionScore >= threshold &&
    countMotionFrames(samples, index, threshold * 0.6) >= Math.min(2, requiredFrames),
  );
  if (firstCrossing) {
    addCandidate(candidates, samples, samples.indexOf(firstCrossing), firstCrossing, "First threshold crossing", "Body motion first crossed threshold.", threshold, requiredFrames, searchStart, searchEnd, reactionOffset);
  }

  return Array.from(candidates.values())
    .sort((a, b) => (a.rawTime - b.rawTime) * 100 - ((a.persistenceFrames ?? 0) - (b.persistenceFrames ?? 0)) * 12)
    .slice(0, 3);
}

function addCandidate(
  candidates: Map<string, DetectionCandidate>,
  samples: Array<{ smoothedMotionScore: number }>,
  sampleIndex: number,
  motionSample: { time: number; smoothedMotionScore: number },
  kind: string,
  reason: string,
  threshold: number,
  requiredFrames: number,
  searchStart: number,
  searchEnd: number,
  reactionOffset: number,
) {
  const estimatedStartRaw = Math.max(0, roundMetric(motionSample.time - reactionOffset));
  const persistenceFrames = countMotionFrames(samples, Math.max(0, sampleIndex), threshold * 0.6);
  const boundaryRisk = estimatedStartRaw <= searchStart + 0.1 || estimatedStartRaw >= searchEnd - 0.25;
  const confidence: Confidence =
    boundaryRisk ? "Low" : motionSample.smoothedMotionScore >= threshold * 1.4 ? "Medium" : "Low";
  candidates.set(`${estimatedStartRaw}-${kind}`, {
    rawTime: estimatedStartRaw,
    confidence,
    reason,
    score: roundMetric(motionSample.smoothedMotionScore),
    kind,
    method: "Motion-based start estimate",
    detectedMovementRawTime: motionSample.time,
    reactionOffset,
    boundaryRisk,
    persistenceFrames: Math.max(1, persistenceFrames),
  });
}

function computeSensitiveMotionScore(frameA: ImageData, frameB: ImageData): number {
  const length = Math.min(frameA.data.length, frameB.data.length);
  let total = 0;
  let changedPixels = 0;
  let pixelCount = 0;
  const noiseFloor = 0.5;

  for (let index = 0; index < length; index += 4) {
    const grayA = ((frameA.data[index] ?? 0) * 0.299) + ((frameA.data[index + 1] ?? 0) * 0.587) + ((frameA.data[index + 2] ?? 0) * 0.114);
    const grayB = ((frameB.data[index] ?? 0) * 0.299) + ((frameB.data[index + 1] ?? 0) * 0.587) + ((frameB.data[index + 2] ?? 0) * 0.114);
    const diff = Math.abs(grayA - grayB);
    if (diff > noiseFloor) {
      total += diff - noiseFloor;
      changedPixels += 1;
    }
    pixelCount += 1;
  }

  if (!pixelCount) {
    return 0;
  }
  return roundMetric((total / pixelCount) * 1.15 + (changedPixels / pixelCount) * 3);
}

function smoothMotionSamples(samples: Array<{ motionScore: number; smoothedMotionScore: number }>): void {
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.motionScore ?? samples[index].motionScore;
    const current = samples[index].motionScore;
    const next = samples[index + 1]?.motionScore ?? samples[index].motionScore;
    samples[index].smoothedMotionScore = roundMetric((previous + current + next) / 3);
  }
}

function findMotionOnsetIndex(samples: Array<{ smoothedMotionScore: number }>, spikeIndex: number, threshold: number): number {
  const returnLevel = threshold * 0.35;
  let onsetIndex = Math.max(0, spikeIndex);
  for (let index = spikeIndex; index > 0; index -= 1) {
    if (samples[index - 1].smoothedMotionScore <= returnLevel) {
      onsetIndex = index;
      break;
    }
    onsetIndex = index - 1;
  }
  return onsetIndex;
}

function countMotionFrames(samples: Array<{ smoothedMotionScore: number }>, startIndex: number, threshold: number): number {
  let count = 0;
  for (let index = startIndex; index < samples.length; index += 1) {
    if (samples[index].smoothedMotionScore >= threshold) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function result(
  detected: boolean,
  reason: string,
  confidence: Confidence,
  threshold: number,
  debug: StartSignalDebug,
  rawTime?: number,
  candidates?: DetectionCandidate[],
): StartSignalDetectionResult {
  return {
    detected,
    rawTime,
    confidence,
    reason,
    threshold,
    debug,
    candidates,
  };
}
