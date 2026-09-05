import { memo, useMemo, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { compareAttempts, hasComparableTiming, type AttemptComparisonRow } from "../lib/attemptComparison";
import "./AttemptComparisonPanel.css";

export default memo(function AttemptComparisonPanel({ sessions }: { sessions: SavedAnalysisSession[] }) {
  const eligibleSessions = useMemo(
    () => sessions.filter(hasComparableTiming).sort((a, b) =>
      (typeof b.date === "string" ? b.date : "").localeCompare(typeof a.date === "string" ? a.date : "") ||
      b.createdAt.localeCompare(a.createdAt)),
    [sessions],
  );
  const [selectedBaselineId, setSelectedBaselineId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");

  if (eligibleSessions.length < 2) {
    return (
      <div className="comparison-empty">
        <strong>Save two timed attempts to compare them.</strong>
        <span>ClimbIQ will use accepted timing and reviewed Hold 10 markers already stored in each session.</span>
      </div>
    );
  }

  const sessionById = new Map(eligibleSessions.map((session) => [session.id, session]));
  const baselineId = selectedBaselineId && sessionById.has(selectedBaselineId)
    ? selectedBaselineId
    : eligibleSessions[1].id;
  const candidateId = selectedCandidateId && sessionById.has(selectedCandidateId) && selectedCandidateId !== baselineId
    ? selectedCandidateId
    : eligibleSessions.find((session) => session.id !== baselineId)!.id;
  const comparison = compareAttempts(sessionById.get(baselineId)!, sessionById.get(candidateId)!);
  const visibleRows = comparison.rows.filter((row) => row.baseline || row.candidate);

  function chooseBaseline(nextId: string) {
    setSelectedBaselineId(nextId);
    if (nextId === candidateId) {
      setSelectedCandidateId(baselineId);
    }
  }

  function chooseCandidate(nextId: string) {
    setSelectedCandidateId(nextId);
    if (nextId === baselineId) {
      setSelectedBaselineId(candidateId);
    }
  }

  return (
    <details className="comparison-details">
      <summary>
        <span>
          <strong>Compare saved attempts</strong>
          <small>{comparison.comparableMetricCount} metrics meet the comparison requirements.</small>
        </span>
        <span>Compare</span>
      </summary>
      <div className="comparison-content">
        <div className="comparison-selectors">
          <label>
            Baseline attempt
            <select value={baselineId} onChange={(event) => chooseBaseline(event.target.value)}>
              {eligibleSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}{session.date ? ` · ${session.date}` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="comparison-arrow" aria-hidden="true">→</span>
          <label>
            New attempt
            <select value={candidateId} onChange={(event) => chooseCandidate(event.target.value)}>
              {eligibleSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}{session.date ? ` · ${session.date}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="comparison-insight" aria-live="polite">
          <span>Overall result & phase changes</span>
          <strong>{comparison.primaryInsight}</strong>
        </div>

        <div className="comparison-table" role="table" aria-label="Saved attempt timing comparison">
          <div className="comparison-row comparison-header" role="row">
            <span role="columnheader">Metric</span>
            <span role="columnheader">Baseline</span>
            <span role="columnheader">New</span>
            <span role="columnheader">Change</span>
          </div>
          {visibleRows.map((row) => <ComparisonRow key={row.id} row={row} />)}
        </div>

        <div className="comparison-quality">
          <EvidenceQuality label="Baseline" session={comparison.baseline} />
          <EvidenceQuality label="New attempt" session={comparison.candidate} />
        </div>
        <p className="muted comparison-note">
          Negative values are shorter times. Small differences stay unclassified: timing uses a minimum 0.100s threshold, body-motion timing 0.200s, and COM sections at least two pose sample intervals. These are conservative comparison rules, not measured error bounds. Hold 10 phases require reviewed contact in both sessions. Contact phases and wall thirds overlap and must not be added together.
        </p>
      </div>
    </details>
  );
});

function ComparisonRow({ row }: { row: AttemptComparisonRow }) {
  return (
    <div className={`comparison-row ${row.outcome}`} role="row" title={row.explanation}>
      <span role="cell"><strong>{row.label}</strong><small>{evidenceLabel(row)}</small></span>
      <span role="cell">{formatMetric(row.baseline)}</span>
      <span role="cell">{formatMetric(row.candidate)}</span>
      <span role="cell" className="comparison-delta">{formatDelta(row)}
        {row.comparisonFloorSeconds !== undefined && <small>Threshold: {row.comparisonFloorSeconds.toFixed(3)}s</small>}
      </span>
    </div>
  );
}

function EvidenceQuality({
  label,
  session,
}: {
  label: string;
  session: ReturnType<typeof compareAttempts>["baseline"];
}) {
  return (
    <span>
      <small>{label} evidence</small>
      <strong>{session.trackingQuality ?? (session.trackingNote ? "Tracking needs rerun" : "Timing only")}</strong>
      {session.trackingNote && <small>{session.trackingNote}</small>}
      {session.trackingCoverage !== undefined && <small>{Math.round(session.trackingCoverage * 100)}% climber tracking</small>}
    </span>
  );
}

function formatMetric(metric: AttemptComparisonRow["baseline"]): string {
  return metric ? `${metric.valueSeconds.toFixed(3)}s · ${metric.confidence}` : "—";
}

function formatDelta(row: AttemptComparisonRow): string {
  if (row.outcome === "review") return "Review confidence";
  if (row.deltaSeconds === undefined) return "Not comparable";
  if (row.outcome === "similar") return `${row.deltaSeconds > 0 ? "+" : row.deltaSeconds < 0 ? "−" : ""}${Math.abs(row.deltaSeconds).toFixed(3)}s · Below threshold`;
  return `${row.deltaSeconds > 0 ? "+" : "−"}${Math.abs(row.deltaSeconds).toFixed(3)}s ${row.outcome}`;
}

function evidenceLabel(row: AttemptComparisonRow): string {
  return row.candidate?.evidence ?? row.baseline?.evidence ?? "Unavailable";
}
