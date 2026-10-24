import type { DetectionCandidate, NormalizedZone, RGB, StartSignalDetectionResult } from "../types";
import { readDecodedVideoFrameTime, sourceFrameStepTarget, type DecodedVideoFrameTime } from "./decodedVideoFrame";
import { analyzeReviewedFinishColorSamples as analyzeTopFinishColorSamples } from "./detectTopFinishSignal";
import { finishReviewWindow } from "./finishReview";
import { normalizedZoneToPixelRect, seekToFrameObservation } from "./videoFrameSampler";

/** Bounded image-tracking policies, not physical measurement-error bounds. */
export const TRACKED_INDICATOR_POLICY = Object.freeze({
  maxLongEdge: 960, patchRadius: 3, minimumCornerEigenvalue: 120,
  minimumPatchVariance: 25, contextPaddingMin: 32, contextPaddingMax: 96,
  contextPaddingSensorFactor: 3, maxFeatures: 32, minimumAnchorFeatures: 8,
  featureMinimumSeparation: 8, maxFeaturesPerQuadrant: 8,
  maximumAnchorCandidates: 256,
  maximumAdjacentSearchPixels: 18,
  minimumCorrelation: .82, minimumDistinctRunnerUpGap: .08,
  runnerUpSeparationPixels: 3, minimumInliers: 8,
  minimumRetainedAnchorFraction: .4, minimumInlierFraction: .6,
  inlierResidualPixels: 1.5, minimumSupportingQuadrants: 3,
  minimumContextSpanPixels: 12, maxFramesPerDirection: 180,
  maxAdjacentNativeGapSeconds: .15,
});

export interface IndicatorTrackingFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
interface ContextFeature {
  x: number; y: number; quadrant: number; descriptor: Float32Array;
}
export interface IndicatorContextModel {
  width: number; height: number; zone: NormalizedZone;
  features: ReadonlyArray<ContextFeature>;
  initializationMs: number;
  testedAnchorCandidates: number;
}
export interface IndicatorContextMatch {
  tracked: boolean;
  dx: number; dy: number;
  region?: NormalizedZone;
  anchorFeatures: number;
  matchedFeatures: number;
  inliers: number;
  supportingQuadrants: number;
  elapsedMs: number;
  denseSearchUsed: boolean;
  reason: string;
}
export interface TrackedFinishIndicatorFrameToken {
  readonly rawTime: number;
  readonly cursorTime: number;
  readonly sourceFrameDurationSeconds: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}
export interface TrackedFinishIndicatorAnchor extends TrackedFinishIndicatorFrameToken { readonly region: Readonly<NormalizedZone>; }
export interface TrackedIndicatorObservation {
  rawTime: number;
  cursorTime: number;
  sourceFrameDurationSeconds: number;
  region: NormalizedZone;
  averageRgb: RGB;
  inliers: number;
  matchedFeatures: number;
  trackingElapsedMs?: number;
  denseSearchUsed?: boolean;
}
export interface TrackedFinishIndicatorReview {
  authority: "navigation-only";
  automaticAcceptanceAllowed: false;
  createsLaneIdentity: false;
  status: "complete" | "partial" | "failed";
  confidence: "Low" | "None";
  anchor: TrackedFinishIndicatorAnchor;
  requestedWindow: { start: number; end: number };
  observedWindow?: { start: number; end: number };
  observations: TrackedIndicatorObservation[];
  boundaryNotes: string[];
  stops: Array<{ direction: -1 | 1; lastObservedRawTime: number; reason: string; trackingElapsedMs?: number; denseSearchUsed?: boolean }>;
  initializationMs?: number;
  elapsedMs?: number;
  suggestedRawTime?: number;
  result: StartSignalDetectionResult;
  reason: string;
}

interface CapturedIndicatorFrame {
  video: HTMLVideoElement; source: string; frame: IndicatorTrackingFrame;
}
const capturedFrames = new WeakMap<TrackedFinishIndicatorFrameToken, CapturedIndicatorFrame>();
const capturedAnchors = new WeakMap<TrackedFinishIndicatorAnchor, CapturedIndicatorFrame>();

/** Capture on Mark, before the region is drawn on the displayed snapshot. */
export function captureTrackedFinishIndicatorFrame(video: HTMLVideoElement): TrackedFinishIndicatorFrameToken {
  if (!video.paused || video.seeking || video.readyState < 2) {
    throw new Error("Pause the video and mark the finish indicator on this frame.");
  }
  const decoded = readDecodedVideoFrameTime(video);
  if (!decoded || !validDuration(decoded.durationSeconds)) {
    throw new Error("Native frame timing is unavailable. Keep using manual frame review for this recording.");
  }
  const frame = captureTrackingFrame(video);
  const token = Object.freeze({ rawTime: decoded.mediaTime, cursorTime: video.currentTime,
    sourceFrameDurationSeconds: decoded.durationSeconds, sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight });
  capturedFrames.set(token, { video, source: video.src, frame });
  return token;
}

/** Bind on Apply to the original snapshot. Cursor movement while drawing does
 * not reinterpret the region; source replacement invalidates the snapshot. */
export function bindTrackedFinishIndicatorAnchor(token: TrackedFinishIndicatorFrameToken, region: NormalizedZone): TrackedFinishIndicatorAnchor {
  const capture = capturedFrames.get(token);
  if (!capture || capture.video.src !== capture.source || capture.video.videoWidth !== token.sourceWidth ||
      capture.video.videoHeight !== token.sourceHeight) throw new Error("The marking frame changed recordings. Capture and mark the indicator again.");
  if (!validRegion(region) || region.id !== "finishIndicator") throw new Error("Draw the indicator area inside the captured marking frame.");
  const anchor = Object.freeze({ ...token, region: Object.freeze({ ...region }) });
  capturedAnchors.set(anchor, capture);
  return anchor;
}

/** Convenience for callers that already know the region at capture time. The
 * drawing UI must use the two-stage capture-on-Mark / bind-on-Apply API above. */
export function captureTrackedFinishIndicatorAnchor(video: HTMLVideoElement, region: NormalizedZone): TrackedFinishIndicatorAnchor {
  return bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), region);
}

export function isTrackedFinishIndicatorAnchorCurrent(video: HTMLVideoElement, anchor: TrackedFinishIndicatorAnchor): boolean {
  const capture = capturedAnchors.get(anchor);
  return Boolean(capture && capture.video === video && capture.source === video.src &&
    anchor.sourceWidth === video.videoWidth && anchor.sourceHeight === video.videoHeight);
}

/** Select fixed original-frame context, excluding every descriptor that could
 * include the light itself. Its state change must not steer spatial tracking. */
export function buildIndicatorContextModel(frame: IndicatorTrackingFrame, zone: NormalizedZone): { model?: IndicatorContextModel; reason: string; initializationMs: number } {
  const began = performance.now();
  if (!validFrame(frame) || !validRegion(zone)) return { reason: "The selected frame or indicator area was invalid.", initializationMs: performance.now() - began };
  const policy = TRACKED_INDICATOR_POLICY;
  const rect = normalizedZoneToPixelRect(zone, frame.width, frame.height, "cover");
  const pad = Math.min(policy.contextPaddingMax, Math.max(policy.contextPaddingMin,
    Math.max(rect.width, rect.height) * policy.contextPaddingSensorFactor));
  const gray = grayscale(frame), margin = policy.patchRadius + 1;
  const bounds = { x1: Math.max(margin, rect.x - pad), x2: Math.min(frame.width - margin - 1, rect.x + rect.width + pad),
    y1: Math.max(margin, rect.y - pad), y2: Math.min(frame.height - margin - 1, rect.y + rect.height + pad) };
  const candidates: Array<{ x: number; y: number; score: number; quadrant: number }> = [];
  for (let y = Math.ceil(bounds.y1); y <= bounds.y2; y += 2) for (let x = Math.ceil(bounds.x1); x <= bounds.x2; x += 2) {
    if (x >= rect.x - margin && x < rect.x + rect.width + margin &&
        y >= rect.y - margin && y < rect.y + rect.height + margin) continue;
    const score = cornerScore(gray, frame.width, x, y);
    if (score < policy.minimumCornerEigenvalue) continue;
    const quadrant = (x >= rect.x + rect.width / 2 ? 1 : 0) + (y >= rect.y + rect.height / 2 ? 2 : 0);
    candidates.push({ x, y, score, quadrant });
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const features: ContextFeature[] = [], counts = [0, 0, 0, 0];
  let examined = 0;
  for (const point of candidates) {
    if (counts[point.quadrant] >= policy.maxFeaturesPerQuadrant || features.some(other =>
      Math.hypot(other.x - point.x, other.y - point.y) < policy.featureMinimumSeparation)) continue;
    const descriptor = normalizedPatch(gray, frame.width, frame.height, point.x, point.y);
    if (!descriptor) continue;
    if (++examined > policy.maximumAnchorCandidates) break;
    const self = matchFeature({ x: point.x, y: point.y, quadrant: point.quadrant, descriptor },
      gray, frame.width, frame.height, { dx: 0, dy: 0 });
    if (!self || self.x !== point.x || self.y !== point.y) continue;
    features.push({ x: point.x, y: point.y, quadrant: point.quadrant, descriptor });
    counts[point.quadrant]++;
    if (features.length >= policy.maxFeatures) break;
  }
  if (features.length < policy.minimumAnchorFeatures || counts.filter(count => count > 0).length < policy.minimumSupportingQuadrants) {
    return { reason: "Too little textured context surrounds this indicator. Mark a clearer sensor frame; tracking cannot establish an anchor.", initializationMs: performance.now() - began };
  }
  return { model: { width: frame.width, height: frame.height, zone: { ...zone }, features,
    initializationMs: performance.now() - began, testedAnchorCandidates: Math.min(examined, policy.maximumAnchorCandidates) },
    reason: "Original-frame context was captured outside the marked light.", initializationMs: performance.now() - began };
}

/** Direct matches to the original anchor prevent cumulative template drift. */
export function trackIndicatorContext(model: IndicatorContextModel, frame: IndicatorTrackingFrame,
  previousOffset: { dx: number; dy: number } = { dx: 0, dy: 0 }): IndicatorContextMatch {
  const began = performance.now();
  let searched = false;
  const failed = (reason: string, matchedFeatures = 0, inliers = 0, supportingQuadrants = 0): IndicatorContextMatch =>
    ({ tracked: false, dx: previousOffset.dx, dy: previousOffset.dy, anchorFeatures: model.features.length,
      matchedFeatures, inliers, supportingQuadrants, reason, elapsedMs: performance.now() - began, denseSearchUsed: searched });
  if (!validFrame(frame) || frame.width !== model.width || frame.height !== model.height ||
      ![previousOffset.dx, previousOffset.dy].every(Number.isFinite)) return failed("Tracking frame dimensions or previous position changed.");
  const gray = grayscale(frame);
  searched = true;
  const attempt = (): IndicatorContextMatch => {
    const matches: Array<{ feature: ContextFeature; dx: number; dy: number }> = [];
    for (const feature of model.features) {
      const match = matchFeature(feature, gray, frame.width, frame.height, previousOffset);
      if (match) matches.push({ feature, dx: match.x - feature.x, dy: match.y - feature.y });
    }
    if (matches.length < TRACKED_INDICATOR_POLICY.minimumInliers) return failed("Context patches were lost or ambiguous; no jump to another region was attempted.", matches.length);
    const dx = median(matches.map(match => match.dx)), dy = median(matches.map(match => match.dy));
    const inliers = matches.filter(match => Math.hypot(match.dx - dx, match.dy - dy) <= TRACKED_INDICATOR_POLICY.inlierResidualPixels);
    const quadrants = new Set(inliers.map(match => match.feature.quadrant)).size;
    const spanX = range(inliers.map(match => match.feature.x)), spanY = range(inliers.map(match => match.feature.y));
    if (inliers.length < Math.max(TRACKED_INDICATOR_POLICY.minimumInliers,
        Math.ceil(model.features.length * TRACKED_INDICATOR_POLICY.minimumRetainedAnchorFraction)) ||
        inliers.length / matches.length < TRACKED_INDICATOR_POLICY.minimumInlierFraction ||
        quadrants < TRACKED_INDICATOR_POLICY.minimumSupportingQuadrants ||
        Math.min(spanX, spanY) < TRACKED_INDICATOR_POLICY.minimumContextSpanPixels) {
      return failed("The surviving context did not agree across enough of the sensor surroundings.", matches.length, inliers.length, quadrants);
    }
    const actualDx = median(inliers.map(match => match.dx)), actualDy = median(inliers.map(match => match.dy));
    const region = { ...model.zone, x1: model.zone.x1 + actualDx / frame.width, x2: model.zone.x2 + actualDx / frame.width,
      y1: model.zone.y1 + actualDy / frame.height, y2: model.zone.y2 + actualDy / frame.height };
    if (!validRegion(region)) return failed("The marked indicator moved outside the observed image.", matches.length, inliers.length, quadrants);
    return { tracked: true, dx: actualDx, dy: actualDy, region, anchorFeatures: model.features.length,
      matchedFeatures: matches.length, inliers: inliers.length, supportingQuadrants: quadrants,
      reason: "Original surrounding context retained a unique, spatially distributed translation match.",
      elapsedMs: performance.now() - began, denseSearchUsed: true };
  };
  return attempt();
}

/** Only an anchored contiguous observation span is returned. A tracking loss
 * stops that direction; it never authorizes a scene override or auto Finish. */
export async function scanTrackedFinishIndicatorReview(options: {
  video: HTMLVideoElement; anchor: TrackedFinishIndicatorAnchor; startSignal?: number | null;
  signal?: AbortSignal; isCurrent?: () => boolean; onProgress?: (message: string) => void;
}): Promise<TrackedFinishIndicatorReview> {
  const began = performance.now();
  const { video, anchor, signal } = options;
  const capture = capturedAnchors.get(anchor);
  if (!capture) throw new Error("Mark this indicator again on a paused native source frame. A saved area has no tracking anchor.");
  const check = () => {
    if (signal?.aborted || options.isCurrent?.() === false || !isTrackedFinishIndicatorAnchorCurrent(video, anchor)) {
      const error = new Error("Tracked indicator review cancelled or its original source changed."); error.name = "AbortError"; throw error;
    }
  };
  check();
  const window = finishReviewWindow(anchor.rawTime, video.duration, options.startSignal);
  if (!window) throw new Error("The marked frame has no usable review window.");
  options.onProgress?.("Checking the marked frame's surrounding context…");
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  check();
  const modelResult = buildIndicatorContextModel(capture.frame, anchor.region);
  check();
  const stops: TrackedFinishIndicatorReview["stops"] = [];
  const boundaryNotes: string[] = [];
  const observations: TrackedIndicatorObservation[] = [];
  if (!modelResult.model) return { ...reviewOutcome(anchor, window, observations, stops, modelResult.reason),
    initializationMs: modelResult.initializationMs, elapsedMs: performance.now() - began };
  const model = modelResult.model;
  observations.push({ rawTime: anchor.rawTime, cursorTime: anchor.cursorTime,
    sourceFrameDurationSeconds: anchor.sourceFrameDurationSeconds, region: { ...anchor.region },
    averageRgb: averageRegion(capture.frame, anchor.region), inliers: model.features.length, matchedFeatures: model.features.length });
  for (const direction of [-1, 1] as const) {
    let previous: DecodedVideoFrameTime = { mediaTime: anchor.rawTime, cursorTime: anchor.cursorTime,
      durationSeconds: anchor.sourceFrameDurationSeconds, source: capture.source, method: "video-frame" };
    let offset = { dx: 0, dy: 0 }, reachedBoundary = false;
    for (let index = 0; index < TRACKED_INDICATOR_POLICY.maxFramesPerDirection; index++) {
      check();
      if (direction === -1 && previous.mediaTime <= window.start ||
          direction === 1 && previous.mediaTime + previous.durationSeconds! >= window.end) { reachedBoundary = true; break; }
      const target = sourceFrameStepTarget(previous, video.duration, direction);
      if (target === undefined) { stops.push({ direction, lastObservedRawTime: previous.mediaTime, reason: "Native source-frame duration became unavailable." }); break; }
      if (target < window.start || target > window.end) { reachedBoundary = true; break; }
      let observation: Awaited<ReturnType<typeof seekToFrameObservation>>;
      try { observation = await seekToFrameObservation(video, target, { exact: true, signal }); }
      catch (error) {
        check();
        if (error instanceof Error && error.name === "AbortError") throw error;
        stops.push({ direction, lastObservedRawTime: previous.mediaTime, reason: "The next source frame could not be observed; missing pixels were not filled." });
        break;
      }
      check();
      const decoded = observation.decoded;
      if (!decoded || !validDuration(decoded.durationSeconds) || decoded.mediaTime * direction <= previous.mediaTime * direction ||
          decoded.source !== capture.source || Math.abs(decoded.mediaTime - previous.mediaTime) > TRACKED_INDICATOR_POLICY.maxAdjacentNativeGapSeconds) {
        stops.push({ direction, lastObservedRawTime: previous.mediaTime, reason: "Native source clocks did not form an adjacent usable observation sequence." }); break;
      }
      if (decoded.mediaTime < window.start || decoded.mediaTime > window.end) {
        boundaryNotes.push(`A decoded frame beginning at ${decoded.mediaTime.toFixed(6)}s lay outside the requested timestamp window and was excluded.`);
        reachedBoundary = true; break;
      }
      const expectedStep = direction === 1 ? previous.durationSeconds! : decoded.durationSeconds;
      if (Math.abs(Math.abs(decoded.mediaTime - previous.mediaTime) - expectedStep) > Math.max(.000002, expectedStep / 100)) {
        stops.push({ direction, lastObservedRawTime: previous.mediaTime, reason: "A source-frame interval was skipped or its duration did not agree; no contiguous tracking span was claimed." }); break;
      }
      const frame = captureTrackingFrame(video);
      check();
      const match = trackIndicatorContext(model, frame, offset);
      if (!match.tracked || !match.region) { stops.push({ direction, lastObservedRawTime: previous.mediaTime,
        reason: match.reason, trackingElapsedMs: match.elapsedMs, denseSearchUsed: match.denseSearchUsed }); break; }
      observations.push({ rawTime: decoded.mediaTime, cursorTime: observation.cursorTime,
        sourceFrameDurationSeconds: decoded.durationSeconds, region: match.region,
        averageRgb: averageRegion(frame, match.region), inliers: match.inliers, matchedFeatures: match.matchedFeatures,
        trackingElapsedMs: match.elapsedMs, denseSearchUsed: match.denseSearchUsed });
      offset = { dx: match.dx, dy: match.dy }; previous = decoded;
      options.onProgress?.(`Tracking marked indicator context: ${observations.length} native frames…`);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      check();
    }
    if (!reachedBoundary && !stops.some(stop => stop.direction === direction)) stops.push({ direction,
      lastObservedRawTime: previous.mediaTime, reason: "The bounded native-frame tracking budget was reached." });
  }
  check();
  observations.sort((a, b) => a.rawTime - b.rawTime);
  return { ...reviewOutcome(anchor, window, observations, stops, undefined, boundaryNotes),
    initializationMs: model.initializationMs, elapsedMs: performance.now() - began };
}

function reviewOutcome(anchor: TrackedFinishIndicatorAnchor, requestedWindow: { start: number; end: number },
  observations: TrackedIndicatorObservation[], stops: TrackedFinishIndicatorReview["stops"], unavailable?: string, boundaryNotes: string[] = []): TrackedFinishIndicatorReview {
  const reason = unavailable ?? (stops.length
    ? "Only the contiguous tracked span around the marked frame was observed. Tracking stopped at a cut, occlusion, ambiguity or unsupported motion; inspect the candidate manually."
    : "The marked sensor's surrounding context was tracked across the source-frame timestamps inside the review window. This is unverified navigation, not lane identity or finish-pad contact.");
  const before = meanColor(observations.slice(0, 8)), after = meanColor(observations.slice(-8));
  const analyzed = observations.length >= 8 ? analyzeTopFinishColorSamples(observations.map(sample => ({ time: sample.rawTime,
    cursorTime: sample.cursorTime, sourceFrameDurationSeconds: sample.sourceFrameDurationSeconds,
    timestampMethod: "video-frame", averageRgb: sample.averageRgb })), { beforeStartRGB: before, afterStartRGB: after }) : undefined;
  const candidates: DetectionCandidate[] = (analyzed?.candidates ?? []).map(candidate => ({ ...candidate, confidence: "Low",
    reason: `Manually anchored, context-tracked indicator; frame review required. ${reason} ${candidate.reason}` }));
  const suggestedRawTime = candidates[0]?.rawTime;
  const result: StartSignalDetectionResult = { detected: false, confidence: candidates.length ? "Low" : "None", reason,
    threshold: analyzed?.threshold ?? 0, candidates, debug: { ...(analyzed?.debug ?? { zoneExists: false, framesSampled: observations.length,
      detectionMethod: "Tracked manual indicator review", maxColorDistance: 0, threshold: 0, detectedCrossings: [], samples: [] }),
      detectionMethod: "Tracked manually selected indicator review", detectedRawTime: undefined,
      selectedCandidateTime: suggestedRawTime, selectedCandidateReason: reason, topCandidates: candidates } };
  return { authority: "navigation-only", automaticAcceptanceAllowed: false, createsLaneIdentity: false,
    status: unavailable || observations.length < 8 ? "failed" : stops.length ? "partial" : "complete",
    confidence: candidates.length ? "Low" : "None", anchor, requestedWindow,
    observedWindow: observations.length ? { start: observations[0].rawTime, end: observations[observations.length - 1].rawTime } : undefined,
    observations, boundaryNotes, stops, suggestedRawTime, result, reason };
}

function captureTrackingFrame(video: HTMLVideoElement): IndicatorTrackingFrame {
  const scale = Math.min(1, TRACKED_INDICATOR_POLICY.maxLongEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("The indicator tracking canvas is unavailable.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

function grayscale(frame: IndicatorTrackingFrame): Float32Array {
  const gray = new Float32Array(frame.width * frame.height);
  for (let i = 0; i < gray.length; i++) gray[i] = frame.data[i * 4] * .299 + frame.data[i * 4 + 1] * .587 + frame.data[i * 4 + 2] * .114;
  return gray;
}
function cornerScore(gray: Float32Array, width: number, x: number, y: number): number {
  let xx = 0, xy = 0, yy = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const p = (y + dy) * width + x + dx;
    const gx = (gray[p + 1] - gray[p - 1]) / 2, gy = (gray[p + width] - gray[p - width]) / 2;
    xx += gx * gx; xy += gx * gy; yy += gy * gy;
  }
  return (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2)) / 2;
}
function normalizedPatch(gray: Float32Array, width: number, height: number, x: number, y: number): Float32Array | undefined {
  const radius = TRACKED_INDICATOR_POLICY.patchRadius;
  if (x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) return undefined;
  const values: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) values.push(gray[(y + dy) * width + x + dx]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const centered = values.map(value => value - mean), energy = centered.reduce((sum, value) => sum + value * value, 0);
  if (energy / values.length < TRACKED_INDICATOR_POLICY.minimumPatchVariance) return undefined;
  return Float32Array.from(centered, value => value / Math.sqrt(energy));
}
function patchCorrelation(descriptor: Float32Array, gray: Float32Array, width: number, height: number, x: number, y: number): number {
  const radius = TRACKED_INDICATOR_POLICY.patchRadius;
  if (x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) return -1;
  let total = 0, squares = 0, dot = 0, index = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const value = gray[(y + dy) * width + x + dx]; total += value; squares += value * value; dot += value * descriptor[index++];
  }
  const energy = squares - total * total / descriptor.length;
  return energy / descriptor.length < TRACKED_INDICATOR_POLICY.minimumPatchVariance ? -1 : dot / Math.sqrt(energy);
}
function matchFeature(feature: ContextFeature, gray: Float32Array, width: number, height: number, offset: { dx: number; dy: number }) {
  const policy = TRACKED_INDICATOR_POLICY, cx = feature.x + Math.round(offset.dx), cy = feature.y + Math.round(offset.dy);
  const radius = policy.maximumAdjacentSearchPixels, diameter = radius * 2 + 1;
  const scores = new Float64Array(diameter * diameter);
  let best = { x: cx, y: cy, score: -1 }, index = 0;
  // Refining only a coarse winner misses distant odd-pixel competitors and
  // overstates uniqueness. Compare every position under the same search bound.
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = cx + dx, y = cy + dy;
    const score = patchCorrelation(feature.descriptor, gray, width, height, x, y);
    scores[index++] = score;
    if (score > best.score) best = { x, y, score };
  }
  if (best.score < policy.minimumCorrelation) return undefined;
  let runner = -Infinity;
  index = 0;
  const separationSquared = policy.runnerUpSeparationPixels ** 2;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const score = scores[index++];
    if ((cx + dx - best.x) ** 2 + (cy + dy - best.y) ** 2 >= separationSquared) runner = Math.max(runner, score);
  }
  if (!Number.isFinite(runner) || best.score - runner < policy.minimumDistinctRunnerUpGap) return undefined;
  return best;
}
function averageRegion(frame: IndicatorTrackingFrame, region: NormalizedZone): RGB {
  const rect = normalizedZoneToPixelRect(region, frame.width, frame.height, "cover");
  let r = 0, g = 0, b = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const offset = (y * frame.width + x) * 4; r += frame.data[offset]; g += frame.data[offset + 1]; b += frame.data[offset + 2];
  }
  const pixels = rect.width * rect.height; return { r: r / pixels, g: g / pixels, b: b / pixels };
}
function meanColor(samples: TrackedIndicatorObservation[]): RGB {
  const count = Math.max(1, samples.length);
  return samples.reduce((sum, sample) => ({ r: sum.r + sample.averageRgb.r / count,
    g: sum.g + sample.averageRgb.g / count, b: sum.b + sample.averageRgb.b / count }), { r: 0, g: 0, b: 0 });
}
function validRegion(zone: NormalizedZone): boolean {
  return Boolean(zone) && [zone.x1, zone.y1, zone.x2, zone.y2].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    zone.x1 < zone.x2 && zone.y1 < zone.y2;
}
function validFrame(frame: IndicatorTrackingFrame): boolean {
  return Number.isInteger(frame.width) && Number.isInteger(frame.height) && frame.width >= 32 && frame.height >= 32 &&
    frame.data instanceof Uint8ClampedArray && frame.data.length >= frame.width * frame.height * 4;
}
function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= .0001 && value <= TRACKED_INDICATOR_POLICY.maxAdjacentNativeGapSeconds;
}
function median(values: number[]): number { const a = [...values].sort((x, y) => x - y); return (a[Math.floor(a.length / 2)] + a[Math.floor((a.length - 1) / 2)]) / 2; }
function range(values: number[]): number { return values.length ? Math.max(...values) - Math.min(...values) : 0; }
