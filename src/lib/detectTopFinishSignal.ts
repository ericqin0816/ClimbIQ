import type {
  Confidence,
  DetectionCandidate,
  NormalizedZone,
  RGB,
  StartLightCalibration,
  StartSignalDetectionResult,
} from "../types";
import {
  computeColorDistance,
  roundTime,
  sampleFramesInRange,
  sampleZoneAverageColor,
  seekTo,
} from "./videoFrameSampler";

export interface TopFinishFrame {
  time: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface TopFinishColorSample {
  time: number;
  averageRgb: RGB;
}

export interface TopFinishDiscovery {
  found: boolean;
  rawTime?: number;
  confidence: Confidence;
  reason: string;
  score: number;
  zone?: NormalizedZone;
  calibration?: StartLightCalibration;
  candidates: DetectionCandidate[];
}

export interface TopFinishSignalOutcome {
  result: StartSignalDetectionResult;
  zone?: NormalizedZone;
  calibration?: StartLightCalibration;
}

interface DetectTopFinishSignalOptions {
  video: HTMLVideoElement;
  startSignalRawTime: number;
  laneHintZone?: NormalizedZone;
  expectedFinishTime?: number;
  minimumClimbSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (phase: "coarse" | "refine", processed: number, total: number) => void;
}

const COARSE_FPS = 5;
const REFINE_FPS = 30;
const MAX_SCAN_WIDTH = 320;
const MAX_SCAN_HEIGHT = 320;
const TOP_SCAN_MIN_Y = 0.015;
const TOP_SCAN_MAX_Y = 0.22;

/**
 * Fallback for phone videos where the lower start sensor is too oblique or
 * faint at finish. It searches the broad upper portion of the selected lane
 * for a tiny electronic indicator that changes to a new persistent color,
 * then refines the transition at frame-level resolution in that discovered
 * patch. The broad search makes no assumption that the top and bottom of an
 * angled wall share the same x coordinate.
 */
export async function detectTopFinishSignal({
  video,
  startSignalRawTime,
  laneHintZone,
  expectedFinishTime,
  minimumClimbSeconds = 3,
  signal,
  onProgress,
}: DetectTopFinishSignalOptions): Promise<TopFinishSignalOutcome> {
  const searchStart = Math.max(0, startSignalRawTime + minimumClimbSeconds);
  const searchEnd = Math.max(searchStart, video.duration - 0.04);
  if (searchEnd - searchStart < 0.8) {
    return { result: emptyResult("The upper finish-indicator search window is too short.") };
  }

  const times = sampleFramesInRange(searchStart, searchEnd, COARSE_FPS);
  const frames = await captureFrames(video, times, signal, (done, total) => onProgress?.("coarse", done, total));
  // Physical top tracking needs the camera view from immediately after the
  // accepted start as its structural reference. If a broadcast cuts or zooms
  // to a different camera during the climb, comparing only with the first
  // frame at +3 s can make the top of that cropped view look like the finish.
  // A fixed phone view remains comparable; a scene change is rejected by the
  // frame-wide structural guard inside analyzeTopContactFrames.
  const referenceTime = Math.min(searchStart, Math.max(0, startSignalRawTime + 0.35));
  const referenceFrames = await captureFrames(video, [referenceTime], signal, () => undefined);
  const physicalReference = referenceFrames[0] ?? frames[0];
  const laneHintX = laneHintZone ? (laneHintZone.x1 + laneHintZone.x2) / 2 : undefined;
  const indicatorDiscovery = analyzeTopFinishFrames(frames, laneHintX, expectedFinishTime);
  const contactDiscovery = analyzeTopContactFrames([physicalReference, ...frames], laneHintX);
  const topPresence = contactDiscovery.candidates.find((candidate) => candidate.kind === "Unverified top presence");
  const indicatorLooksLikeReset = Boolean(
    topPresence && indicatorDiscovery.found && indicatorDiscovery.rawTime !== undefined &&
    indicatorDiscovery.rawTime > topPresence.rawTime + 1.5,
  );
  if (topPresence && (!indicatorDiscovery.found || indicatorLooksLikeReset)) {
    const refineTimes = sampleFramesInRange(
      Math.max(searchStart, topPresence.rawTime - 0.8),
      Math.min(searchEnd, topPresence.rawTime + 1.15),
      REFINE_FPS,
    );
    const refineFrames = await captureFrames(video, refineTimes, signal, (done, total) => onProgress?.("refine", done, total));
    const refinedPresenceDiscovery = analyzeTopContactFrames([physicalReference, ...refineFrames], laneHintX);
    const refinedPresence = refinedPresenceDiscovery.candidates.find((candidate) =>
      candidate.kind === "Unverified top presence" || candidate.kind === "Physical top contact",
    );
    const selectedPresence = refinedPresence ?? topPresence;
    return {
      result: topPresenceToResult(selectedPresence, refinedPresenceDiscovery.zone ?? contactDiscovery.zone, refineFrames.length, indicatorLooksLikeReset),
      zone: refinedPresenceDiscovery.zone ?? contactDiscovery.zone,
    };
  }
  // A timing unit can reset long after contact. When the athlete's verified top
  // reach and descent precede an electronic candidate by a material margin,
  // the later light change is a reset, not the finish.
  const preferPhysicalContact = contactDiscovery.found && contactDiscovery.rawTime !== undefined && (
    !indicatorDiscovery.found || indicatorDiscovery.rawTime === undefined ||
    contactDiscovery.rawTime < indicatorDiscovery.rawTime - 0.45
  );
  if (preferPhysicalContact) {
    const refineTimes = sampleFramesInRange(
      Math.max(searchStart, contactDiscovery.rawTime! - 0.9),
      Math.min(searchEnd, contactDiscovery.rawTime! + 1.35),
      REFINE_FPS,
    );
    const refineFrames = await captureFrames(video, refineTimes, signal, (done, total) => onProgress?.("refine", done, total));
    const refinedContact = analyzeTopContactFrames([physicalReference, ...refineFrames], laneHintX);
    const selectedContact = refinedContact.found ? refinedContact : contactDiscovery;
    return {
      result: topContactToResult(selectedContact, refineFrames.length),
      zone: selectedContact.zone,
    };
  }

  const discovery = indicatorDiscovery;
  if (!discovery.found || discovery.rawTime === undefined || !discovery.zone || !discovery.calibration) {
    const combinedReason = `${discovery.reason} ${contactDiscovery.reason}`;
    return { result: emptyResult(combinedReason) };
  }

  const refineStart = Math.max(searchStart, discovery.rawTime - 0.8);
  const refineEnd = Math.min(searchEnd, discovery.rawTime + 1.25);
  const refineTimes = sampleFramesInRange(refineStart, refineEnd, REFINE_FPS);
  const refinedSamples: TopFinishColorSample[] = [];
  for (let index = 0; index < refineTimes.length; index += 1) {
    throwIfCancelled(signal);
    const sampled = await sampleZoneAverageColor(video, refineTimes[index], discovery.zone);
    refinedSamples.push({ time: roundTime(sampled.time), averageRgb: sampled.averageRgb });
    onProgress?.("refine", index + 1, refineTimes.length);
    if (index % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const refined = analyzeTopFinishColorSamples(refinedSamples, discovery.calibration, expectedFinishTime);
  let result = refined.detected
    ? refined
    : discoveryToResult(discovery);
  result.debug.normalizedZone = discovery.zone;
  result.debug.calibration = discovery.calibration;

  // A standalone upper electronic change may be the timing unit resetting
  // after the athlete has already descended. It becomes authoritative only
  // when physical top contact occurs in the same window or an entered official
  // total independently agrees. Otherwise preserve it as a review suggestion.
  result = requireUpperFinishCorroboration(result, contactDiscovery, expectedFinishTime);
  return { result, zone: discovery.zone, calibration: discovery.calibration };
}

/** Keeps an isolated upper-light transition review-only because timing units
 * can reset after the athlete has descended. Exported for deterministic policy
 * tests independent of browser video decoding. */
export function requireUpperFinishCorroboration(
  result: StartSignalDetectionResult,
  contactDiscovery: Pick<TopFinishDiscovery, "found" | "rawTime">,
  expectedFinishTime?: number,
): StartSignalDetectionResult {
  const physicallyCorroborated = contactDiscovery.found && contactDiscovery.rawTime !== undefined &&
    result.rawTime !== undefined && Math.abs(contactDiscovery.rawTime - result.rawTime) <= 1.2;
  const officiallyCorroborated = expectedFinishTime !== undefined && result.rawTime !== undefined &&
    Math.abs(expectedFinishTime - result.rawTime) <= 0.45;
  if (result.confidence !== "High" || physicallyCorroborated || officiallyCorroborated) {
    return result;
  }

  const reviewReason = `${result.reason} The upper electronic change was not independently corroborated by physical top contact or an official total, so it requires frame review.`;
  return {
    ...result,
    confidence: "Medium",
    reason: reviewReason,
    candidates: result.candidates?.map((candidate, index) => index === 0
      ? { ...candidate, confidence: "Medium", reason: reviewReason }
      : candidate),
    debug: {
      ...result.debug,
      selectedCandidateReason: reviewReason,
    },
  };
}

export function analyzeTopFinishFrames(
  frames: TopFinishFrame[],
  laneHintX?: number,
  expectedFinishTime?: number,
): TopFinishDiscovery {
  if (frames.length < 8) return emptyDiscovery("Not enough upper-wall frames were available for finish-indicator discovery.");
  const { width, height } = frames[0];
  if (width < 8 || height < 8 || frames.some((frame) => frame.width !== width || frame.height !== height)) {
    return emptyDiscovery("Upper-wall scan frames had inconsistent dimensions.");
  }

  const baselineCount = Math.min(8, Math.max(4, Math.floor(frames.length * 0.14)));
  const globalColors = frames.map(averageFrame);
  const globalBaseline = averageRgb(globalColors.slice(0, baselineCount));
  const structuralChangeRatios = frames.map((frame, index) => frameWideStructuralChangeRatio(
    frames[0],
    frame,
    globalColors[0],
    globalColors[index],
  ));
  const [minXNorm, maxXNorm] = upperLaneBounds(laneHintX, 0.21);
  const minX = Math.max(1, Math.floor(width * minXNorm));
  const maxX = Math.min(width - 2, Math.ceil(width * maxXNorm));
  const minY = Math.max(1, Math.floor(height * TOP_SCAN_MIN_Y));
  const maxY = Math.min(height - 2, Math.ceil(height * TOP_SCAN_MAX_Y));
  const internal: Array<{
    x: number;
    y: number;
    radius: number;
    rawTime: number;
    confidence: Confidence;
    score: number;
    before: RGB;
    after: RGB;
    persistenceFrames: number;
  }> = [];

  for (const radius of [0, 1, 2] as const) {
    const stride = Math.max(2, radius + 1);
    for (let y = minY + radius; y <= maxY - radius; y += stride) {
      for (let x = minX + radius; x <= maxX - radius; x += stride) {
        const colors = frames.map((frame) => averagePatch(frame, x, y, radius));
        const baseline = averageRgb(colors.slice(0, baselineCount));
        const baselineDistances = colors.slice(0, baselineCount).map((color) => computeColorDistance(color, baseline));
        const baselineMad = median(baselineDistances.map((value) => Math.abs(value - median(baselineDistances))));
        const threshold = Math.max(8, median(baselineDistances) + baselineMad * 4 + 4);
        const correctedChanges = colors.map((color, index) =>
          // A phone's auto-exposure can brighten the complete upward-looking
          // frame by dozens of RGB levels. Remove nearly all frame-wide change;
          // a real indicator still retains its localized chromatic residual.
          computeColorDistance(color, baseline) - computeColorDistance(globalColors[index], globalBaseline) * 0.95,
        );

        for (let index = baselineCount; index < frames.length - 3; index += 1) {
          // A spectator walking close to the phone can cover the entire wall
          // and create a persistent skin/clothing color inside any top patch.
          // Electronic finish evidence is local, so reject frames where more
          // than a quarter of the exposure-corrected image changed structure.
          if (structuralChangeRatios[index] > 0.26) continue;
          if (correctedChanges[index] < threshold) continue;
          const previousStable = [index - 2, index - 1].every((cursor) => correctedChanges[cursor] < threshold * 0.72);
          if (!previousStable) continue;
          const horizonEnd = findLastIndexAtOrBefore(frames, frames[index].time + 1.6);
          if (horizonEnd - index < 3) continue;
          const verification = colors.slice(index, horizonEnd + 1);
          const changed = verification
            .map((color, offset) => ({ color, offset, change: correctedChanges[index + offset] }))
            .filter((sample) => sample.change >= threshold && structuralChangeRatios[index + sample.offset] <= 0.26);
          if (changed.length < Math.max(3, Math.ceil(verification.length * 0.55))) continue;

          const stableSceneFrames = frames.slice(index, horizonEnd + 1)
            .filter((_, offset) => structuralChangeRatios[index + offset] <= 0.26).length;
          if (stableSceneFrames < Math.ceil(verification.length * 0.72)) continue;

          const tailStartTime = frames[horizonEnd].time - 0.62;
          const tail = changed.filter((sample) => frames[index + sample.offset].time >= tailStartTime);
          if (tail.length < 2) continue;
          const target = averageRgb(tail.map((sample) => sample.color));
          const targetDelta = computeColorDistance(target, baseline);
          const targetTolerance = Math.max(10, targetDelta * 0.42);
          const tailFrameCount = frames.slice(index, horizonEnd + 1)
            .filter((frame) => frame.time >= tailStartTime).length;
          const stableTargetFrames = tail.filter((sample) => computeColorDistance(sample.color, target) <= targetTolerance).length;
          if (targetDelta < threshold * 1.1 || stableTargetFrames < Math.max(2, Math.ceil(tailFrameCount * 0.55))) continue;

          const baselineLum = luminance(baseline);
          const targetLum = luminance(target);
          const lightRatio = targetLum / Math.max(1, baselineLum);
          const targetLooksElectronic = lightRatio >= 0.55 && lightRatio <= 3.2 &&
            Math.max(target.r, target.g, target.b) >= 45 &&
            (chroma(target) >= 8 || chroma(baseline) >= 8);
          if (!targetLooksElectronic) continue;

          const xNorm = x / width;
          const laneBoost = laneHintX === undefined
            ? 0
            : Math.max(0, 18 - Math.abs(xNorm - laneHintX) / 0.45 * 18);
          const expectedPenalty = expectedFinishTime === undefined
            ? 0
            : Math.min(24, Math.abs(frames[index].time - expectedFinishTime) * 4);
          const persistenceFrames = stableTargetFrames;
          const score = targetDelta + persistenceFrames * 5 + laneBoost + Math.max(0, chroma(target) - chroma(baseline)) * 0.3 - expectedPenalty;
          const confidence: Confidence = targetDelta >= Math.max(18, threshold * 1.65) && persistenceFrames >= 3
            ? "High"
            : "Medium";
          internal.push({
            x,
            y,
            radius,
            rawTime: roundTime(frames[index].time),
            confidence,
            score,
            before: baseline,
            after: target,
            persistenceFrames,
          });
          break;
        }
      }
    }
  }

  if (!internal.length) {
    return emptyDiscovery("No persistent localized color change was found in the upper timing-indicator band.");
  }

  const separated = selectSpatialCandidates(internal, width, height);
  const topScore = separated[0].score;
  const credible = separated.filter((candidate) => candidate.score >= topScore * 0.78);
  const selected = [...credible].sort((left, right) => left.rawTime - right.rawTime || right.score - left.score)[0];
  const halfSize = Math.max(2, selected.radius + 2);
  const zone: NormalizedZone = {
    id: "finishLight",
    label: "Auto-detected upper finish indicator",
    x1: clamp((selected.x - halfSize) / width, 0, 1),
    y1: clamp((selected.y - halfSize) / height, 0, 1),
    x2: clamp((selected.x + halfSize + 1) / width, 0, 1),
    y2: clamp((selected.y + halfSize + 1) / height, 0, 1),
  };
  const calibration: StartLightCalibration = {
    beforeStartRGB: selected.before,
    afterStartRGB: selected.after,
    colorDelta: roundTime(computeColorDistance(selected.before, selected.after)),
  };
  const candidates: DetectionCandidate[] = separated.slice(0, 5).map((candidate) => ({
    rawTime: candidate.rawTime,
    confidence: candidate.confidence,
    reason: "A tiny upper-wall patch changed to a new persistent electronic-light state.",
    score: roundTime(candidate.score),
    kind: "Upper finish indicator",
    method: "Perspective-aware upper finish-indicator discovery",
    rgb: candidate.after,
    distanceToBefore: roundTime(computeColorDistance(candidate.after, candidate.before)),
    distanceToAfter: 0,
    persistenceFrames: candidate.persistenceFrames,
  }));
  return {
    found: true,
    rawTime: selected.rawTime,
    confidence: selected.confidence,
    reason: "A perspective-aware scan found a persistent state change in the selected lane's upper timing-indicator band.",
    score: roundTime(selected.score),
    zone,
    calibration,
    candidates,
  };
}

/**
 * Finds physical top contact without pose inference. Static-wall pixels from
 * the early climb form a background reference. The athlete must enter the
 * selected lane's upper band, reach a clear vertical minimum, and then move
 * downward. Broad foreground occlusions are rejected before this trajectory is
 * considered.
 */
export function analyzeTopContactFrames(
  frames: TopFinishFrame[],
  laneHintX?: number,
): TopFinishDiscovery {
  if (frames.length < 7) return emptyDiscovery("Not enough stable frames were available for physical top-contact detection.");
  const { width, height } = frames[0];
  if (width < 8 || height < 8 || frames.some((frame) => frame.width !== width || frame.height !== height)) {
    return emptyDiscovery("Top-contact frames had inconsistent dimensions.");
  }
  const globalColors = frames.map(averageFrame);
  const baseline = frames[0];
  const [minXNorm, maxXNorm] = upperLaneBounds(laneHintX, 0.145);
  const minX = Math.max(1, Math.floor(width * minXNorm));
  const maxX = Math.min(width - 2, Math.ceil(width * maxXNorm));
  const minY = Math.max(1, Math.floor(height * 0.015));
  const maxY = Math.min(height - 2, Math.ceil(height * 0.32));
  const contactZone: NormalizedZone = {
    id: "finishLight",
    label: "Auto-detected physical finish band",
    x1: minX / width,
    y1: minY / height,
    x2: (maxX + 1) / width,
    y2: (maxY + 1) / height,
  };
  const regionWidth = maxX - minX + 1;
  const regionHeight = maxY - minY + 1;
  const regionPixels = Math.max(1, regionWidth * regionHeight);
  const minimumChangedPixels = Math.max(10, Math.ceil(regionPixels * 0.008));
  const observations: Array<{ time: number; topY: number; centroidX: number; centroidY: number; area: number }> = [];

  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const globalShift = {
      r: globalColors[frameIndex].r - globalColors[0].r,
      g: globalColors[frameIndex].g - globalColors[0].g,
      b: globalColors[frameIndex].b - globalColors[0].b,
    };
    const structuralRatio = frameWideStructuralChangeRatio(baseline, frame, globalColors[0], globalColors[frameIndex]);
    if (structuralRatio > 0.26) continue;
    const changedMask = new Uint8Array(regionPixels);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const offset = (y * width + x) * 4;
        const dr = Math.abs(((frame.data[offset] ?? 0) - (baseline.data[offset] ?? 0)) - globalShift.r);
        const dg = Math.abs(((frame.data[offset + 1] ?? 0) - (baseline.data[offset + 1] ?? 0)) - globalShift.g);
        const db = Math.abs(((frame.data[offset + 2] ?? 0) - (baseline.data[offset + 2] ?? 0)) - globalShift.b);
        if ((dr + dg + db) / 3 < 30) continue;
        changedMask[(y - minY) * regionWidth + (x - minX)] = 1;
      }
    }
    const components = connectedComponents(changedMask, regionWidth, regionHeight, minX, minY, minimumChangedPixels);
    for (const component of components) {
      const componentArea = component.ys.length / regionPixels;
      // A distant climber occupies a modest part of the upper lane. A spectator
      // leaning into the phone rapidly becomes a much larger component even
      // before the frame-wide occlusion threshold is crossed.
      if (componentArea > 0.2) continue;
      const sumX = component.xs.reduce((sum, x) => sum + x, 0);
      const sumY = component.ys.reduce((sum, y) => sum + y, 0);
      observations.push({
        time: frame.time,
        topY: robustComponentTopY(component.ys) / height,
        centroidX: sumX / component.xs.length / width,
        centroidY: sumY / component.ys.length / height,
        area: componentArea,
      });
    }
  }

  const movingObservations = observations.filter((observation) => !isAnchoredDisplayObservation(observation, observations));
  if (movingObservations.length < 5) {
    return emptyDiscovery("The athlete did not produce a continuous, occlusion-free upper-wall trajectory.");
  }
  const minimumTopY = Math.min(...movingObservations.map((observation) => observation.topY));
  if (minimumTopY > 0.12) {
    return emptyDiscovery("The selected athlete never reached the physical finish band.");
  }

  let selected: typeof observations[number] | undefined;
  let descentAmount = 0;
  for (let index = 0; index < movingObservations.length; index += 1) {
    const candidate = movingObservations[index];
    if (candidate.topY > minimumTopY + 0.012) continue;
    const before = movingObservations.filter((observation) =>
      observation.time < candidate.time && observation.time >= candidate.time - 2.2,
    );
    const after = movingObservations.filter((observation) =>
      observation.time > candidate.time && observation.time <= candidate.time + 1.8,
    );
    const comparableIdentity = (observation: typeof candidate) =>
      observation.area >= candidate.area * 0.35 &&
      observation.area <= candidate.area * 2.8 &&
      Math.abs(observation.centroidX - candidate.centroidX) <= 0.075;
    const comparableBefore = before.filter(comparableIdentity);
    const comparableAfter = after.filter(comparableIdentity);
    const orderedApproach = [...comparableBefore, candidate].sort((left, right) => left.time - right.time);
    const approachSpan = candidate.time - (orderedApproach[0]?.time ?? candidate.time);
    const meaningfulProgress = orderedApproach
      .slice(0, Math.max(1, Math.floor(orderedApproach.length / 2)))
      .some((observation) => observation.topY >= candidate.topY + 0.05);
    let upwardSteps = 0;
    for (let cursor = 1; cursor < orderedApproach.length; cursor += 1) {
      if (orderedApproach[cursor].topY <= orderedApproach[cursor - 1].topY + 0.018) upwardSteps += 1;
    }
    const sustainedAscent = orderedApproach.length >= 4 && approachSpan >= 0.8 && meaningfulProgress &&
      upwardSteps >= Math.ceil((orderedApproach.length - 1) * 0.6);
    if (!sustainedAscent || comparableAfter.length < 2) continue;
    const afterTop = median(comparableAfter.map((observation) => observation.topY));
    const afterCentroid = median(comparableAfter.map((observation) => observation.centroidY));
    descentAmount = Math.max(afterTop - candidate.topY, afterCentroid - candidate.centroidY);
    if (descentAmount < 0.035) continue;
    selected = candidate;
    break;
  }
  if (!selected) {
    const presence = movingObservations.find((observation) => observation.topY <= minimumTopY + 0.012);
    if (presence) {
      const candidate: DetectionCandidate = {
        rawTime: roundTime(presence.time),
        confidence: "Medium",
        reason: "The selected lane reached the physical finish band, but descent verification was obscured or incomplete.",
        score: roundTime((0.16 - presence.topY) * 400 + presence.area * 100),
        kind: "Unverified top presence",
        method: "Perspective-aware physical top-band presence",
        persistenceFrames: movingObservations.filter((observation) => Math.abs(observation.topY - presence.topY) <= 0.02).length,
      };
      return {
        found: false,
        rawTime: candidate.rawTime,
        confidence: "Medium",
        reason: "The athlete reached the finish band, but a clear downward reversal was not continuously visible.",
        score: candidate.score,
        zone: contactZone,
        candidates: [candidate],
      };
    }
    return emptyDiscovery("Upper-wall motion did not show a top reach followed by a clear descent.");
  }

  // Physical reach is an important review/fallback boundary, but without an
  // electronic reversal it must not become an authoritative official time.
  const confidence: Confidence = "Medium";
  const candidate: DetectionCandidate = {
    rawTime: roundTime(selected.time),
    confidence,
    reason: "The selected athlete reached the topmost observed position and then began a sustained descent.",
    score: roundTime((0.18 - selected.topY) * 500 + descentAmount * 300 + selected.area * 100),
    kind: "Physical top contact",
    method: "Perspective-aware top reach with downward-reversal verification",
    persistenceFrames: movingObservations.filter((observation) => Math.abs(observation.topY - selected!.topY) <= 0.02).length,
  };
  return {
    found: true,
    rawTime: candidate.rawTime,
    confidence,
    reason: "Finish was estimated from the athlete's top reach and verified by the subsequent descent.",
    score: candidate.score,
    zone: contactZone,
    candidates: [candidate],
  };
}

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  xOffset: number,
  yOffset: number,
  minimumArea: number,
): Array<{ xs: number[]; ys: number[] }> {
  const visited = new Uint8Array(mask.length);
  const components: Array<{ xs: number[]; ys: number[] }> = [];
  const directions = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      xs.push(x + xOffset);
      ys.push(y + yOffset);
      for (const [dx, dy] of directions) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (!mask[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    if (ys.length >= minimumArea) components.push({ xs, ys });
  }
  return components.sort((left, right) => right.ys.length - left.ys.length).slice(0, 8);
}

function isAnchoredDisplayObservation<T extends { time: number; topY: number; centroidX: number }>(
  observation: T,
  observations: T[],
): boolean {
  const neighbors = observations.filter((candidate) =>
    Math.abs(candidate.centroidX - observation.centroidX) <= 0.018 &&
    Math.abs(candidate.topY - observation.topY) <= 0.012,
  );
  if (neighbors.length < 9) return false;
  const times = neighbors.map((candidate) => candidate.time);
  return Math.max(...times) - Math.min(...times) >= 2.4;
}

function robustComponentTopY(ys: number[]): number {
  if (!ys.length) return 1;
  const rowCounts = new Map<number, number>();
  for (const y of ys) rowCounts.set(y, (rowCounts.get(y) ?? 0) + 1);
  const rows = Array.from(rowCounts.keys()).sort((left, right) => left - right);
  // A rope contributes only one or two changed pixels per row. Require a
  // three-row band with body-scale support before it can define vertical reach.
  const requiredBandPixels = Math.max(12, Math.ceil(ys.length * 0.1));
  for (const y of rows) {
    const bandPixels = (rowCounts.get(y) ?? 0) + (rowCounts.get(y + 1) ?? 0) + (rowCounts.get(y + 2) ?? 0);
    if (bandPixels >= requiredBandPixels) return y;
  }
  const sorted = [...ys].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.3))];
}

function upperLaneBounds(laneHintX: number | undefined, halfWidth: number): [number, number] {
  if (laneHintX === undefined) return [0.04, 0.96];
  // Phone cameras point upward, so parallel wall lanes converge toward the
  // image center. Map a lower sensor hint inward before searching the top.
  const upperCenter = 0.5 + (laneHintX - 0.5) * 0.42;
  return [clamp(upperCenter - halfWidth, 0.02, 0.98), clamp(upperCenter + halfWidth, 0.02, 0.98)];
}

export function analyzeTopFinishColorSamples(
  samples: TopFinishColorSample[],
  calibration: StartLightCalibration,
  expectedFinishTime?: number,
): StartSignalDetectionResult {
  if (samples.length < 8 || !calibration.beforeStartRGB || !calibration.afterStartRGB) {
    return emptyResult("Not enough refined upper-indicator samples were available.");
  }
  const source = calibration.beforeStartRGB;
  const target = calibration.afterStartRGB;
  const vector = { r: target.r - source.r, g: target.g - source.g, b: target.b - source.b };
  const magnitudeSquared = vector.r ** 2 + vector.g ** 2 + vector.b ** 2;
  if (magnitudeSquared < 25) return emptyResult("The upper-indicator states were too similar to refine finish timing.");

  const baselineCount = Math.min(12, Math.max(4, Math.floor(samples.length * 0.22)));
  const projection = samples.map((sample) =>
    ((sample.averageRgb.r - source.r) * vector.r +
      (sample.averageRgb.g - source.g) * vector.g +
      (sample.averageRgb.b - source.b) * vector.b) / magnitudeSquared,
  );
  const baselineProjection = median(projection.slice(0, baselineCount));
  const normalized = projection.map((value) => value - baselineProjection);
  const frameInterval = median(samples.slice(1).map((sample, index) => sample.time - samples[index].time));
  const candidates: DetectionCandidate[] = [];

  for (let index = baselineCount; index < samples.length - 2; index += 1) {
    if (normalized[index] < 0.16) continue;
    if (![index - 2, index - 1].every((cursor) => normalized[cursor] < 0.12)) continue;
    const horizonEnd = findLastSampleIndexAtOrBefore(samples, samples[index].time + 0.95);
    const verification = normalized.slice(index, horizonEnd + 1);
    const targetFrames = verification.filter((value) => value >= 0.42).length;
    if (targetFrames < Math.max(3, Math.ceil(verification.length * 0.55)) || Math.max(...verification) < 0.7) continue;

    let onset = index;
    let gaps = 0;
    for (let cursor = index - 1; cursor >= baselineCount && samples[cursor].time >= samples[index].time - 0.34; cursor -= 1) {
      if (normalized[cursor] >= 0.08) {
        onset = cursor;
        gaps = 0;
      } else if (++gaps > 1) {
        break;
      }
    }
    const rawTime = roundTime(samples[onset].time);
    const expectedPenalty = expectedFinishTime === undefined ? 0 : Math.abs(rawTime - expectedFinishTime) * 2;
    const peak = Math.max(...verification);
    const confidence: Confidence = peak >= 0.9 && targetFrames >= Math.ceil(verification.length * 0.62) ? "High" : "Medium";
    candidates.push({
      rawTime,
      confidence,
      reason: onset < index
        ? "The first faint upper-indicator pixels were connected to its verified settled state."
        : "The upper indicator changed and remained in its verified finish state.",
      score: roundTime(peak * 100 + targetFrames - expectedPenalty),
      kind: "Upper finish indicator",
      method: "Refined perspective-aware upper finish timing",
      rgb: samples[onset].averageRgb,
      distanceToBefore: roundTime(computeColorDistance(samples[onset].averageRgb, source)),
      distanceToAfter: roundTime(computeColorDistance(samples[onset].averageRgb, target)),
      persistenceFrames: targetFrames,
    });
  }

  if (!candidates.length) return emptyResult("The discovered upper indicator did not produce a frame-level persistent finish transition.");
  const selected = [...candidates].sort((left, right) => left.rawTime - right.rawTime)[0];
  return resultFromCandidates(selected, candidates, samples, calibration, frameInterval);
}

function resultFromCandidates(
  selected: DetectionCandidate,
  candidates: DetectionCandidate[],
  samples: TopFinishColorSample[],
  calibration: StartLightCalibration,
  frameInterval: number,
): StartSignalDetectionResult {
  const debugSamples = samples.map((sample) => ({
    time: sample.time,
    averageRgb: sample.averageRgb,
    colorDistance: computeColorDistance(sample.averageRgb, calibration.beforeStartRGB!),
    distanceToBefore: computeColorDistance(sample.averageRgb, calibration.beforeStartRGB!),
    distanceToAfter: computeColorDistance(sample.averageRgb, calibration.afterStartRGB!),
    greenScore: sample.averageRgb.g - Math.max(sample.averageRgb.r, sample.averageRgb.b),
    blueScore: sample.averageRgb.b - Math.max(sample.averageRgb.r, sample.averageRgb.g),
  }));
  return {
    detected: true,
    rawTime: selected.rawTime,
    confidence: selected.confidence,
    reason: `Finish detected from the perspective-aware upper indicator at ${selected.rawTime.toFixed(3)}s (${Math.round(1 / Math.max(frameInterval, 1 / 120))} fps refinement).`,
    threshold: 0.16,
    candidates: [selected, ...candidates.filter((candidate) => candidate !== selected)].slice(0, 5),
    debug: {
      zoneExists: true,
      framesSampled: samples.length,
      calibration,
      detectionMethod: "Perspective-aware upper finish-indicator discovery and refinement",
      maxColorDistance: Math.max(...debugSamples.map((sample) => sample.colorDistance)),
      threshold: 0.16,
      detectedCrossings: candidates.map((candidate) => ({ time: candidate.rawTime, colorDistance: candidate.score })),
      firstThresholdCrossingTime: selected.rawTime,
      selectedCandidateTime: selected.rawTime,
      selectedCandidateReason: selected.reason,
      topCandidates: candidates,
      detectedRawTime: selected.rawTime,
      samples: debugSamples,
    },
  };
}

function discoveryToResult(discovery: TopFinishDiscovery): StartSignalDetectionResult {
  if (!discovery.found || discovery.rawTime === undefined || !discovery.zone || !discovery.calibration) {
    return emptyResult(discovery.reason);
  }
  const selected = discovery.candidates[0];
  return {
    detected: true,
    rawTime: discovery.rawTime,
    confidence: discovery.confidence,
    reason: discovery.reason,
    threshold: 0,
    candidates: discovery.candidates,
    debug: {
      zoneExists: true,
      normalizedZone: discovery.zone,
      framesSampled: 0,
      calibration: discovery.calibration,
      detectionMethod: "Perspective-aware upper finish-indicator discovery (coarse)",
      maxColorDistance: discovery.calibration.colorDelta ?? 0,
      threshold: 0,
      detectedCrossings: discovery.candidates.map((candidate) => ({ time: candidate.rawTime, colorDistance: candidate.score })),
      firstThresholdCrossingTime: selected?.rawTime,
      selectedCandidateTime: discovery.rawTime,
      selectedCandidateReason: discovery.reason,
      topCandidates: discovery.candidates,
      detectedRawTime: discovery.rawTime,
      samples: [],
    },
  };
}

function topContactToResult(discovery: TopFinishDiscovery, refinedFrameCount: number): StartSignalDetectionResult {
  if (!discovery.found || discovery.rawTime === undefined || !discovery.zone) return emptyResult(discovery.reason);
  const selected = discovery.candidates[0];
  return {
    detected: true,
    rawTime: discovery.rawTime,
    confidence: discovery.confidence,
    reason: `Finish estimated at ${discovery.rawTime.toFixed(3)}s from physical top reach with downward-reversal verification.`,
    threshold: 0,
    candidates: discovery.candidates,
    debug: {
      zoneExists: true,
      normalizedZone: discovery.zone,
      framesSampled: refinedFrameCount,
      detectionMethod: "Perspective-aware physical top contact and descent verification",
      maxColorDistance: 0,
      threshold: 0,
      detectedCrossings: [{ time: discovery.rawTime, colorDistance: selected?.score ?? 0 }],
      firstThresholdCrossingTime: discovery.rawTime,
      selectedCandidateTime: discovery.rawTime,
      selectedCandidateReason: selected?.reason ?? discovery.reason,
      topCandidates: discovery.candidates,
      detectedRawTime: discovery.rawTime,
      samples: [],
    },
  };
}

function topPresenceToResult(
  candidate: DetectionCandidate,
  zone: NormalizedZone | undefined,
  refinedFrameCount: number,
  rejectedLaterReset: boolean,
): StartSignalDetectionResult {
  const reason = rejectedLaterReset
    ? `The athlete reached the physical finish band at ${candidate.rawTime.toFixed(3)}s; a much later electronic change was classified as timing-system reset. Review the exact contact frame.`
    : `The athlete reached the physical finish band at ${candidate.rawTime.toFixed(3)}s, but descent verification was partly obscured. Review the exact contact frame.`;
  return {
    detected: true,
    rawTime: candidate.rawTime,
    confidence: "Medium",
    reason,
    threshold: 0,
    candidates: [{ ...candidate, confidence: "Medium", reason }],
    debug: {
      zoneExists: Boolean(zone),
      normalizedZone: zone,
      framesSampled: refinedFrameCount,
      detectionMethod: "Perspective-aware physical top presence with late-reset rejection",
      maxColorDistance: 0,
      threshold: 0,
      detectedCrossings: [{ time: candidate.rawTime, colorDistance: candidate.score }],
      firstThresholdCrossingTime: candidate.rawTime,
      selectedCandidateTime: candidate.rawTime,
      selectedCandidateReason: reason,
      topCandidates: [candidate],
      detectedRawTime: candidate.rawTime,
      samples: [],
    },
  };
}

async function captureFrames(
  video: HTMLVideoElement,
  times: number[],
  signal: AbortSignal | undefined,
  onProgress: (processed: number, total: number) => void,
): Promise<TopFinishFrame[]> {
  const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth, MAX_SCAN_HEIGHT / video.videoHeight);
  const width = Math.max(8, Math.round(video.videoWidth * scale));
  const height = Math.max(8, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context is unavailable for upper finish-indicator discovery.");
  const frames: TopFinishFrame[] = [];
  for (let index = 0; index < times.length; index += 1) {
    throwIfCancelled(signal);
    await seekTo(video, times[index]);
    context.drawImage(video, 0, 0, width, height);
    frames.push({ time: roundTime(video.currentTime), width, height, data: context.getImageData(0, 0, width, height).data });
    onProgress(index + 1, times.length);
    if (index % 6 === 5) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}

function selectSpatialCandidates<T extends { x: number; y: number; score: number }>(candidates: T[], width: number, height: number): T[] {
  const selected: T[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    if (selected.some((item) => Math.hypot((item.x - candidate.x) / width, (item.y - candidate.y) / height) < 0.035)) continue;
    selected.push(candidate);
    if (selected.length >= 8) break;
  }
  return selected;
}

function averagePatch(frame: TopFinishFrame, centerX: number, centerY: number, radius: number): RGB {
  let r = 0; let g = 0; let b = 0; let count = 0;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const offset = (y * frame.width + x) * 4;
      r += frame.data[offset] ?? 0;
      g += frame.data[offset + 1] ?? 0;
      b += frame.data[offset + 2] ?? 0;
      count += 1;
    }
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function averageFrame(frame: TopFinishFrame): RGB {
  let r = 0; let g = 0; let b = 0; let count = 0;
  for (let index = 0; index < frame.data.length; index += 4) {
    r += frame.data[index] ?? 0; g += frame.data[index + 1] ?? 0; b += frame.data[index + 2] ?? 0; count += 1;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function frameWideStructuralChangeRatio(
  baseline: TopFinishFrame,
  current: TopFinishFrame,
  baselineGlobal: RGB,
  currentGlobal: RGB,
): number {
  const length = Math.min(baseline.data.length, current.data.length);
  if (!length) return 1;
  const globalShift = {
    r: currentGlobal.r - baselineGlobal.r,
    g: currentGlobal.g - baselineGlobal.g,
    b: currentGlobal.b - baselineGlobal.b,
  };
  let changed = 0;
  let count = 0;
  for (let index = 0; index < length; index += 4) {
    const dr = Math.abs(((current.data[index] ?? 0) - (baseline.data[index] ?? 0)) - globalShift.r);
    const dg = Math.abs(((current.data[index + 1] ?? 0) - (baseline.data[index + 1] ?? 0)) - globalShift.g);
    const db = Math.abs(((current.data[index + 2] ?? 0) - (baseline.data[index + 2] ?? 0)) - globalShift.b);
    if ((dr + dg + db) / 3 >= 28) changed += 1;
    count += 1;
  }
  return changed / Math.max(1, count);
}

function averageRgb(colors: RGB[]): RGB {
  return {
    r: Math.round(colors.reduce((sum, color) => sum + color.r, 0) / Math.max(1, colors.length)),
    g: Math.round(colors.reduce((sum, color) => sum + color.g, 0) / Math.max(1, colors.length)),
    b: Math.round(colors.reduce((sum, color) => sum + color.b, 0) / Math.max(1, colors.length)),
  };
}

function emptyDiscovery(reason: string): TopFinishDiscovery {
  return { found: false, confidence: "None", reason, score: 0, candidates: [] };
}

function emptyResult(reason: string): StartSignalDetectionResult {
  return {
    detected: false,
    confidence: "None",
    reason,
    threshold: 0,
    candidates: [],
    debug: {
      zoneExists: false,
      framesSampled: 0,
      detectionMethod: "Perspective-aware upper finish-indicator discovery",
      maxColorDistance: 0,
      threshold: 0,
      detectedCrossings: [],
      samples: [],
      failureReason: reason,
    },
  };
}

function findLastIndexAtOrBefore(frames: TopFinishFrame[], time: number): number {
  for (let index = frames.length - 1; index >= 0; index -= 1) if (frames[index].time <= time) return index;
  return 0;
}

function findLastSampleIndexAtOrBefore(samples: TopFinishColorSample[], time: number): number {
  for (let index = samples.length - 1; index >= 0; index -= 1) if (samples[index].time <= time) return index;
  return 0;
}

function luminance(rgb: RGB): number { return rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722; }
function chroma(rgb: RGB): number { return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Upper finish-indicator detection cancelled.");
  error.name = "AbortError";
  throw error;
}
