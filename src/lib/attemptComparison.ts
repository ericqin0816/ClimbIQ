import type { Confidence, SavedAnalysisSession, TimestampMarker } from "../types";
import { analyzeRouteSplits } from "./routeSplits";
import { isBiomechanicsResultFresh } from "./biomechanicsFreshness";
import { sanitizeTimestampSequence } from "./timestampIntegrity";
import { validateWallCalibration } from "./wallCalibration";

export type AttemptMetricId =
  | "total"
  | "reaction"
  | "bottom-phase"
  | "top-phase"
  | "lower-third"
  | "middle-third"
  | "top-third";

export interface AttemptMetric {
  id: AttemptMetricId;
  label: string;
  valueSeconds: number;
  confidence: Confidence;
  evidence: "Accepted timing" | "Reviewed Hold 10" | "COM wall estimate";
  /** Conservative display policy, not a measured error bound or confidence interval. */
  comparisonFloorSeconds: number;
}

export interface AttemptSummary {
  sessionId: string;
  name: string;
  climberName: string;
  date: string;
  metrics: AttemptMetric[];
  trackingCoverage?: number;
  trackingQuality?: string;
  trackingNote?: string;
}

export interface AttemptComparisonRow {
  id: AttemptMetricId;
  label: string;
  baseline?: AttemptMetric;
  candidate?: AttemptMetric;
  deltaSeconds?: number;
  comparisonFloorSeconds?: number;
  outcome: "gained" | "lost" | "similar" | "unavailable" | "review";
  explanation: string;
}

export interface AttemptComparison {
  baseline: AttemptSummary;
  candidate: AttemptSummary;
  rows: AttemptComparisonRow[];
  comparableMetricCount: number;
  primaryInsight: string;
}

const METRIC_ORDER: AttemptMetricId[] = [
  "total",
  "reaction",
  "bottom-phase",
  "top-phase",
  "lower-third",
  "middle-third",
  "top-third",
];

const METRIC_LABELS: Record<AttemptMetricId, string> = {
  total: "Total climb",
  reaction: "First movement",
  "bottom-phase": "Start → Hold 10",
  "top-phase": "Hold 10 → Finish",
  "lower-third": "Lower third",
  "middle-third": "Middle third",
  "top-third": "Top third",
};

const CONFIDENCE_RANK: Record<Confidence, number> = {
  None: 0,
  Low: 1,
  Medium: 2,
  High: 3,
};

export function summarizeAttempt(session: SavedAnalysisSession): AttemptSummary {
  const metrics: AttemptMetric[] = [];
  const timestamps = sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration);
  const start = validMarker(timestamps, "startSignal");
  const movement = validMarker(timestamps, "firstMovement");
  const hold10 = validMarker(timestamps, "hold10");
  const finish = validMarker(timestamps, "finishPad");

  if (start && finish && finish.rawTime! > start.rawTime!) {
    metrics.push(metric(
      "total",
      finish.rawTime! - start.rawTime!,
      minimumConfidence(start.confidence, finish.confidence),
      "Accepted timing",
      timingComparisonFloor(start, finish),
    ));
  }

  if (start && movement && movement.rawTime! >= start.rawTime! &&
      (!finish || movement.rawTime! <= finish.rawTime!)) {
    metrics.push(metric(
      "reaction",
      movement.rawTime! - start.rawTime!,
      minimumConfidence(start.confidence, movement.confidence),
      "Accepted timing",
      timingComparisonFloor(start, movement),
    ));
  }

  if (start && hold10 && finish &&
      hold10.rawTime! > start.rawTime! && hold10.rawTime! < finish.rawTime!) {
    const phaseConfidence = minimumConfidence(start.confidence, hold10.confidence, finish.confidence);
    metrics.push(
      metric("bottom-phase", hold10.rawTime! - start.rawTime!, phaseConfidence, "Reviewed Hold 10", timingComparisonFloor(start, hold10)),
      metric("top-phase", finish.rawTime! - hold10.rawTime!, phaseConfidence, "Reviewed Hold 10", timingComparisonFloor(hold10, finish)),
    );
  }

  const biomechanics = session.biomechanics;
  const storedResult = biomechanics?.result;
  const result = validateWallCalibration(biomechanics?.calibration).valid &&
    isBiomechanicsResultFresh(storedResult, {
      startRawTime: start?.rawTime,
      endRawTime: finish?.rawTime,
      identityZone: session.zones.startBody,
    }) && Array.isArray(storedResult.frames) && storedResult.metrics &&
    Number.isFinite(storedResult.metrics.validCoverage)
    ? storedResult : undefined;
  if (start && finish && result) {
    // Align the permitted millisecond rounding tolerance to accepted boundaries
    // so all three section durations share exactly the same clock as the total.
    const route = analyzeRouteSplits({ ...result, startRawTime: start.rawTime!, endRawTime: finish.rawTime! },
      biomechanics!.calibration!.heightMeters, biomechanics!.calibration!.confidence ?? "Low");
    const sampleFps = result.settings?.sampleFps;
    const samplingFloor = Number.isFinite(sampleFps) && sampleFps > 0 ? 2 / sampleFps : 0.4;
    for (const section of route.sections) {
      if (!section.available || section.sectionTimeSeconds === undefined) continue;
      metrics.push(metric(
        `${section.id}-third` as AttemptMetricId,
        section.sectionTimeSeconds,
        minimumConfidence(route.confidence, section.confidence, start.confidence, finish.confidence),
        "COM wall estimate",
        Math.max(0.1, samplingFloor, timingComparisonFloor(start, finish)),
      ));
    }
  }

  return {
    sessionId: session.id,
    name: session.name,
    climberName: session.climberName,
    date: session.date,
    metrics,
    trackingCoverage: finiteFraction(result?.metrics.trackingCoverage),
    trackingQuality: result?.metrics.quality,
    trackingNote: storedResult && !result
      ? "Saved tracking does not match the accepted timing, athlete, or valid wall calibration. Run COM analysis again."
      : undefined,
  };
}

export function compareAttempts(
  baselineSession: SavedAnalysisSession,
  candidateSession: SavedAnalysisSession,
): AttemptComparison {
  const baseline = summarizeAttempt(baselineSession);
  const candidate = summarizeAttempt(candidateSession);
  const baselineById = new Map(baseline.metrics.map((item) => [item.id, item]));
  const candidateById = new Map(candidate.metrics.map((item) => [item.id, item]));
  const rows = METRIC_ORDER.map((id) => compareMetric(
    id,
    baselineById.get(id),
    candidateById.get(id),
    candidate.name,
  ));
  const comparable = rows.filter((row) => row.deltaSeconds !== undefined);
  const total = comparable.find((row) => row.id === "total");
  // Contact phases partition the race. Prefer these over overlapping COM thirds
  // when available; never add gains from both partitions together.
  const phases = comparable.filter((row) => row.id === "bottom-phase" || row.id === "top-phase");
  const detailed = phases.length ? phases : comparable.filter((row) => row.id !== "total");
  const strongest = maxByAbsoluteDelta(detailed.filter((row) => row.outcome === "gained" || row.outcome === "lost"));
  const insights = [total, strongest].filter((row): row is AttemptComparisonRow => Boolean(row))
    .map((row) => insightForRow(row, candidate.name));

  return {
    baseline,
    candidate,
    rows,
    comparableMetricCount: comparable.length,
    primaryInsight: insights.length ? insights.join(" ")
      : comparable.length ? "The available differences are below the comparison thresholds. No gain or loss is established."
      : "No comparable timing meets the evidence requirements in both saved attempts.",
  };
}

export function hasComparableTiming(session: SavedAnalysisSession): boolean {
  return summarizeAttempt(session).metrics.length > 0;
}

function compareMetric(
  id: AttemptMetricId,
  baseline?: AttemptMetric,
  candidate?: AttemptMetric,
  candidateName = "The new attempt",
): AttemptComparisonRow {
  const label = METRIC_LABELS[id];
  if (!baseline || !candidate) {
    return {
      id,
      label,
      baseline,
      candidate,
      outcome: "unavailable",
      explanation: "This metric is not available in both saved attempts.",
    };
  }
  if (CONFIDENCE_RANK[baseline.confidence] < CONFIDENCE_RANK.Medium ||
      CONFIDENCE_RANK[candidate.confidence] < CONFIDENCE_RANK.Medium) {
    return {
      id,
      label,
      baseline,
      candidate,
      outcome: "review",
      explanation: "Both values are shown, but at least one is low confidence, so no gain or loss is claimed.",
    };
  }

  const deltaSeconds = round(candidate.valueSeconds - baseline.valueSeconds);
  const comparisonFloorSeconds = Math.max(baseline.comparisonFloorSeconds, candidate.comparisonFloorSeconds);
  const outcome = Math.abs(deltaSeconds) <= comparisonFloorSeconds + 1e-9
    ? "similar"
    : deltaSeconds < 0
      ? "gained"
      : "lost";
  return {
    id,
    label,
    baseline,
    candidate,
    deltaSeconds,
    comparisonFloorSeconds,
    outcome,
    explanation: outcome === "similar"
      ? `Difference is within the ${comparisonFloorSeconds.toFixed(3)}s comparison threshold; no gain or loss is established. This is a conservative display rule, not a measured accuracy bound.`
      : `${candidateName} ${outcome} ${Math.abs(deltaSeconds).toFixed(3)} seconds here.`,
  };
}

function metric(
  id: AttemptMetricId,
  valueSeconds: number,
  confidence: Confidence,
  evidence: AttemptMetric["evidence"],
  comparisonFloorSeconds: number,
): AttemptMetric {
  return {
    id,
    label: METRIC_LABELS[id],
    valueSeconds: round(valueSeconds),
    confidence,
    evidence,
    comparisonFloorSeconds,
  };
}

function validMarker(
  markers: TimestampMarker[] | undefined,
  id: TimestampMarker["id"],
): TimestampMarker | undefined {
  const marker = markers?.find((item) => item.id === id);
  return marker && marker.source !== "Not set" && typeof marker.rawTime === "number" && Number.isFinite(marker.rawTime) && marker.rawTime >= 0
    ? marker
    : undefined;
}

function minimumConfidence(...values: Confidence[]): Confidence {
  return values.reduce((lowest, value) =>
    !(value in CONFIDENCE_RANK) ? "None" : CONFIDENCE_RANK[value] < CONFIDENCE_RANK[lowest] ? value : lowest,
  "High");
}

function timingComparisonFloor(...markers: TimestampMarker[]): number {
  // Source video frame intervals and detector timing error are not yet stored.
  // Do not infer millisecond accuracy from decimal places or confidence labels.
  return markers.some((marker) => marker.source === "Body motion detection" || marker.source === "Motion-based estimate")
    ? 0.2 : 0.1;
}

function finiteFraction(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function maxByAbsoluteDelta(rows: AttemptComparisonRow[]): AttemptComparisonRow | undefined {
  let strongest: AttemptComparisonRow | undefined;
  for (const row of rows) {
    if (row.deltaSeconds === undefined) continue;
    if (!strongest || Math.abs(row.deltaSeconds) > Math.abs(strongest.deltaSeconds!)) {
      strongest = row;
    }
  }
  return strongest;
}

function insightForRow(row: AttemptComparisonRow, candidateName: string): string {
  if (row.deltaSeconds === undefined || row.outcome === "similar") {
    return `The overall difference is within the ${row.comparisonFloorSeconds?.toFixed(3)}s comparison threshold; no overall gain or loss is established.`;
  }
  return row.id === "total"
    ? `${candidateName} was ${Math.abs(row.deltaSeconds).toFixed(3)}s ${row.outcome === "gained" ? "faster" : "slower"} overall.`
    : `${candidateName} ${row.outcome} ${Math.abs(row.deltaSeconds).toFixed(3)}s in ${row.label.toLowerCase()}, the largest measured change among comparable detailed splits.`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
