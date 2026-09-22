import { useMemo, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { buildSavedAttemptRows, searchSavedAttempts, type SavedAttemptFilter, type SavedAttemptSort } from "../lib/savedAttemptSearch";
import "./SavedAttemptsPanel.css";

interface SavedAttemptsPanelProps {
  sessions: SavedAnalysisSession[];
  activeSessionId: string | null;
  onLoad: (sessionId: string) => void;
  disabled?: boolean;
  loading?: boolean;
}

export default function SavedAttemptsPanel({ sessions, activeSessionId, onLoad, disabled = false, loading = false }: SavedAttemptsPanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SavedAttemptFilter>("all");
  const [sort, setSort] = useState<SavedAttemptSort>("updated");
  const [visibleCount, setVisibleCount] = useState(8);
  const rows = useMemo(() => buildSavedAttemptRows(sessions), [sessions]);
  const matches = useMemo(() => searchSavedAttempts(rows, query, filter, sort), [rows, query, filter, sort]);
  const timedCount = rows.filter(row => !row.needsReview).length;
  const active = sessions.find(session => session.id === activeSessionId);

  if (loading) return null;
  if (!sessions.length) return <div className="attempt-library-empty">
    <strong>Your training history starts with one run.</strong>
    <p>Choose a recording, check the suggested timing, then use Save Session. You can reopen its measurements here even without the video.</p>
    <a href="#upload">Choose a recording <span aria-hidden="true">→</span></a>
  </div>;

  return <div className="attempt-library">
    <div className="attempt-library-heading">
      <p><strong>{sessions.length}</strong> saved {sessions.length === 1 ? "attempt" : "attempts"}<span>{timedCount} with usable timing</span></p>
      {active && <a href="#results">View open attempt <span aria-hidden="true">↗</span></a>}
    </div>
    <div className="attempt-library-tools">
      <label className="attempt-library-search">Find an attempt
        <input type="search" value={query} placeholder="Name, climber, gym, date, or notes" onChange={event => { setQuery(event.target.value); setVisibleCount(8); }} />
      </label>
      <label>Show<select value={filter} onChange={event => { setFilter(event.target.value as SavedAttemptFilter); setVisibleCount(8); }}>
        <option value="all">All attempts</option><option value="timed">Timing available</option><option value="review">Timing needs review</option>
      </select></label>
      <label>Order<select value={sort} onChange={event => { setSort(event.target.value as SavedAttemptSort); setVisibleCount(8); }}>
        <option value="updated">Recently saved</option><option value="recorded">Recording date</option>
      </select></label>
    </div>
    <p className="attempt-library-count" role="status">{matches.length} of {sessions.length} {sessions.length === 1 ? "attempt" : "attempts"}{query.trim() || filter !== "all" ? " match" : " shown"}{matches.length > visibleCount ? ` · first ${visibleCount} below` : ""}</p>
    {!matches.length ? <div className="attempt-library-empty">
      <strong>No attempts match this search.</strong><p>Try a name, gym, recording date, or a word from your notes.</p>
      <button type="button" onClick={() => { setQuery(""); setFilter("all"); setVisibleCount(8); }}>Clear search and filters</button>
    </div> : <div className="saved-session-list attempt-library-list">
      {matches.slice(0, visibleCount).map(({ session, totalSeconds, needsReview }) => <button type="button" key={session.id}
        className={`attempt-library-row${session.id === activeSessionId ? " active" : ""}`} onClick={() => onLoad(session.id)} disabled={disabled}
        aria-current={session.id === activeSessionId ? "true" : undefined}>
        <span className="attempt-library-description"><strong>{session.name}</strong>
          <span>{[session.date, session.climberName, session.location].filter(Boolean).join(" · ") || "No date or athlete details"}</span>
          <small>{session.videoFileName || "Saved measurements"}</small>
        </span>
        <span className="attempt-library-value"><strong>{totalSeconds === null ? "—" : `${totalSeconds.toFixed(3)}s`}</strong>
          <small>{needsReview ? "Timing needs review" : "Saved timing"}</small>
          <span>{session.id === activeSessionId ? "Open" : "View attempt"} <span aria-hidden="true">→</span></span>
        </span>
      </button>)}
    </div>}
    {matches.length > visibleCount && <button type="button" className="attempt-library-more" onClick={() => setVisibleCount(count => count + 8)}>Show more attempts ({matches.length - visibleCount} remaining)</button>}
    <p className="attempt-library-note">Times are saved video estimates. A shorter time alone does not establish an improvement; compare the same climber and a comparable recording setup.</p>
  </div>;
}
