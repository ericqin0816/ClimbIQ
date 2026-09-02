import type {
  Confidence,
  DetectionCandidate,
  FirstMovementDebug,
  FirstMovementDefinition,
  FirstMovementDetectionResult,
  NormalizedZone,
  Sensitivity,
} from "../types";
import { captureZoneImageData, normalizedZoneToPixelRect, sampleFramesInRange, seekTo } from "./videoFrameSampler";
import { adaptiveMotionThreshold, causalSmoothMotion, selectMotionBaseline } from "./motionSignal";

interface DetectFirstMovementOptions {
  video: HTMLVideoElement;
  zone?: NormalizedZone;
  startSignalRawTime?: number;
  searchEndOffset?: number;
  sensitivity: Sensitivity;
  movementDefinition?: FirstMovementDefinition;
  committedLaunchMinDelay?: number;
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

export async function detectFirstMovement({
  video,
  zone,
  startSignalRawTime,
  searchEndOffset = 2,
  sensitivity,
  movementDefinition = "earliest",
  committedLaunchMinDelay = 0.1,
  fps = 15,
}: DetectFirstMovementOptions): Promise<FirstMovementDetectionResult> {
  const analysisZone = zone ?? createFallbackStartBodyZone();
  const usingFallbackZone = !zone;
  const debug: FirstMovementDebug = {
    zoneExists: Boolean(zone),
    normalizedZone: analysisZone,
    pixelZone: normalizedZoneToPixelRect(analysisZone, video.videoWidth, video.videoHeight),
    startSignalRawTime,
    zoneAreaPercentage: roundMetric(zoneArea(analysisZone) * 100),
    committedLaunchMinDelay,
    sampleRateFps: fps,
    frameInterval: roundMetric(1 / fps),
    framesSampled: 0,
    maxMotion: 0,
    threshold: 0,
    detectedSpikes: [],
    samples: [],
  };

  if (startSignalRawTime === undefined) {
    debug.failureReason = "Start Signal must be accepted or manually set before first movement detection.";
    return result(false, "First Movement not detected. Start Signal is not set.", "None", debug);
  }

  const searchStart = Math.max(0, startSignalRawTime - 0.3);
  const searchEnd = Math.min(video.duration, startSignalRawTime + searchEndOffset);
  debug.searchWindowStart = roundMetric(searchStart);
  debug.searchWindowEnd = roundMetric(searchEnd);

  const times = sampleFramesInRange(searchStart, searchEnd, fps);
  if (times.length < 5) {
    debug.failureReason = "First movement search window is too short.";
    return result(false, "First Movement not detected. Search window is too short.", "None", debug);
  }

  try {
    let previousImageData: ImageData | null = null;
    for (const time of times) {
      await seekTo(video, time);
      const current = captureZoneImageData(video, analysisZone);
      if (previousImageData) {
        const motionScore = computeSensitiveMotionScore(previousImageData, current.imageData);
        debug.samples.push({
          time: roundMetric(video.currentTime),
          motionScore,
          smoothedMotionScore: motionScore,
        });
      }
      previousImageData = current.imageData;
      debug.pixelZone = current.pixelZone;
    }
  } catch (error) {
    debug.framesSampled = debug.samples.length;
    debug.failureReason = error instanceof Error ? error.message : "Unknown first movement detection error.";
    return result(false, "First Movement not detected. Frame sampling failed.", "None", debug);
  }

  smoothMotionSamples(debug.samples);
  debug.framesSampled = times.length;
  debug.maxMotion = roundMetric(debug.samples.reduce((max, sample) => Math.max(max, sample.smoothedMotionScore), 0));
  const postStartSamples = debug.samples.filter((sample) => sample.time >= startSignalRawTime);
  const firstPostStartSample = postStartSamples[0];
  debug.firstSampledTimeAfterStart = firstPostStartSample ? roundMetric(firstPostStartSample.time - startSignalRawTime) : undefined;
  debug.firstSampleMotion = firstPostStartSample?.smoothedMotionScore;

  const preStartMotion = debug.samples
    .filter((sample) => sample.time < startSignalRawTime)
    .map((sample) => sample.smoothedMotionScore);
  const baselineSamples = selectMotionBaseline(debug.samples, startSignalRawTime);
  const baselineMotion = median(baselineSamples);
  const fixedThreshold = FIXED_THRESHOLDS[sensitivity];
  const dynamicThreshold = adaptiveMotionThreshold(baselineSamples, fixedThreshold, DYNAMIC_ADDS[sensitivity]);
  debug.baselineMotion = roundMetric(baselineMotion);
  debug.fixedThreshold = fixedThreshold;
  debug.dynamicThreshold = roundMetric(dynamicThreshold);
  const earliestThreshold = roundMetric(dynamicThreshold);
  const committedThreshold = roundMetric(Math.max(earliestThreshold * 1.8, baselineMotion * 2, earliestThreshold + 0.25));
  debug.threshold = earliestThreshold;
  debug.earliestMotionThreshold = earliestThreshold;
  debug.committedLaunchThreshold = committedThreshold;
  debug.firstSampleToMaxRatio = debug.maxMotion > 0 && firstPostStartSample
    ? roundMetric(firstPostStartSample.smoothedMotionScore / debug.maxMotion)
    : undefined;
  debug.movementAlreadyUnderway = (debug.firstSampleToMaxRatio ?? 0) > 0.8;
  debug.preStartMotionDetected = preStartMotion.some((motion) => motion >= earliestThreshold);

  for (const sample of debug.samples) {
    if (sample.smoothedMotionScore >= debug.threshold) {
      debug.detectedSpikes.push({ time: sample.time, motionScore: roundMetric(sample.smoothedMotionScore) });
    }
  }
  debug.firstThresholdCrossingTime = debug.detectedSpikes[0]?.time;

  const requiredFrames = REQUIRED_FRAMES[sensitivity];
  const candidates = buildMotionCandidates({
    samples: debug.samples,
    startSignalRawTime,
    searchEnd,
    threshold: earliestThreshold,
    committedThreshold,
    requiredFrames,
    usingFallbackZone,
    baselineMotion,
    zoneAreaPercentage: debug.zoneAreaPercentage ?? 0,
    committedLaunchMinDelay,
    frameInterval: debug.frameInterval ?? 1 / fps,
  });
  debug.topMotionSpikes = candidates;
  debug.topMotionPeaks = getTopMotionPeaks(debug.samples, startSignalRawTime);
  debug.movementSegments = buildMotionSegments(debug.samples, earliestThreshold).map((segment) => ({
    startTime: roundMetric(segment.startTime),
    endTime: roundMetric(segment.endTime),
    duration: segment.duration,
    maxMotion: segment.maxMotion,
    averageMotion: segment.averageMotion,
    totalMotion: segment.totalMotion,
  }));

  const selectedCandidate = selectMotionCandidate(candidates, earliestThreshold, committedThreshold, requiredFrames, movementDefinition, committedLaunchMinDelay);
  const zoneLabel = usingFallbackZone ? "fallback lower-center region" : "Start Body Zone";
  const fallbackWarning = usingFallbackZone
    ? " Used fallback lower-center motion because Start Body Zone was missing. This may include camera shake or background movement."
    : "";

  if (!selectedCandidate) {
    if (movementDefinition === "committed") {
      debug.failureReason = "No committed launch candidate found. Try lowering the minimum delay or sensitivity, or verify Start Body Zone.";
      return result(false, "First Movement not detected.", "None", debug, undefined, undefined, candidates);
    }

    if (debug.maxMotion >= debug.threshold * 0.6) {
      const candidate = candidates[0];
      if (candidate) {
        debug.detectedRawTime = candidate.rawTime;
        debug.selectedCandidateTime = candidate.rawTime;
        debug.selectedCandidateKind = candidate.kind;
        debug.detectedTimeAfterStart = candidate.climbTime;
        debug.suspiciousFirstFrameDetection = Boolean(candidate.suspiciousFirstFrame);
        return result(
          true,
          `Motion did not fully meet threshold, but this was the strongest early motion spike.${fallbackWarning}`,
          "Low",
          debug,
          candidate.rawTime,
          candidate.climbTime,
          candidates,
        );
      }
    }

    debug.failureReason = debug.maxMotion > 0.25
      ? `Motion signal was weak. Max motion ${formatNumber(debug.maxMotion)} did not reach ${formatNumber(debug.threshold * 0.6)} candidate strength. Check that Start Signal is accurate and Start Body Zone covers the climber at the starting position.`
      : `Motion signal was extremely low inside the ${zoneLabel}. Check that Start Signal is accurate and Start Body Zone covers the climber at the starting position.`;
    return result(false, "First Movement not detected.", "None", debug, undefined, undefined, candidates);
  }

  debug.detectedRawTime = selectedCandidate.rawTime;
  debug.selectedCandidateTime = selectedCandidate.rawTime;
  debug.selectedCandidateKind = selectedCandidate.kind;
  debug.detectedTimeAfterStart = selectedCandidate.climbTime;
  debug.suspiciousFirstFrameDetection = Boolean(selectedCandidate.suspiciousFirstFrame);

  return result(
    true,
    `${selectedCandidate.reason}${fallbackWarning}`,
    usingFallbackZone ? "Low" : selectedCandidate.confidence,
    debug,
    selectedCandidate.rawTime,
    selectedCandidate.climbTime,
    candidates,
  );
}

function computeSensitiveMotionScore(frameA: ImageData, frameB: ImageData): number {
  const length = Math.min(frameA.data.length, frameB.data.length);
  if (length === 0) {
    return 0;
  }

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

  if (pixelCount === 0) {
    return 0;
  }

  const averageChange = total / pixelCount;
  const changedRatioBoost = changedPixels / pixelCount;
  return roundMetric((averageChange * 1.15) + (changedRatioBoost * 3));
}

function buildMotionCandidates({
  samples,
  startSignalRawTime,
  searchEnd,
  threshold,
  committedThreshold,
  requiredFrames,
  usingFallbackZone,
  baselineMotion,
  zoneAreaPercentage,
  committedLaunchMinDelay,
  frameInterval,
}: {
  samples: FirstMovementDebug["samples"];
  startSignalRawTime: number;
  searchEnd: number;
  threshold: number;
  committedThreshold: number;
  requiredFrames: number;
  usingFallbackZone: boolean;
  baselineMotion: number;
  zoneAreaPercentage: number;
  committedLaunchMinDelay: number;
  frameInterval: number;
}): DetectionCandidate[] {
  const candidates: DetectionCandidate[] = [];
  const segments = buildMotionSegments(samples, threshold);
  const strongest = samples.reduce<FirstMovementDebug["samples"][number] | undefined>((best, sample) => {
    return !best || sample.smoothedMotionScore > best.smoothedMotionScore ? sample : best;
  }, undefined);

  if (strongest && strongest.smoothedMotionScore >= threshold * 0.6) {
    const strongestIndex = samples.indexOf(strongest);
    const onsetIndex = findMotionOnsetIndex(samples, strongestIndex, baselineMotion, threshold);
    const onset = samples[onsetIndex] ?? strongest;
    const onsetPersistence = countMotionFrames(samples, onsetIndex, Math.max(baselineMotion + 0.05, threshold * 0.35));
    const preloadFlag = strongest.smoothedMotionScore >= committedThreshold && onset.smoothedMotionScore < committedThreshold * 0.6;
    candidates.push({
      rawTime: onset.time,
      climbTime: roundMetric(onset.time - startSignalRawTime),
      confidence: getMotionConfidence({
        motion: strongest.smoothedMotionScore,
        threshold,
        persistenceFrames: onsetPersistence,
        requiredFrames: Math.min(requiredFrames, 2),
        boundaryRisk: false,
        suspiciousFirstFrame: isNearFirstPostStartSample(onset.time, startSignalRawTime, frameInterval),
        zoneAreaPercentage,
        usingFallbackZone,
      }),
      reason: preloadFlag
        ? "Possible preload / weight shift before the larger committed launch."
        : "Earliest visible body movement above the low motion threshold. May include preload or weight shift.",
      score: roundMetric(onset.smoothedMotionScore),
      kind: preloadFlag ? "Possible preload / weight shift" : "Earliest Visible Motion",
      boundaryRisk: onset.time >= searchEnd - 0.1,
      suspiciousFirstFrame: isNearFirstPostStartSample(onset.time, startSignalRawTime, frameInterval),
      preloadFlag,
      persistenceFrames: onsetPersistence,
    });
  }

  const committedSegment = selectCommittedSegment(segments, startSignalRawTime, committedLaunchMinDelay);
  const committedIndex = committedSegment
    ? committedSegment.samples.findIndex((sample) => sample.smoothedMotionScore >= committedThreshold)
    : -1;
  if (committedSegment && committedIndex >= 0) {
    const committedSampleIndex = samples.indexOf(committedSegment.samples[committedIndex]);
    const committed = committedSegment.samples[committedIndex];
    const committedPersistence = countMotionFrames(samples, committedSampleIndex, threshold);
    candidates.push({
      rawTime: committed.time,
      climbTime: roundMetric(committed.time - startSignalRawTime),
      confidence: getMotionConfidence({
        motion: committed.smoothedMotionScore,
        threshold: committedThreshold,
        persistenceFrames: committedPersistence,
        requiredFrames: Math.min(2, requiredFrames),
        boundaryRisk: committed.time >= searchEnd - 0.1,
        suspiciousFirstFrame: isNearFirstPostStartSample(committed.time, startSignalRawTime, frameInterval) || committed.time - startSignalRawTime < committedLaunchMinDelay,
        zoneAreaPercentage,
        usingFallbackZone,
      }),
      reason: "Committed launch: stronger sustained body motion, less likely to be small rocking or preload.",
      score: roundMetric(committed.smoothedMotionScore),
      kind: "Committed Launch",
      boundaryRisk: committed.time >= searchEnd - 0.1,
      suspiciousFirstFrame: isNearFirstPostStartSample(committed.time, startSignalRawTime, frameInterval) || committed.time - startSignalRawTime < committedLaunchMinDelay,
      persistenceFrames: committedPersistence,
    });
  }

  samples.forEach((sample, index) => {
    const persistenceFrames = countMotionFrames(samples, index, threshold * 0.6);
    const crossesThreshold = sample.smoothedMotionScore >= threshold;
    const closeCandidate = sample.smoothedMotionScore >= threshold * 0.6;
    if (!crossesThreshold && !closeCandidate) {
      return;
    }

    const boundaryRisk = sample.time >= searchEnd - 0.1;
    const suspiciousFirstFrame = isNearFirstPostStartSample(sample.time, startSignalRawTime, frameInterval);
    const confidence = getMotionConfidence({
      motion: sample.smoothedMotionScore,
      threshold,
      persistenceFrames,
      requiredFrames,
      boundaryRisk,
      suspiciousFirstFrame,
      zoneAreaPercentage,
      usingFallbackZone,
    });
    const kind = crossesThreshold ? "First threshold crossing" : "Earliest low-threshold motion";
    candidates.push({
      rawTime: sample.time,
      climbTime: roundMetric(sample.time - startSignalRawTime),
      confidence,
      reason: crossesThreshold
        ? `Motion crossed threshold for ${persistenceFrames} sample${persistenceFrames === 1 ? "" : "s"}.`
        : "Motion did not fully meet threshold, but this was the strongest early motion spike.",
      score: roundMetric(sample.smoothedMotionScore),
      kind,
      boundaryRisk,
      suspiciousFirstFrame,
      persistenceFrames,
    });
  });

  if (strongest && strongest.smoothedMotionScore >= threshold * 0.6) {
    const index = samples.indexOf(strongest);
    candidates.push({
      rawTime: strongest.time,
      climbTime: roundMetric(strongest.time - startSignalRawTime),
      confidence: getMotionConfidence({
        motion: strongest.smoothedMotionScore,
        threshold: committedThreshold,
        persistenceFrames: index >= 0 ? countMotionFrames(samples, index, threshold) : 1,
        requiredFrames: Math.min(2, requiredFrames),
        boundaryRisk: strongest.time >= searchEnd - 0.1,
        suspiciousFirstFrame: isNearFirstPostStartSample(strongest.time, startSignalRawTime, frameInterval),
        zoneAreaPercentage,
        usingFallbackZone,
      }),
      reason: "Largest Early Motion Spike in the first movement search window.",
      score: roundMetric(strongest.smoothedMotionScore),
      kind: "Largest Early Motion Spike",
      boundaryRisk: strongest.time >= searchEnd - 0.1,
      suspiciousFirstFrame: isNearFirstPostStartSample(strongest.time, startSignalRawTime, frameInterval),
      persistenceFrames: index >= 0 ? countMotionFrames(samples, index, threshold * 0.6) : 1,
    });
  }

  return dedupeCandidates(candidates)
    .sort((a, b) => motionCandidateRank(a, threshold, requiredFrames) - motionCandidateRank(b, threshold, requiredFrames))
    .slice(0, 6);
}

function findMotionOnsetIndex(
  samples: FirstMovementDebug["samples"],
  spikeIndex: number,
  baselineMotion: number,
  threshold: number,
): number {
  if (spikeIndex <= 0) {
    return Math.max(0, spikeIndex);
  }

  const returnLevel = baselineMotion + Math.max(0.08, (threshold - baselineMotion) * 0.25);
  let onsetIndex = spikeIndex;
  for (let index = spikeIndex; index > 0; index -= 1) {
    if (samples[index - 1].smoothedMotionScore <= returnLevel) {
      onsetIndex = index;
      break;
    }
    onsetIndex = index - 1;
  }
  return onsetIndex;
}

function selectMotionCandidate(
  candidates: DetectionCandidate[],
  threshold: number,
  committedThreshold: number,
  requiredFrames: number,
  movementDefinition: FirstMovementDefinition,
  committedLaunchMinDelay: number,
): DetectionCandidate | undefined {
  if (movementDefinition === "committed") {
    return candidates.find((candidate) =>
      candidate.kind.includes("Committed Launch") &&
      !candidate.boundaryRisk &&
      !candidate.suspiciousFirstFrame &&
      (candidate.climbTime ?? 0) >= committedLaunchMinDelay,
    );
  }

  const earliest = candidates.find((candidate) =>
    (candidate.kind === "Earliest Visible Motion" || candidate.kind === "Possible preload / weight shift") &&
    (candidate.climbTime ?? -1) >= 0 &&
    candidate.confidence !== "Low" &&
    !candidate.suspiciousFirstFrame,
  );
  if (earliest) {
    return earliest;
  }

  const committed = candidates.find((candidate) => candidate.kind.includes("Committed Launch") && candidate.score >= committedThreshold);
  if (committed) {
    return committed;
  }

  const reliable = candidates
    .filter((candidate) => !candidate.boundaryRisk)
    .filter((candidate) => (candidate.climbTime ?? -1) >= 0)
    .filter((candidate) => !candidate.suspiciousFirstFrame || candidate.score >= threshold * 2.5)
    .filter((candidate) => candidate.score >= threshold)
    .filter((candidate) => (candidate.persistenceFrames ?? 1) >= requiredFrames);

  return reliable.sort((a, b) => motionCandidateRank(a, threshold, requiredFrames) - motionCandidateRank(b, threshold, requiredFrames))[0];
}

interface MotionSegment {
  startTime: number;
  endTime: number;
  duration: number;
  maxMotion: number;
  averageMotion: number;
  totalMotion: number;
  samples: FirstMovementDebug["samples"];
}

function buildMotionSegments(samples: FirstMovementDebug["samples"], lowThreshold: number): MotionSegment[] {
  const segments: MotionSegment[] = [];
  let current: FirstMovementDebug["samples"] = [];
  for (const sample of samples) {
    if (sample.smoothedMotionScore >= lowThreshold * 0.6) {
      current.push(sample);
    } else if (current.length) {
      segments.push(createSegment(current));
      current = [];
    }
  }
  if (current.length) {
    segments.push(createSegment(current));
  }
  return segments;
}

function createSegment(samples: FirstMovementDebug["samples"]): MotionSegment {
  const maxMotion = Math.max(...samples.map((sample) => sample.smoothedMotionScore));
  const totalMotion = samples.reduce((sum, sample) => sum + sample.smoothedMotionScore, 0);
  return {
    startTime: samples[0].time,
    endTime: samples[samples.length - 1].time,
    duration: roundMetric(samples[samples.length - 1].time - samples[0].time),
    maxMotion: roundMetric(maxMotion),
    averageMotion: roundMetric(totalMotion / samples.length),
    totalMotion: roundMetric(totalMotion),
    samples,
  };
}

function selectCommittedSegment(segments: MotionSegment[], startSignalRawTime: number, minDelay: number): MotionSegment | undefined {
  return segments
    .filter((segment) => segment.startTime - startSignalRawTime >= minDelay)
    .sort((a, b) => {
      const scoreA = a.totalMotion * 1.2 + a.maxMotion * 2 + a.duration;
      const scoreB = b.totalMotion * 1.2 + b.maxMotion * 2 + b.duration;
      return scoreB - scoreA;
    })[0];
}

function dedupeCandidates(candidates: DetectionCandidate[]): DetectionCandidate[] {
  const merged: DetectionCandidate[] = [];
  for (const candidate of candidates) {
    const existing = merged.find((item) => Math.abs(item.rawTime - candidate.rawTime) <= 0.02);
    if (!existing) {
      merged.push(candidate);
      continue;
    }
    const labels = new Set(existing.kind.split(" + ").concat(candidate.kind.split(" + ")));
    existing.kind = Array.from(labels).join(" + ");
    existing.reason = `${existing.reason} ${candidate.reason}`;
    existing.score = Math.max(existing.score, candidate.score);
    existing.confidence = mergeConfidence(existing.confidence, candidate.confidence);
    existing.persistenceFrames = Math.max(existing.persistenceFrames ?? 0, candidate.persistenceFrames ?? 0);
    existing.suspiciousFirstFrame = existing.suspiciousFirstFrame || candidate.suspiciousFirstFrame;
    existing.preloadFlag = existing.preloadFlag || candidate.preloadFlag;
  }
  return merged;
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  const order: Confidence[] = ["None", "Low", "Medium", "High"];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function motionCandidateRank(candidate: DetectionCandidate, threshold: number, requiredFrames: number): number {
  const boundaryPenalty = candidate.boundaryRisk ? 100000 : 0;
  const persistenceBonus = Math.min(candidate.persistenceFrames ?? 0, requiredFrames) * 18;
  const strengthBonus = Math.min(candidate.score / threshold, 2) * 8;
  return boundaryPenalty + (candidate.climbTime ?? candidate.rawTime) * 100 - persistenceBonus - strengthBonus;
}

function countMotionFrames(samples: FirstMovementDebug["samples"], startIndex: number, threshold: number): number {
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

function createFallbackStartBodyZone(): NormalizedZone {
  return {
    id: "startBody",
    label: "Fallback lower-wall body region",
    x1: 0.08,
    y1: 0.42,
    x2: 0.92,
    y2: 0.94,
  };
}

function smoothMotionSamples(samples: FirstMovementDebug["samples"]): void {
  causalSmoothMotion(samples);
}

function getMotionConfidence({
  motion,
  threshold,
  persistenceFrames,
  requiredFrames,
  boundaryRisk,
  suspiciousFirstFrame,
  zoneAreaPercentage,
  usingFallbackZone,
}: {
  motion: number;
  threshold: number;
  persistenceFrames: number;
  requiredFrames: number;
  boundaryRisk: boolean;
  suspiciousFirstFrame: boolean;
  zoneAreaPercentage: number;
  usingFallbackZone: boolean;
}): Confidence {
  if (boundaryRisk || usingFallbackZone || zoneAreaPercentage > 30) {
    return "Low";
  }
  const ratio = threshold > 0 ? motion / threshold : 0;
  if (suspiciousFirstFrame && ratio < 2.5) {
    return "Low";
  }
  if (ratio >= 1.55 && persistenceFrames >= requiredFrames) {
    return "High";
  }
  if (ratio >= 1 && persistenceFrames >= Math.min(requiredFrames, 2)) {
    return "Medium";
  }
  return "Low";
}

function isNearFirstPostStartSample(time: number, startSignalRawTime: number, frameInterval: number): boolean {
  const climbTime = time - startSignalRawTime;
  // A real launch often begins in the first sampled frame after an exact audio
  // start. Only flag a virtually identical timestamp; movement-already-underway
  // and pre-start baselines handle genuinely late/wrong start markers.
  return climbTime >= 0 && climbTime <= Math.min(0.005, frameInterval * 0.1);
}

function getTopMotionPeaks(samples: FirstMovementDebug["samples"], startSignalRawTime: number) {
  return [...samples]
    .sort((a, b) => b.smoothedMotionScore - a.smoothedMotionScore)
    .slice(0, 5)
    .map((sample) => ({
      rawTime: sample.time,
      climbTime: roundMetric(sample.time - startSignalRawTime),
      motionScore: roundMetric(sample.smoothedMotionScore),
    }));
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function zoneArea(zone: NormalizedZone): number {
  return Math.abs(zone.x2 - zone.x1) * Math.abs(zone.y2 - zone.y1);
}

function candidateKey(time: number, kind: string): string {
  return `${time.toFixed(3)}-${kind}`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatNumber(value: number): string {
  return value.toFixed(3);
}

function result(
  detected: boolean,
  reason: string,
  confidence: Confidence,
  debug: FirstMovementDebug,
  rawTime?: number,
  climbTime?: number,
  candidates?: DetectionCandidate[],
): FirstMovementDetectionResult {
  return {
    detected,
    rawTime,
    climbTime,
    confidence,
    reason,
    threshold: debug.threshold,
    debug,
    candidates,
  };
}
