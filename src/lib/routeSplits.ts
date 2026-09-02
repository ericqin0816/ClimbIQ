import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  Confidence,
} from "../types";

export const STANDARD_SPEED_WALL_HEIGHT_METERS = 15;
export const MAX_ROUTE_PROGRESS_GAP_SECONDS = 0.25;

export type RouteSectionId = "lower" | "middle" | "top";

export interface RouteProgressSample {
  rawTime: number;
  /** Upward progress with downward/backtracking motion removed. */
  progressMeters: number;
  chunkId: number;
}

export interface RouteCrossing {
  fraction: number;
  heightMeters: number;
  available: boolean;
  rawTime?: number;
  climbTime?: number;
  confidence: Confidence;
  reason: string;
}

export interface RouteSectionSplit {
  id: RouteSectionId;
  label: string;
  rangeLabel: string;
  available: boolean;
  startRawTime?: number;
  endRawTime?: number;
  /** Time from the accepted start to this section's end. */
  cumulativeTimeSeconds?: number;
  /** Time spent in this individual route section. */
  sectionTimeSeconds?: number;
  /** Observed upward COM pace, excluding untracked gaps. */
  averageVerticalPaceMps?: number;
  trackingCoverage: number;
  confidence: Confidence;
  reason: string;
}

export interface RouteSplitAnalysis {
  available: boolean;
  confidence: Confidence;
  wallHeightMeters: number;
  usableFrames: number;
  gapCount: number;
  maxProgressMeters?: number;
  halfway: RouteCrossing;
  oneThird: RouteCrossing;
  twoThirds: RouteCrossing;
  sections: RouteSectionSplit[];
  slowestSectionId?: RouteSectionId;
  evenPacing: boolean;
}

/**
 * Builds an upward-only progress series from trustworthy COM samples. Invalid,
 * extrapolated, and unsmoothed frames cannot create a split.
 */
export function buildMonotonicRouteProgress(
  frames: BiomechanicsFrame[],
  wallHeightMeters = STANDARD_SPEED_WALL_HEIGHT_METERS,
): RouteProgressSample[] {
  if (!Number.isFinite(wallHeightMeters) || wallHeightMeters <= 0) {
    return [];
  }

  const byTime = new Map<number, number>();
  for (const frame of frames) {
    const point = frame.smoothedWallCom;
    if (!frame.valid || frame.extrapolated || frame.warning?.includes("Implausible wall-plane speed") || !point ||
        !Number.isFinite(frame.rawTime) || !Number.isFinite(point.yMeters)) {
      continue;
    }
    const height = clamp(point.yMeters, 0, wallHeightMeters);
    const existing = byTime.get(frame.rawTime);
    if (existing === undefined || height > existing) {
      byTime.set(frame.rawTime, height);
    }
  }

  const ordered = Array.from(byTime, ([rawTime, height]) => ({ rawTime, height }))
    .sort((left, right) => left.rawTime - right.rawTime);
  let maximum = Number.NEGATIVE_INFINITY;
  let chunkId = 0;
  return ordered.map((sample, index) => {
    if (index > 0 && sample.rawTime - ordered[index - 1].rawTime > MAX_ROUTE_PROGRESS_GAP_SECONDS + 1e-9) {
      chunkId += 1;
    }
    maximum = Math.max(maximum, sample.height);
    return {
      rawTime: sample.rawTime,
      progressMeters: maximum,
      chunkId,
    };
  });
}

export function analyzeRouteSplits(
  result: BiomechanicsResult,
  wallHeightMeters = STANDARD_SPEED_WALL_HEIGHT_METERS,
  calibrationConfidence: Confidence = "High",
): RouteSplitAnalysis {
  const samples = buildMonotonicRouteProgress(
    result.frames.filter((frame) =>
      frame.rawTime >= result.startRawTime - 1e-9 && frame.rawTime <= result.endRawTime + 1e-9,
    ),
    wallHeightMeters,
  );
  const oneThird = findCrossing(result, samples, 1 / 3, wallHeightMeters, calibrationConfidence);
  const halfway = findCrossing(result, samples, 1 / 2, wallHeightMeters, calibrationConfidence);
  const twoThirds = findCrossing(result, samples, 2 / 3, wallHeightMeters, calibrationConfidence);
  const sections = [
    buildSection(result, samples, {
      id: "lower",
      label: "Lower third",
      rangeLabel: `Start to ${(wallHeightMeters / 3).toFixed(0)} m`,
      startRawTime: result.startRawTime,
      endCrossing: oneThird,
      startBoundary: undefined,
    }),
    buildSection(result, samples, {
      id: "middle",
      label: "Middle third",
      rangeLabel: `${(wallHeightMeters / 3).toFixed(0)} m to ${(wallHeightMeters * 2 / 3).toFixed(0)} m`,
      startCrossing: oneThird,
      endCrossing: twoThirds,
      startBoundary: oneThird,
    }),
    buildSection(result, samples, {
      id: "top",
      label: "Top third",
      rangeLabel: `${(wallHeightMeters * 2 / 3).toFixed(0)} m to finish`,
      startCrossing: twoThirds,
      endRawTime: result.endRawTime,
      startBoundary: twoThirds,
    }),
  ];

  const completeSections = sections.filter((section) =>
    section.available && section.sectionTimeSeconds !== undefined,
  );
  let slowestSectionId: RouteSectionId | undefined;
  let evenPacing = false;
  if (completeSections.length === 3) {
    const ordered = [...completeSections].sort(
      (left, right) => right.sectionTimeSeconds! - left.sectionTimeSeconds!,
    );
    const slowest = ordered[0];
    const fastest = ordered[ordered.length - 1];
    const meaningfulDifference = Math.max(0.15, fastest.sectionTimeSeconds! * 0.08);
    if (slowest.sectionTimeSeconds! - fastest.sectionTimeSeconds! > meaningfulDifference) {
      slowestSectionId = slowest.id;
    } else {
      evenPacing = true;
    }
  }

  const confidence = minimumConfidence(overallConfidence(result, samples), calibrationConfidence);
  return {
    available: sections.some((section) => section.available) || halfway.available,
    confidence,
    wallHeightMeters,
    usableFrames: samples.length,
    gapCount: samples.length ? samples[samples.length - 1].chunkId : 0,
    maxProgressMeters: samples.length ? samples[samples.length - 1].progressMeters : undefined,
    halfway,
    oneThird,
    twoThirds,
    sections,
    slowestSectionId,
    evenPacing,
  };
}

function findCrossing(
  result: BiomechanicsResult,
  samples: RouteProgressSample[],
  fraction: number,
  wallHeightMeters: number,
  calibrationConfidence: Confidence,
): RouteCrossing {
  const heightMeters = wallHeightMeters * fraction;
  const unavailable = (reason: string): RouteCrossing => ({
    fraction,
    heightMeters,
    available: false,
    confidence: "None",
    reason,
  });
  if (!samples.length) {
    return unavailable("No valid, in-wall COM samples were available.");
  }
  if (samples[0].progressMeters > heightMeters + 1e-6) {
    return unavailable("Tracking began above this boundary, so its crossing was not observed.");
  }
  if (Math.abs(samples[0].progressMeters - heightMeters) <= 1e-6) {
    return makeCrossing(result, samples, fraction, heightMeters, samples[0].rawTime, calibrationConfidence);
  }

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.progressMeters < heightMeters && current.progressMeters >= heightMeters) {
      if (previous.chunkId !== current.chunkId ||
          current.rawTime - previous.rawTime > MAX_ROUTE_PROGRESS_GAP_SECONDS + 1e-9) {
        return unavailable("The climber crossed this boundary inside an untracked gap, so ClimbIQ will not guess the time.");
      }
      const rise = current.progressMeters - previous.progressMeters;
      const amount = rise > 1e-9 ? (heightMeters - previous.progressMeters) / rise : 1;
      const rawTime = previous.rawTime + (current.rawTime - previous.rawTime) * clamp(amount, 0, 1);
      return makeCrossing(result, samples, fraction, heightMeters, rawTime, calibrationConfidence);
    }
  }

  return unavailable(`Tracked COM did not reach ${heightMeters.toFixed(1)} m.`);
}

function makeCrossing(
  result: BiomechanicsResult,
  samples: RouteProgressSample[],
  fraction: number,
  heightMeters: number,
  rawTime: number,
  calibrationConfidence: Confidence,
): RouteCrossing {
  const coverage = intervalEvidence(samples, result.startRawTime, rawTime).coverage;
  const confidence = minimumConfidence(
    confidenceForCoverage(Math.min(coverage, result.metrics.validCoverage)),
    calibrationConfidence,
  );
  return {
    fraction,
    heightMeters,
    available: true,
    rawTime,
    climbTime: Math.max(0, rawTime - result.startRawTime),
    confidence,
    reason: `Estimated when upward-only COM progress crossed ${heightMeters.toFixed(1)} m.`,
  };
}

interface SectionOptions {
  id: RouteSectionId;
  label: string;
  rangeLabel: string;
  startRawTime?: number;
  startCrossing?: RouteCrossing;
  endRawTime?: number;
  endCrossing?: RouteCrossing;
  startBoundary?: RouteCrossing;
}

function buildSection(
  result: BiomechanicsResult,
  samples: RouteProgressSample[],
  options: SectionOptions,
): RouteSectionSplit {
  const startRawTime = options.startRawTime ?? options.startCrossing?.rawTime;
  const endRawTime = options.endRawTime ?? options.endCrossing?.rawTime;
  const missingBoundary = options.startCrossing && !options.startCrossing.available
    ? options.startCrossing.reason
    : options.endCrossing && !options.endCrossing.available
      ? options.endCrossing.reason
      : undefined;
  if (missingBoundary || startRawTime === undefined || endRawTime === undefined || endRawTime <= startRawTime) {
    return {
      id: options.id,
      label: options.label,
      rangeLabel: options.rangeLabel,
      available: false,
      trackingCoverage: 0,
      confidence: "None",
      reason: missingBoundary ?? "The section boundaries were not observed in the accepted time range.",
    };
  }

  const sectionTimeSeconds = endRawTime - startRawTime;
  const evidence = intervalEvidence(samples, startRawTime, endRawTime);
  const trackingCoverage = clamp(evidence.coverage, 0, 1);
  const confidence = minimumConfidence(
    confidenceForCoverage(Math.min(trackingCoverage, result.metrics.validCoverage)),
    options.startBoundary?.confidence,
    options.endCrossing?.confidence,
  );
  const averageVerticalPaceMps = trackingCoverage >= 0.6 && evidence.observedDuration >= 0.5 && evidence.observedGain >= 0.25
    ? evidence.observedGain / evidence.observedDuration
    : undefined;
  return {
    id: options.id,
    label: options.label,
    rangeLabel: options.rangeLabel,
    available: true,
    startRawTime,
    endRawTime,
    cumulativeTimeSeconds: endRawTime - result.startRawTime,
    sectionTimeSeconds,
    averageVerticalPaceMps,
    trackingCoverage,
    confidence,
    reason: averageVerticalPaceMps === undefined
      ? "Split time is available, but continuous tracking was too sparse for a trustworthy vertical pace."
      : "Split and observed vertical pace are based on continuous, upward-only COM progress.",
  };
}

function intervalEvidence(
  samples: RouteProgressSample[],
  startRawTime: number,
  endRawTime: number,
): { coverage: number; observedDuration: number; observedGain: number } {
  const intervalDuration = Math.max(0, endRawTime - startRawTime);
  if (intervalDuration <= 0) {
    return { coverage: 0, observedDuration: 0, observedGain: 0 };
  }
  let observedDuration = 0;
  let observedGain = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.chunkId !== current.chunkId || current.rawTime <= previous.rawTime) {
      continue;
    }
    const clippedStart = Math.max(startRawTime, previous.rawTime);
    const clippedEnd = Math.min(endRawTime, current.rawTime);
    if (clippedEnd <= clippedStart) {
      continue;
    }
    const pairDuration = current.rawTime - previous.rawTime;
    const startAmount = (clippedStart - previous.rawTime) / pairDuration;
    const endAmount = (clippedEnd - previous.rawTime) / pairDuration;
    const rise = current.progressMeters - previous.progressMeters;
    observedDuration += clippedEnd - clippedStart;
    observedGain += Math.max(0, rise * (endAmount - startAmount));
  }
  return {
    coverage: observedDuration / intervalDuration,
    observedDuration,
    observedGain,
  };
}

function overallConfidence(result: BiomechanicsResult, samples: RouteProgressSample[]): Confidence {
  if (samples.length < 2) {
    return "None";
  }
  const evidence = intervalEvidence(samples, result.startRawTime, result.endRawTime);
  return confidenceForCoverage(Math.min(evidence.coverage, result.metrics.validCoverage));
}

function confidenceForCoverage(coverage: number): Confidence {
  if (coverage >= 0.85) {
    return "High";
  }
  if (coverage >= 0.65) {
    return "Medium";
  }
  return coverage > 0 ? "Low" : "None";
}

function minimumConfidence(...values: Array<Confidence | undefined>): Confidence {
  const rank: Record<Confidence, number> = { None: 0, Low: 1, Medium: 2, High: 3 };
  const defined = values.filter((value): value is Confidence => value !== undefined);
  return defined.length
    ? defined.reduce((lowest, value) => rank[value] < rank[lowest] ? value : lowest)
    : "None";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
