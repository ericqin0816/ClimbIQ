import type { Confidence, SavedAnalysisSession, TimestampMarker } from "../types";
import { analyzeRouteSplits } from "./routeSplits";

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
}

export interface AttemptSummary {
  sessionId: string;
  name: string;
  climberName: string;
  date: string;
  metrics: AttemptMetric[];
  trackingCoverage?: number;
  trackingQuality?: string;
}

export interface AttemptComparisonRow {
  id: AttemptMetricId;
  label: string;
  baseline?: AttemptMetric;
  candidate?: AttemptMetric;
  deltaSeconds?: number;
  outcome: "gained" | "lost" | "matched" | "unavailable" | "review";
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
  const start = validMarker(session.timestamps, "startSignal");
  const movement = validMarker(session.timestamps, "firstMovement");
  const hold10 = validMarker(session.timestamps, "hold10");
  const finish = validMarker(session.timestamps, "finishPad");

  if (start && finish && finish.rawTime! > start.rawTime!) {
    metrics.push(metric(
      "total",
      finish.rawTime! - start.rawTime!,
      minimumConfidence(start.confidence, finish.confidence),
      "Accepted timing",
    ));
  }

  if (start && movement && movement.rawTime! >= start.rawTime! &&
      (!finish || movement.rawTime! <= finish.rawTime!)) {
    metrics.push(metric(
      "reaction",
      movement.rawTime! - start.rawTime!,
      minimumConfidence(start.confidence, movement.confidence),
      "Accepted timing",
    ));
  }

  if (start && hold10 && finish &&
      hold10.rawTime! > start.rawTime! && hold10.rawTime! < finish.rawTime!) {
    const phaseConfidence = minimumConfidence(start.confidence, hold10.confidence, finish.confidence);
    metrics.push(
      metric("bottom-phase", hold10.rawTime! - start.rawTime!, phaseConfidence, "Reviewed Hold 10"),
      metric("top-phase", finish.rawTime! - hold10.rawTime!, phaseConfidence, "Reviewed Hold 10"),
    );
  }

  const biomechanics = session.biomechanics;
  const result = biomechanics?.result;
  if (start && finish && result &&
      Math.abs(result.startRawTime - start.rawTime!) <= 0.051 &&
      Math.abs(result.endRawTime - finish.rawTime!) <= 0.101) {
    const route = analyzeRouteSplits(result, 15, biomechanics.calibration?.confidence ?? "High");
    for (const section of route.sections) {
      if (!section.available || section.sectionTimeSeconds === undefined) continue;
      metrics.push(metric(
        `${section.id}-third` as AttemptMetricId,
        section.sectionTimeSeconds,
        minimumConfidence(route.confidence, section.confidence),
        "COM wall estimate",
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
  const detailed = comparable.filter((row) => row.id !== "total");
  const strongest = maxByAbsoluteDelta(detailed.length ? detailed : comparable);

  return {
    baseline,
    candidate,
    rows,
    comparableMetricCount: comparable.length,
    primaryInsight: strongest
      ? insightForRow(strongest, candidate.name)
      : "Save accepted timing in both attempts to calculate a trustworthy comparison.",
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
  const outcome = Math.abs(deltaSeconds) <= 0.005
    ? "matched"
    : deltaSeconds < 0
      ? "gained"
      : "lost";
  return {
    id,
    label,
    baseline,
    candidate,
    deltaSeconds,
    outcome,
    explanation: outcome === "matched"
      ? "Attempts matched within 0.005 seconds."
      : `${candidateName} ${outcome} ${Math.abs(deltaSeconds).toFixed(3)} seconds here.`,
  };
}

function metric(
  id: AttemptMetricId,
  valueSeconds: number,
  confidence: Confidence,
  evidence: AttemptMetric["evidence"],
): AttemptMetric {
  return {
    id,
    label: METRIC_LABELS[id],
    valueSeconds: round(valueSeconds),
    confidence,
    evidence,
  };
}

function validMarker(
  markers: TimestampMarker[] | undefined,
  id: TimestampMarker["id"],
): TimestampMarker | undefined {
  const marker = markers?.find((item) => item.id === id);
  return marker && typeof marker.rawTime === "number" && Number.isFinite(marker.rawTime) && marker.rawTime >= 0
    ? marker
    : undefined;
}

function minimumConfidence(...values: Confidence[]): Confidence {
  return values.reduce((lowest, value) =>
    CONFIDENCE_RANK[value] < CONFIDENCE_RANK[lowest] ? value : lowest,
  "High");
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
  if (row.deltaSeconds === undefined || row.outcome === "matched") {
    return `${candidateName} most closely matched the baseline in ${row.label.toLowerCase()}.`;
  }
  return row.id === "total"
    ? `${candidateName} was ${Math.abs(row.deltaSeconds).toFixed(3)}s ${row.outcome === "gained" ? "faster" : "slower"} overall.`
    : `${candidateName} ${row.outcome} ${Math.abs(row.deltaSeconds).toFixed(3)}s in ${row.label.toLowerCase()}, the largest measured change among comparable detailed splits.`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
