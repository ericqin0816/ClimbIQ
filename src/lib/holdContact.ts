import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  Confidence,
  TimestampMarker,
  WallCalibration,
  WallPoint,
} from "../types";
import { STANDARD_SPEED_HOLDS, type StandardSpeedHoldId } from "./standardSpeedRoute";
import { projectImagePointToWall, validateWallCalibration } from "./wallCalibration";

export type ContactHand = "left" | "right";

export interface HoldContactReviewWindow {
  startRawTime: number;
  endRawTime: number;
}

export interface HoldContactEvidence {
  observedSamples: number;
  observedDurationSeconds: number;
  observationCoverage: number;
  meanVisibility: number;
  medianWristSpeedMps: number;
  netWristSpeedMps: number;
  /** Deterministic 0-100 evidence score used to rank overlapping candidates. */
  contactScore?: number;
  requiredSamples?: number;
  confirmationSamples?: number;
  medianDistanceMeters?: number;
  targetNearestFraction?: number;
  targetPlausibleFraction?: number;
  competingHoldId?: StandardSpeedHoldId;
  /** Amount subtracted from the first sampled confirmation time by threshold interpolation. */
  onsetRefinementSeconds?: number;
  /** Fraction of samples localized from finger landmarks instead of the wrist fallback. */
  fingerDerivedFraction?: number;
  meanHandLandmarkCount?: number;
}

export interface HoldContactCandidateDiagnostic {
  hand: ContactHand;
  firstObservedRawTime: number;
  lastObservedRawTime: number;
  refinedOnsetRawTime?: number;
  score: number;
  accepted: boolean;
  closestDistanceMeters: number;
  medianDistanceMeters: number;
  observedSamples: number;
  requiredSamples: number;
  confirmationSamples: number;
  targetNearestFraction: number;
  targetPlausibleFraction: number;
  fingerDerivedFraction: number;
  meanHandLandmarkCount: number;
  competingHoldId?: StandardSpeedHoldId;
  rejectionReason?: string;
}

export interface HoldContactDetectionResult {
  detected: boolean;
  rawTime?: number;
  climbTime?: number;
  confidence: Confidence;
  hand?: ContactHand;
  /** Closest observed wrist-to-hold distance during the confirmed dwell. */
  distanceMeters?: number;
  reason: string;
  reviewWindow?: HoldContactReviewWindow;
  evidence?: HoldContactEvidence;
  /** All proximity episodes in deterministic review order. */
  candidates?: HoldContactCandidateDiagnostic[];
}

export interface HoldContactDetectionOptions {
  /** Actual registered hold centers, replacing the translated diagram neighborhood. */
  observedRouteHolds?: readonly ObservedRouteHold[];
  /** Contact review only: allow a directly registered target just beyond an approximate side edge. */
  allowApproximateEdgeProjection?: boolean;
  holdLabel?: string;
  proximityRadiusMeters?: number;
  confirmationRadiusMeters?: number;
  minDwellSeconds?: number;
  maxMissingGapSeconds?: number;
  minWristVisibility?: number;
  maxMedianWristSpeedMps?: number;
  maxNetWristSpeedMps?: number;
  reviewPaddingSeconds?: number;
}

export interface ObservedRouteHold {
  id: StandardSpeedHoldId;
  wall: WallPoint;
}

interface ResolvedOptions {
  holdLabel: string;
  proximityRadiusMeters: number;
  confirmationRadiusMeters: number;
  minDwellSeconds: number;
  maxMissingGapSeconds: number;
  minWristVisibility: number;
  maxMedianWristSpeedMps: number;
  maxNetWristSpeedMps: number;
  reviewPaddingSeconds: number;
  holdAmbiguityMeters: number;
}

interface RouteContext {
  targetHoldId: StandardSpeedHoldId;
  holds: readonly ObservedRouteHold[];
  observed: boolean;
}

interface WristObservation {
  rawTime: number;
  wall: WallPoint;
  distanceMeters: number;
  visibility: number;
  nearestHoldId?: StandardSpeedHoldId;
  nearestHoldDistanceMeters?: number;
  closestAlternativeHoldId?: StandardSpeedHoldId;
  closestAlternativeDistanceMeters?: number;
  pointSource: "fingers" | "wrist";
  handLandmarkCount: number;
}

interface ProximityEpisode {
  hand: ContactHand;
  observations: WristObservation[];
  /** Last usable sample before entering the broad proximity radius. */
  entryObservation?: WristObservation;
}

interface EvaluatedEpisode {
  episode: ProximityEpisode;
  accepted: boolean;
  closestDistance: number;
  medianDistance: number;
  duration: number;
  coverage: number;
  meanVisibility: number;
  medianSpeed: number;
  netSpeed: number;
  requiredSamples: number;
  confirmationSamples: number;
  targetNearestFraction: number;
  targetPlausibleFraction: number;
  competingHoldId?: StandardSpeedHoldId;
  onsetRawTime?: number;
  firstConfirmationRawTime?: number;
  score: number;
  rejectionReason?: string;
}

const HAND_LANDMARK_INDEX: Record<ContactHand, { wrist: number; fingers: readonly number[] }> = {
  left: { wrist: 15, fingers: [17, 19, 21] },
  right: { wrist: 16, fingers: [18, 20, 22] },
};
const HAND_ORDER: readonly ContactHand[] = ["left", "right"];

/**
 * Detects real hand contact with a known wall hold. It intentionally uses no
 * COM height or route-halfway fallback: without sustained wrist evidence it
 * returns detected=false.
 */
export function detectHoldContact(
  result: BiomechanicsResult,
  calibration: WallCalibration | undefined,
  hold: WallPoint,
  options: HoldContactDetectionOptions = {},
): HoldContactDetectionResult {
  const validation = validateWallCalibration(calibration);
  if (!calibration || !validation.valid || !validation.matrix) {
    return unavailable(validation.error ?? "A valid wall calibration is required for hand-contact timing.");
  }
  const edgeProjection = options.allowApproximateEdgeProjection === true &&
    calibration.source === "automatic-approximate" && Boolean(options.observedRouteHolds);
  if (!withinContactProjectionBounds(hold, calibration, edgeProjection)) {
    return unavailable("The target hold is outside the calibrated wall.");
  }

  const resolved = resolveOptions(result, calibration, options);
  const route = resolveRouteContext(hold, resolved.holdLabel, calibration, options.observedRouteHolds, edgeProjection);
  if (options.observedRouteHolds && !route) {
    return unavailable("The registered hold neighborhood is invalid or does not match the target; rerun route registration.");
  }
  const frames = [...result.frames]
    .filter((frame) => Number.isFinite(frame.rawTime) &&
      frame.rawTime >= result.startRawTime - 1e-9 && frame.rawTime <= result.endRawTime + 1e-9)
    .sort((left, right) => left.rawTime - right.rawTime);
  const episodes = HAND_ORDER.flatMap((hand) =>
    buildEpisodes(frames, hand, hold, validation.matrix!, resolved, route),
  );
  const evaluated = episodes.map((episode) =>
    evaluateEpisode(episode, hold, result.settings.sampleFps, resolved, route),
  );
  const diagnostics = evaluated
    .map(toDiagnostic)
    .sort((left, right) =>
      left.firstObservedRawTime - right.firstObservedRawTime ||
      HAND_ORDER.indexOf(left.hand) - HAND_ORDER.indexOf(right.hand) ||
      right.score - left.score,
    );
  const accepted = chooseAcceptedEpisode(evaluated, result.settings.sampleFps);

  if (!accepted) {
    if (!evaluated.length) {
      return {
        ...unavailable(
          `No usable hand tracking came within ${resolved.proximityRadiusMeters.toFixed(2)} m of ${resolved.holdLabel}; no hand-contact time was inferred.`,
        ),
        candidates: diagnostics,
      };
    }
    const closest = [...evaluated].sort((left, right) =>
      left.closestDistance - right.closestDistance ||
      right.score - left.score ||
      firstObservation(left).rawTime - firstObservation(right).rawTime ||
      HAND_ORDER.indexOf(left.episode.hand) - HAND_ORDER.indexOf(right.episode.hand),
    )[0];
    return {
      detected: false,
      confidence: "None",
      hand: closest.episode.hand,
      distanceMeters: closest.closestDistance,
      reason: closest.rejectionReason ?? `Wrist proximity to ${resolved.holdLabel} was not sustained.`,
      reviewWindow: makeReviewWindow(result, closest.onsetRawTime ?? firstObservation(closest).rawTime, resolved.reviewPaddingSeconds),
      evidence: toEvidence(closest),
      candidates: diagnostics,
    };
  }

  const onsetRawTime = accepted.onsetRawTime ?? firstObservation(accepted).rawTime;
  const confidence = contactConfidence(accepted, result, calibration);
  const routeReason = (edgeProjection ? " Contact review uses a small side-edge extrapolation of the approximate wall; it does not change COM or speed calibration." : "") + (route
    ? ` Hold ${route.targetHoldId} was the nearest ${route.observed ? "registered hold" : "numbered-hold match"} for ${(accepted.targetNearestFraction * 100).toFixed(0)}% of confirmation samples.`
    : "");
  return {
    detected: true,
    rawTime: onsetRawTime,
    climbTime: Math.max(0, onsetRawTime - result.startRawTime),
    confidence,
    hand: accepted.episode.hand,
    distanceMeters: accepted.closestDistance,
    reason: `First sustained ${accepted.episode.hand}-hand contact near ${resolved.holdLabel}: ` +
      `${accepted.episode.observations.length} hand samples over ${accepted.duration.toFixed(2)}s, ` +
      `closest ${accepted.closestDistance.toFixed(2)} m with ${accepted.medianSpeed.toFixed(2)} m/s median hand motion ` +
      `(evidence score ${accepted.score.toFixed(0)}/100).${routeReason}`,
    reviewWindow: makeReviewWindow(result, onsetRawTime, resolved.reviewPaddingSeconds),
    evidence: toEvidence(accepted),
    candidates: diagnostics,
  };
}

/** Returns a marker only for verified hand contact; COM halfway is never used. */
export function getHold10ContactMarker(
  result: BiomechanicsResult,
  calibration: WallCalibration | undefined,
  hold10: WallPoint,
  options: Omit<HoldContactDetectionOptions, "holdLabel"> = {},
): TimestampMarker | null {
  const contact = detectHoldContact(result, calibration, hold10, { ...options, holdLabel: "Hold 10" });
  if (!contact.detected || contact.rawTime === undefined || contact.climbTime === undefined) {
    return null;
  }
  return {
    id: "hold10",
    label: "Hold 10 hand contact",
    rawTime: contact.rawTime,
    climbTime: contact.climbTime,
    detectedRawTime: contact.rawTime,
    offsetApplied: 0,
    note: `${contact.hand === "left" ? "Left" : "Right"} hand contact; closest projected distance ${contact.distanceMeters?.toFixed(2)} m. ${contact.reason}`,
    source: "Hold contact detection",
    confidence: contact.confidence,
  };
}

function buildEpisodes(
  frames: BiomechanicsFrame[],
  hand: ContactHand,
  hold: WallPoint,
  matrix: NonNullable<ReturnType<typeof validateWallCalibration>["matrix"]>,
  options: ResolvedOptions,
  route: RouteContext | undefined,
): ProximityEpisode[] {
  const episodes: ProximityEpisode[] = [];
  let active: WristObservation[] = [];
  let entryObservation: WristObservation | undefined;
  let previousUsable: WristObservation | undefined;
  const finish = () => {
    if (active.length) {
      episodes.push({ hand, observations: active, entryObservation });
      active = [];
      entryObservation = undefined;
    }
  };

  for (const frame of frames) {
    const observation = projectHand(frame, hand, hold, matrix, options.minWristVisibility, route);
    if (!observation) {
      if (active.length && frame.rawTime - active[active.length - 1].rawTime > options.maxMissingGapSeconds + 1e-9) {
        finish();
      }
      continue;
    }
    if (active.length && observation.rawTime - active[active.length - 1].rawTime > options.maxMissingGapSeconds + 1e-9) {
      finish();
    }
    if (observation.distanceMeters > options.proximityRadiusMeters) {
      finish();
      previousUsable = observation;
      continue;
    }
    if (!active.length) {
      entryObservation = previousUsable &&
        observation.rawTime - previousUsable.rawTime <= options.maxMissingGapSeconds + 1e-9
        ? previousUsable
        : undefined;
    }
    active.push(observation);
    previousUsable = observation;
  }
  finish();
  return episodes;
}

function projectHand(
  frame: BiomechanicsFrame,
  hand: ContactHand,
  hold: WallPoint,
  matrix: NonNullable<ReturnType<typeof validateWallCalibration>["matrix"]>,
  minVisibility: number,
  route: RouteContext | undefined,
): WristObservation | undefined {
  if (frame.poseSelected === false) {
    return undefined;
  }
  try {
    const selected = selectProjectedHandPoint(frame, hand, matrix, minVisibility);
    if (!selected) return undefined;
    const { wall } = selected;
    const distanceMeters = wallDistance(wall, hold);
    if (!Number.isFinite(distanceMeters)) {
      return undefined;
    }
    const routeMatch = route ? matchNumberedHold(wall, route) : undefined;
    return {
      rawTime: frame.rawTime,
      wall,
      distanceMeters,
      visibility: selected.visibility,
      pointSource: selected.pointSource,
      handLandmarkCount: selected.handLandmarkCount,
      ...routeMatch,
    };
  } catch {
    return undefined;
  }
}

function selectProjectedHandPoint(
  frame: BiomechanicsFrame,
  hand: ContactHand,
  matrix: NonNullable<ReturnType<typeof validateWallCalibration>["matrix"]>,
  minVisibility: number,
): { wall: WallPoint; visibility: number; pointSource: "fingers" | "wrist"; handLandmarkCount: number } | undefined {
  const indices = HAND_LANDMARK_INDEX[hand];
  const project = (index: number) => {
    const landmark = frame.landmarks.find((candidate) => candidate.index === index);
    if (!landmark || landmark.visibility < minVisibility ||
        !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) {
      return undefined;
    }
    try {
      const wall = projectImagePointToWall(landmark, matrix);
      return { wall, visibility: landmark.visibility };
    } catch {
      return undefined;
    }
  };
  const wrist = project(indices.wrist);
  const fingers = indices.fingers.flatMap((index) => {
    const point = project(index);
    return point ? [point] : [];
  });

  if (fingers.length >= 2) {
    const robustCenter = medianWallPoint(fingers.map((point) => point.wall));
    // Pose fingertips form a compact hand cluster. Ignore one implausible
    // landmark jump rather than pulling the contact point toward another hold.
    const inliers = fingers.filter((point) => wallDistance(point.wall, robustCenter) <= 0.42);
    const inlierCenter = inliers.length >= 2
      ? medianWallPoint(inliers.map((point) => point.wall))
      : undefined;
    if (inlierCenter && (!wrist || wallDistance(inlierCenter, wrist.wall) <= 0.75)) {
      return {
        wall: inlierCenter,
        visibility: median(inliers.map((point) => point.visibility)),
        pointSource: "fingers",
        handLandmarkCount: inliers.length,
      };
    }
  }
  if (fingers.length === 1 && fingers[0].visibility >= Math.max(0.5, minVisibility)) {
    // A lone fingertip is usable only when it remains anatomically plausible
    // relative to the wrist, or is exceptionally visible while the wrist is
    // occluded. Multi-frame dwell checks still guard against a one-frame jump.
    if ((wrist && wallDistance(fingers[0].wall, wrist.wall) <= 0.72) ||
        (!wrist && fingers[0].visibility >= 0.7)) {
      return {
        ...fingers[0],
        pointSource: "fingers",
        handLandmarkCount: 1,
      };
    }
  }
  return wrist
    ? { ...wrist, pointSource: "wrist", handLandmarkCount: 1 }
    : undefined;
}

function evaluateEpisode(
  episode: ProximityEpisode,
  hold: WallPoint,
  sampleFps: number,
  options: ResolvedOptions,
  route: RouteContext | undefined,
): EvaluatedEpisode {
  const observations = episode.observations;
  const first = observations[0];
  const last = observations[observations.length - 1];
  const duration = Math.max(0, last.rawTime - first.rawTime);
  const fps = Math.max(1, sampleFps);
  const expectedSamples = Math.max(1, Math.round(duration * fps) + 1);
  const requiredSamples = Math.max(2, Math.ceil(options.minDwellSeconds * fps) + 1);
  const coverage = Math.min(1, observations.length / expectedSamples);
  const filtered = medianFilterObservations(observations, hold, route);
  const distances = filtered.map((sample) => sample.distanceMeters);
  const closestDistance = Math.min(...observations.map((sample) => sample.distanceMeters));
  const medianDistance = median(distances);
  const meanVisibility = mean(observations.map((sample) => sample.visibility));
  const speeds = filtered.slice(1).flatMap((sample, index) => {
    const previous = filtered[index];
    const elapsed = sample.rawTime - previous.rawTime;
    return elapsed > 1e-9
      ? [wallDistance(previous.wall, sample.wall) / elapsed]
      : [];
  });
  const medianSpeed = speeds.length ? median(speeds) : Number.POSITIVE_INFINITY;
  const netSpeed = duration > 1e-9 ? wallDistance(filtered[0].wall, filtered[filtered.length - 1].wall) / duration : Number.POSITIVE_INFINITY;
  const confirmation = filtered.filter((sample) => sample.distanceMeters <= options.confirmationRadiusMeters + 1e-9);
  const confirmationSamples = confirmation.length;
  const minConfirmationSamples = Math.max(2, requiredSamples - 1);
  const routeSamples = confirmation.length ? confirmation : filtered;
  const targetNearestFraction = route
    ? fraction(routeSamples, (sample) => sample.nearestHoldId === route.targetHoldId)
    : 1;
  const targetPlausibleFraction = route
    ? fraction(routeSamples, (sample) =>
      sample.distanceMeters <= (sample.closestAlternativeDistanceMeters ?? Number.POSITIVE_INFINITY) + options.holdAmbiguityMeters)
    : 1;
  const competingHoldId = route ? mostCommonCompetingHold(routeSamples, route.targetHoldId) : undefined;
  // The broad confirmation radius absorbs projection error. Timestamp the
  // tighter, settled part of the dwell so low sample rates do not report the
  // hand's early approach as contact.
  const onsetRadius = Math.min(
    options.confirmationRadiusMeters,
    Math.max(closestDistance + 0.08, medianDistance + 0.08),
  );
  const firstConfirmation = findFirstStableConfirmation(filtered, onsetRadius);
  const onsetRawTime = firstConfirmation
    ? refineOnsetTime(episode, filtered, firstConfirmation, onsetRadius, options.maxMissingGapSeconds)
    : undefined;
  const score = contactScore({
    closestDistance,
    medianDistance,
    duration,
    coverage,
    meanVisibility,
    medianSpeed,
    confirmationSamples,
    requiredSamples,
    targetNearestFraction: (targetNearestFraction + targetPlausibleFraction) / 2,
  }, options);

  let rejectionReason: string | undefined;
  if (observations.length < requiredSamples || duration + 1e-9 < options.minDwellSeconds) {
    rejectionReason = `A tracked hand passed near ${options.holdLabel}, but proximity was not sustained long enough to count as contact ` +
      `(${observations.length}/${requiredSamples} samples over ${duration.toFixed(2)}s).`;
  } else if (coverage < 0.55) {
    rejectionReason = `Hand tracking near ${options.holdLabel} had too many missing frames to confirm contact.`;
  } else if (confirmationSamples < minConfirmationSamples || medianDistance > options.confirmationRadiusMeters || !firstConfirmation) {
    rejectionReason = `A tracked hand approached ${options.holdLabel}, but did not remain inside the confirmation area long enough to verify contact.`;
  } else if (route && (targetNearestFraction < 0.5 || targetPlausibleFraction < 0.7)) {
    rejectionReason = competingHoldId
      ? `The wrist was closer to Hold ${competingHoldId} than ${options.holdLabel}; nearby-hold proximity was not counted as Hold ${route.targetHoldId} contact.`
      : `The wrist was not consistently closest to ${options.holdLabel}; nearby-hold proximity was rejected.`;
  } else if (medianSpeed > options.maxMedianWristSpeedMps || netSpeed > options.maxNetWristSpeedMps) {
    rejectionReason = `A tracked hand made a fast fly-by near ${options.holdLabel}; no low-motion dwell confirmed hand contact.`;
  }

  return {
    episode,
    accepted: rejectionReason === undefined,
    closestDistance,
    medianDistance,
    duration,
    coverage,
    meanVisibility,
    medianSpeed,
    netSpeed,
    requiredSamples,
    confirmationSamples,
    targetNearestFraction,
    targetPlausibleFraction,
    competingHoldId,
    onsetRawTime,
    firstConfirmationRawTime: firstConfirmation?.rawTime,
    score,
    rejectionReason,
  };
}

function resolveOptions(
  result: BiomechanicsResult,
  calibration: WallCalibration,
  options: HoldContactDetectionOptions,
): ResolvedOptions {
  const sampleFps = Math.max(1, result.settings.sampleFps);
  const approximate = calibration.source === "automatic-approximate";
  const proximityRadiusMeters = finitePositive(options.proximityRadiusMeters, approximate ? 0.62 : 0.55);
  return {
    holdLabel: options.holdLabel?.trim() || "the target hold",
    proximityRadiusMeters,
    confirmationRadiusMeters: Math.min(
      proximityRadiusMeters,
      finitePositive(options.confirmationRadiusMeters, approximate ? 0.44 : 0.38),
    ),
    minDwellSeconds: finitePositive(options.minDwellSeconds, 0.14),
    // Allow one skipped sample at each supported analysis rate, but never join
    // independent contacts across a longer tracking loss.
    maxMissingGapSeconds: finitePositive(options.maxMissingGapSeconds, Math.min(0.46, Math.max(0.15, 2.25 / sampleFps))),
    minWristVisibility: clamp(options.minWristVisibility ?? Math.max(0.2, result.settings.minVisibility * 0.75), 0, 1),
    maxMedianWristSpeedMps: finitePositive(options.maxMedianWristSpeedMps, approximate ? 1.65 : 1.35),
    maxNetWristSpeedMps: finitePositive(options.maxNetWristSpeedMps, approximate ? 1.05 : 0.9),
    reviewPaddingSeconds: finitePositive(options.reviewPaddingSeconds, 0.4),
    holdAmbiguityMeters: approximate ? 0.12 : 0.08,
  };
}

function resolveRouteContext(
  hold: WallPoint,
  label: string,
  calibration: WallCalibration,
  observedHolds?: readonly ObservedRouteHold[],
  allowApproximateEdgeProjection = false,
): RouteContext | undefined {
  if (calibration.widthMeters < 2.4 || calibration.widthMeters > 3.6 ||
      calibration.heightMeters < 12 || calibration.heightMeters > 18) {
    return undefined;
  }
  const match = /\bhold\s*(\d{1,2})\b/i.exec(label);
  const id = Number(match?.[1]);
  if (!Number.isInteger(id) || id < 1 || id > STANDARD_SPEED_HOLDS.length) {
    return undefined;
  }
  const target = STANDARD_SPEED_HOLDS[id - 1];
  if (observedHolds) {
    const ids = new Set(observedHolds.map(entry => entry.id));
    const observedTarget = observedHolds.find(entry => entry.id === id);
    if (observedHolds.length < 3 || ids.size !== observedHolds.length || !observedTarget ||
        observedHolds.some(entry => !Number.isInteger(entry.id) || entry.id < 1 || entry.id > 20 ||
          !withinContactProjectionBounds(entry.wall, calibration, allowApproximateEdgeProjection)) ||
        (allowApproximateEdgeProjection && ![9, 10, 11].every(id => ids.has(id as StandardSpeedHoldId))) ||
        Math.hypot(observedTarget.wall.xMeters - hold.xMeters, observedTarget.wall.yMeters - hold.yMeters) > 0.02) {
      return undefined;
    }
    return { targetHoldId: target.id, holds: observedHolds, observed: true };
  }
  return {
    targetHoldId: target.id,
    // A manual target correction translates the route neighbourhood too, so
    // nearby-hold disambiguation remains useful without overriding the user.
    holds: STANDARD_SPEED_HOLDS.map(entry => ({ id: entry.id, wall: {
      xMeters: entry.wall.xMeters + hold.xMeters - target.wall.xMeters,
      yMeters: entry.wall.yMeters + hold.yMeters - target.wall.yMeters,
    } })),
    observed: false,
  };
}

/** A contact-only tolerance, never used to expand COM or physical wall geometry. */
export function withinContactProjectionBounds(point: WallPoint, calibration: WallCalibration, allowApproximateEdgeProjection = false): boolean {
  const margin = allowApproximateEdgeProjection && calibration.source === "automatic-approximate"
    ? calibration.widthMeters * 0.05 : 0;
  return isFiniteWallPoint(point) && point.xMeters >= -margin && point.xMeters <= calibration.widthMeters + margin &&
    point.yMeters >= 0 && point.yMeters <= calibration.heightMeters;
}

function matchNumberedHold(
  point: WallPoint,
  route: RouteContext,
): Pick<WristObservation,
  "nearestHoldId" | "nearestHoldDistanceMeters" | "closestAlternativeHoldId" | "closestAlternativeDistanceMeters"> {
  const matches = route.holds.map((hold) => ({
    id: hold.id,
    distance: Math.hypot(
      point.xMeters - hold.wall.xMeters,
      point.yMeters - hold.wall.yMeters,
    ),
  })).sort((left, right) => left.distance - right.distance || left.id - right.id);
  const nearest = matches[0];
  const alternative = matches.find((match) => match.id !== route.targetHoldId);
  return {
    nearestHoldId: nearest.id,
    nearestHoldDistanceMeters: nearest.distance,
    closestAlternativeHoldId: alternative?.id,
    closestAlternativeDistanceMeters: alternative?.distance,
  };
}

function medianFilterObservations(
  observations: WristObservation[],
  hold: WallPoint,
  route: RouteContext | undefined,
): WristObservation[] {
  if (observations.length < 3) {
    return observations.map((sample) => ({ ...sample }));
  }
  return observations.map((sample, index) => {
    if (index === 0 || index === observations.length - 1) {
      return { ...sample };
    }
    const window = observations.slice(index - 1, index + 2);
    const wall = {
      xMeters: median(window.map((entry) => entry.wall.xMeters)),
      yMeters: median(window.map((entry) => entry.wall.yMeters)),
    };
    return {
      ...sample,
      wall,
      distanceMeters: wallDistance(wall, hold),
      ...(route ? matchNumberedHold(wall, route) : {}),
    };
  });
}

function findFirstStableConfirmation(
  observations: WristObservation[],
  confirmationRadiusMeters: number,
): WristObservation | undefined {
  for (let index = 0; index < observations.length; index += 1) {
    if (observations[index].distanceMeters > confirmationRadiusMeters + 1e-9) continue;
    const next = observations[index + 1];
    const previous = observations[index - 1];
    if ((next && next.distanceMeters <= confirmationRadiusMeters + 1e-9) ||
        (previous && previous.distanceMeters <= confirmationRadiusMeters + 1e-9)) {
      return observations[index];
    }
  }
  return undefined;
}

function refineOnsetTime(
  episode: ProximityEpisode,
  filtered: WristObservation[],
  firstConfirmation: WristObservation,
  threshold: number,
  maxGap: number,
): number {
  const index = filtered.indexOf(firstConfirmation);
  const previous = index > 0 ? filtered[index - 1] : episode.entryObservation;
  if (!previous || firstConfirmation.rawTime - previous.rawTime > maxGap + 1e-9 ||
      previous.distanceMeters <= threshold || firstConfirmation.distanceMeters >= previous.distanceMeters) {
    return roundMilliseconds(firstConfirmation.rawTime);
  }
  const fractionToThreshold = clamp(
    (previous.distanceMeters - threshold) / (previous.distanceMeters - firstConfirmation.distanceMeters),
    0,
    1,
  );
  return roundMilliseconds(previous.rawTime +
    (firstConfirmation.rawTime - previous.rawTime) * fractionToThreshold);
}

function contactScore(
  candidate: Pick<EvaluatedEpisode,
    "closestDistance" | "medianDistance" | "duration" | "coverage" | "meanVisibility" |
    "medianSpeed" | "confirmationSamples" | "requiredSamples" | "targetNearestFraction">,
  options: ResolvedOptions,
): number {
  const proximity = 1 - clamp(candidate.medianDistance / options.confirmationRadiusMeters, 0, 1);
  const dwell = clamp(candidate.duration / (options.minDwellSeconds * 2), 0, 1);
  const stillness = 1 - clamp(candidate.medianSpeed / options.maxMedianWristSpeedMps, 0, 1);
  const confirmation = clamp(candidate.confirmationSamples / Math.max(2, candidate.requiredSamples), 0, 1);
  const score = 25 * proximity + 15 * dwell + 12 * candidate.coverage +
    10 * candidate.meanVisibility + 16 * stillness + 12 * confirmation +
    10 * candidate.targetNearestFraction;
  return Math.round(clamp(score, 0, 100) * 10) / 10;
}

function chooseAcceptedEpisode(
  evaluated: EvaluatedEpisode[],
  sampleFps: number,
): EvaluatedEpisode | undefined {
  const accepted = evaluated.filter((candidate) => candidate.accepted && candidate.onsetRawTime !== undefined);
  if (!accepted.length) return undefined;
  const earliest = Math.min(...accepted.map((candidate) => candidate.onsetRawTime!));
  const simultaneousWindow = Math.max(0.025, 0.45 / Math.max(1, sampleFps));
  return accepted
    .filter((candidate) => candidate.onsetRawTime! <= earliest + simultaneousWindow + 1e-9)
    .sort((left, right) =>
      right.score - left.score ||
      left.onsetRawTime! - right.onsetRawTime! ||
      left.closestDistance - right.closestDistance ||
      HAND_ORDER.indexOf(left.episode.hand) - HAND_ORDER.indexOf(right.episode.hand),
    )[0];
}

function contactConfidence(
  episode: EvaluatedEpisode,
  result: BiomechanicsResult,
  calibration: WallCalibration,
): Confidence {
  if (calibration.confidence === "Low" || result.metrics.quality === "Needs review" ||
      episode.meanVisibility < 0.4 || episode.score < 62) {
    return "Low";
  }
  const strong = calibration.source !== "automatic-approximate" &&
    result.metrics.quality === "High" && episode.coverage >= 0.8 &&
    episode.duration >= 0.2 && episode.closestDistance <= 0.28 &&
    episode.medianSpeed <= 0.8 && episode.meanVisibility >= 0.6 &&
    episode.targetNearestFraction >= 0.75 && episode.score >= 75;
  return strong ? "High" : "Medium";
}

function makeReviewWindow(
  result: BiomechanicsResult,
  rawTime: number,
  padding: number,
): HoldContactReviewWindow {
  return {
    startRawTime: Math.max(result.startRawTime, rawTime - padding),
    endRawTime: Math.min(result.endRawTime, rawTime + Math.max(0.6, padding)),
  };
}

function firstObservation(candidate: EvaluatedEpisode): WristObservation {
  return candidate.episode.observations[0];
}

function toEvidence(candidate: EvaluatedEpisode): HoldContactEvidence {
  return {
    observedSamples: candidate.episode.observations.length,
    observedDurationSeconds: candidate.duration,
    observationCoverage: candidate.coverage,
    meanVisibility: candidate.meanVisibility,
    medianWristSpeedMps: candidate.medianSpeed,
    netWristSpeedMps: candidate.netSpeed,
    contactScore: candidate.score,
    requiredSamples: candidate.requiredSamples,
    confirmationSamples: candidate.confirmationSamples,
    medianDistanceMeters: candidate.medianDistance,
    targetNearestFraction: candidate.targetNearestFraction,
    targetPlausibleFraction: candidate.targetPlausibleFraction,
    competingHoldId: candidate.competingHoldId,
    onsetRefinementSeconds: candidate.firstConfirmationRawTime !== undefined && candidate.onsetRawTime !== undefined
      ? Math.max(0, candidate.firstConfirmationRawTime - candidate.onsetRawTime)
      : 0,
    fingerDerivedFraction: fraction(candidate.episode.observations, (sample) => sample.pointSource === "fingers"),
    meanHandLandmarkCount: mean(candidate.episode.observations.map((sample) => sample.handLandmarkCount)),
  };
}

function toDiagnostic(candidate: EvaluatedEpisode): HoldContactCandidateDiagnostic {
  return {
    hand: candidate.episode.hand,
    firstObservedRawTime: firstObservation(candidate).rawTime,
    lastObservedRawTime: candidate.episode.observations[candidate.episode.observations.length - 1].rawTime,
    refinedOnsetRawTime: candidate.onsetRawTime,
    score: candidate.score,
    accepted: candidate.accepted,
    closestDistanceMeters: candidate.closestDistance,
    medianDistanceMeters: candidate.medianDistance,
    observedSamples: candidate.episode.observations.length,
    requiredSamples: candidate.requiredSamples,
    confirmationSamples: candidate.confirmationSamples,
    targetNearestFraction: candidate.targetNearestFraction,
    targetPlausibleFraction: candidate.targetPlausibleFraction,
    fingerDerivedFraction: fraction(candidate.episode.observations, (sample) => sample.pointSource === "fingers"),
    meanHandLandmarkCount: mean(candidate.episode.observations.map((sample) => sample.handLandmarkCount)),
    competingHoldId: candidate.competingHoldId,
    rejectionReason: candidate.rejectionReason,
  };
}

function mostCommonCompetingHold(
  observations: WristObservation[],
  targetHoldId: StandardSpeedHoldId,
): StandardSpeedHoldId | undefined {
  const counts = new Map<StandardSpeedHoldId, number>();
  for (const sample of observations) {
    if (sample.nearestHoldId !== undefined && sample.nearestHoldId !== targetHoldId) {
      counts.set(sample.nearestHoldId, (counts.get(sample.nearestHoldId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
}

function fraction<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length ? values.filter(predicate).length / values.length : 0;
}

function unavailable(reason: string): HoldContactDetectionResult {
  return { detected: false, confidence: "None", reason };
}

function isFiniteWallPoint(point: WallPoint): boolean {
  return Number.isFinite(point.xMeters) && Number.isFinite(point.yMeters);
}

function wallDistance(left: WallPoint, right: WallPoint): number {
  return Math.hypot(left.xMeters - right.xMeters, left.yMeters - right.yMeters);
}

function medianWallPoint(points: WallPoint[]): WallPoint {
  return {
    xMeters: median(points.map((point) => point.xMeters)),
    yMeters: median(points.map((point) => point.yMeters)),
  };
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
