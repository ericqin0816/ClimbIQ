import ComparisonPlayback from "./ComparisonPlayback";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { attemptComparisonContextKey, compareAttempts, hasComparableTiming, type AttemptComparisonRow } from "../lib/attemptComparison";
import { attemptIdentityConfirmationKey } from "../lib/attemptIdentity";
import { comparisonPlaybackRange } from "../lib/comparisonPlayback";
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
  const [confirmedIdentityKey, setConfirmedIdentityKey] = useState("");
  const [confirmedContextKey, setConfirmedContextKey] = useState("");
  const target = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const reveal = () => {
      if (!target.current) return;
      target.current.open = true;
      target.current.focus({ preventScroll: true });
    };
    const onHashChange = () => {
      if (location.hash !== "#attempt-comparison") return;
      reveal();
      target.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    const onLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (link?.getAttribute("href") === "#attempt-comparison") reveal();
    };
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onLink);
    onHashChange();
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onLink);
    };
  }, [eligibleSessions.length]);

  if (eligibleSessions.length < 2) {
    return (
      <div id="attempt-comparison" className="comparison-empty" tabIndex={-1}>
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
  const identityKey = attemptIdentityConfirmationKey(sessionById.get(baselineId)!, sessionById.get(candidateId)!);
  const contextKey = attemptComparisonContextKey(sessionById.get(baselineId)!, sessionById.get(candidateId)!);
  const comparison = compareAttempts(sessionById.get(baselineId)!, sessionById.get(candidateId)!, {
    distinctAttemptsConfirmed: identityKey === confirmedIdentityKey,
    comparisonContextConfirmed: contextKey === confirmedContextKey,
  });
  const visibleRows = comparison.rows.filter((row) => row.baseline || row.candidate);
  const changedPhase = comparison.performanceComparisonAllowed ? comparison.rows
    .filter(row => (row.id === "bottom-phase" || row.id === "top-phase") && (row.outcome === "gained" || row.outcome === "lost"))
    .sort((a, b) => Math.abs(b.deltaSeconds!) - Math.abs(a.deltaSeconds!))[0] : undefined;
  const requestedPhase = changedPhase?.id === "bottom-phase" ? "bottom" : changedPhase?.id === "top-phase" ? "top" : undefined;
  const preferredPhase = requestedPhase && comparisonPlaybackRange(sessionById.get(baselineId)!, requestedPhase) &&
    comparisonPlaybackRange(sessionById.get(candidateId)!, requestedPhase) ? requestedPhase : undefined;

  function chooseBaseline(nextId: string) {
    setConfirmedIdentityKey("");
    setConfirmedContextKey("");
    setSelectedBaselineId(nextId);
    if (nextId === candidateId) {
      setSelectedCandidateId(baselineId);
    }
  }

  function chooseCandidate(nextId: string) {
    setConfirmedIdentityKey("");
    setConfirmedContextKey("");
    setSelectedCandidateId(nextId);
    if (nextId === baselineId) {
      setSelectedBaselineId(candidateId);
    }
  }

  return (
    <details ref={target} id="attempt-comparison" className="comparison-details" tabIndex={-1} open>
      <summary>
        <span>
          <strong>Compare saved attempts</strong>
          <small>{comparison.performanceComparisonAllowed ? `${comparison.comparableMetricCount} metrics meet the comparison requirements.` : "Saved timing is shown; review comparability before interpreting changes."}</small>
        </span>
        <span>Compare</span>
      </summary>
      <div className="comparison-content">
        <div className="comparison-selectors">
          <label>
            Baseline attempt
            <select aria-label="Baseline attempt" value={baselineId} onChange={(event) => chooseBaseline(event.target.value)}>
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
            <select aria-label="New attempt" value={candidateId} onChange={(event) => chooseCandidate(event.target.value)}>
              {eligibleSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}{session.date ? ` · ${session.date}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {comparison.identity.requiresDistinctAttemptConfirmation && <label className="comparison-identity-check">
          <input type="checkbox" checked={confirmedIdentityKey === identityKey} onChange={event => setConfirmedIdentityKey(event.target.checked ? identityKey : "")} />
          These overlapping recording details belong to two distinct climbing attempts, not edited analyses of one attempt
        </label>}
        <div className="comparison-context-review">
          <label className="comparison-context-check">
            <input type="checkbox" checked={confirmedContextKey === contextKey}
              disabled={comparison.identity.relationship === "same-attempt" || Boolean(comparison.contextMismatchReason)}
              onChange={event => setConfirmedContextKey(event.target.checked ? contextKey : "")} />
            I checked these are attempts by the same climber on the same route, use comparable normal-speed video clocks, and mark the same physical events in both recordings
          </label>
          <p>This is your review of the recordings, not independent verification or a timing-accuracy guarantee. If the events or playback speed are unknown, leave this unchecked and use the recorded differences for inspection only.</p>
        </div>
        <div className="comparison-insight" aria-live="polite">
          <span>{comparison.performanceComparisonAllowed ? "Overall result & phase changes" : comparison.identity.relationship === "same-attempt" ? "Annotation comparison only" : "Recorded timing comparison"}</span>
          <strong>{comparison.primaryInsight}</strong>
          {preferredPhase && <a className="comparison-replay-link" href="#comparison-replay" onClick={() => document.getElementById("comparison-replay")?.focus({ preventScroll: true })}>Replay changed {preferredPhase} phase <span aria-hidden="true">→</span></a>}
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

        <ComparisonPlayback key={identityKey} baseline={sessionById.get(baselineId)!} candidate={sessionById.get(candidateId)!} preferredPhase={preferredPhase} />

        <div className="comparison-quality">
          <EvidenceQuality label="Baseline" session={comparison.baseline} />
          <EvidenceQuality label="New attempt" session={comparison.candidate} />
        </div>
        <p className="muted comparison-note">
          Negative values are shorter times. Small differences stay unclassified: timing uses a minimum 0.100s threshold, body-motion timing 0.200s, and COM sections at least two pose sample intervals. Recorded video observation intervals can increase these thresholds. These are conservative comparison rules, not measured error bounds. Hold 10 phases require reviewed contact in both sessions. Contact phases and wall thirds overlap and must not be added together.
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
  if (row.outcome === "context-review") return `${row.deltaSeconds! > 0 ? "+" : row.deltaSeconds! < 0 ? "−" : ""}${Math.abs(row.deltaSeconds!).toFixed(3)}s · Recorded difference`;
  if (row.outcome === "identity-review") return row.deltaSeconds === undefined ? "Confirm distinct attempts"
    : `${row.deltaSeconds > 0 ? "+" : row.deltaSeconds < 0 ? "−" : ""}${Math.abs(row.deltaSeconds).toFixed(3)}s · Annotation difference`;
  if (row.outcome === "review") return "Review confidence";
  if (row.deltaSeconds === undefined) return "Not comparable";
  if (row.outcome === "similar") return `${row.deltaSeconds > 0 ? "+" : row.deltaSeconds < 0 ? "−" : ""}${Math.abs(row.deltaSeconds).toFixed(3)}s · Below threshold`;
  return `${row.deltaSeconds > 0 ? "+" : "−"}${Math.abs(row.deltaSeconds).toFixed(3)}s ${row.outcome}`;
}

function evidenceLabel(row: AttemptComparisonRow): string {
  return row.candidate?.evidence ?? row.baseline?.evidence ?? "Unavailable";
}
