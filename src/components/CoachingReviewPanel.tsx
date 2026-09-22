import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { SavedAnalysisSession } from "../types";
import { buildCoachingEvidence, coachingBaselineOptions, coachingEvidenceFingerprint, type CoachingEvidence } from "../lib/coachingEvidence";
import { buildCoachingCatalog, parseCoachingPacket, validateCoachingPlan, type CoachingGoal, type CoachingPlan } from "../lib/coachingPolicy";
import { readCoachingResponse } from "../lib/coachingRequest";
import { createUUID } from "../lib/createUUID";
import "./CoachingReviewPanel.css";

const LOCAL_APP = Capacitor.isNativePlatform();

export default function CoachingReviewPanel({ getCurrentSession, sessions, onJump, disabled, canSeek = true }: {
  getCurrentSession: () => SavedAnalysisSession; sessions: SavedAnalysisSession[];
  onJump: (time: number) => void; disabled: boolean; canSeek?: boolean;
}) {
  const [goal, setGoal] = useState<CoachingGoal>("overview");
  const [currentSnapshot, setCurrentSnapshot] = useState(getCurrentSession);
  const [baselineId, setBaselineId] = useState("");
  const [comparable, setComparable] = useState(false);
  const [distinctAttemptFingerprint, setDistinctAttemptFingerprint] = useState("");
  const [evidence, setEvidence] = useState<CoachingEvidence | null>(null);
  const [plan, setPlan] = useState<CoachingPlan | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(false);
  const [archived, setArchived] = useState(false);
  const [reviewId, setReviewId] = useState(() => new URLSearchParams(location.search).get("coachingReview") ?? "");
  const request = useRef<AbortController | null>(null);
  const requestId = useRef("");
  const evidenceBaselineId = useRef("");
  const latestSources = useRef({ getCurrentSession, sessions });
  useEffect(() => { latestSources.current = { getCurrentSession, sessions }; }, [getCurrentSession, sessions]);
  const baselineOptions = useMemo(() => coachingBaselineOptions(currentSnapshot, sessions), [currentSnapshot, sessions]);
  const selectedBaseline = baselineOptions.find(option => option.id === baselineId);
  const selectedIdentityFingerprint = useMemo(() => {
    const baseline = sessions.find(session => session.id === baselineId);
    return baseline ? coachingEvidenceFingerprint(currentSnapshot, baseline) : "";
  }, [baselineId, currentSnapshot, sessions]);
  const distinctAttemptsConfirmed = selectedIdentityFingerprint !== "" && distinctAttemptFingerprint === selectedIdentityFingerprint;
  useEffect(() => {
    // Packaged builds have no same-origin server API. Keep all evidence local.
    if (LOCAL_APP) return () => { request.current?.abort(); };
    const controller = new AbortController();
    readCoachingResponse("/api/coaching?status=1", { signal: controller.signal }, 10_000)
      .then(result => { if (!controller.signal.aborted) setEnabled(result.ok && result.data.enabled === true); }).catch(() => {});
    return () => { controller.abort(); request.current?.abort(); };
  }, []);
  function invalidate() {
    request.current?.abort(); request.current = null; setBusy(false); setEvidence(null); setPlan(null); setAi(false); setArchived(false); setMessage(""); requestId.current = "";
  }
  function stopWaiting() {
    request.current?.abort(); request.current = null; setBusy(false);
    setMessage("Stopped waiting. Your local review is unchanged. The server may still finish; retry checks the same request.");
  }
  function evidenceStillMatches(): boolean {
    if (!evidence || archived) return false;
    const current = latestSources.current.getCurrentSession();
    const baseline = evidenceBaselineId.current ? latestSources.current.sessions.find(item => item.id === evidenceBaselineId.current) : undefined;
    return (!evidenceBaselineId.current || !!baseline) && evidence.sourceFingerprint === coachingEvidenceFingerprint(current, baseline);
  }
  function rejectStaleReview() {
    invalidate();
    setCurrentSnapshot(latestSources.current.getCurrentSession());
    setMessage("The attempt or baseline changed. Review the current measurements again before using these points.");
  }
  useEffect(() => {
    // A save updates the library without changing the evidence. Keep its pending
    // request alive; only an actual source/baseline change invalidates the review.
    if (evidence && !archived && !evidenceStillMatches()) { rejectStaleReview(); return; }
    setCurrentSnapshot(latestSources.current.getCurrentSession());
  }, [sessions, evidence, archived]);
  function localReview() {
    invalidate();
    try {
      const current = getCurrentSession();
      setCurrentSnapshot(current);
      const baseline = comparable ? sessions.find(s => s.id === baselineId) : undefined;
      if (baselineId && (!comparable || !baseline || !coachingBaselineOptions(current, [baseline])[0].eligible)) {
        setMessage("Choose a different timed attempt and confirm that its climber, route, and recording setup are comparable.");
        return;
      }
      const next = buildCoachingEvidence(current, goal, baseline, {
        distinctAttemptsConfirmed: !!baseline && distinctAttemptFingerprint === coachingEvidenceFingerprint(current, baseline),
      });
      evidenceBaselineId.current = baseline?.id ?? "";
      setEvidence(next); setPlan(next.catalog.defaultPlan);
    } catch (error) { setMessage(error instanceof Error ? error.message : "This analysis does not yet contain usable evidence. Review the timing markers first."); }
  }
  async function hostedReview(loadSaved = false) {
    if (accessCode.trim().toLowerCase().startsWith("nvapi")) { setMessage("Do not enter your NVIDIA API key here. It belongs in server settings. This field takes a separate workspace access code."); return; }
    if (!enabled || !accessCode || (!loadSaved && (!evidence || !consent))) return;
    if (!loadSaved && !evidenceStillMatches()) { rejectStaleReview(); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const requestedReviewId = reviewId;
    setBusy(true); setMessage("");
    try {
      // Local evidence review needs no secure browser API. Reserve a stable ID
      // only when an online generation is requested, retaining it for retries.
      if (!loadSaved && !requestId.current) requestId.current = createUUID();
      const { data, ...response } = await readCoachingResponse(loadSaved ? `/api/coaching?id=${encodeURIComponent(requestedReviewId)}` : "/api/coaching", {
        method: loadSaved ? "GET" : "POST", signal: controller.signal,
        headers: { Authorization: `Bearer ${accessCode}`, ...(loadSaved ? {} : { "Content-Type": "application/json" }) },
        ...(loadSaved ? {} : { body: JSON.stringify({ consent: true, requestId: requestId.current, packet: evidence!.packet }) }),
      });
      if (controller.signal.aborted) return;
      if (!loadSaved && !evidenceStillMatches()) { rejectStaleReview(); return; }
      if (loadSaved && response.ok && data.id !== requestedReviewId) throw new Error("The response does not match the requested saved review. Try loading it again.");
      if (typeof data.id === "string" && /^[\w-]{21}$/.test(data.id)) setReviewId(data.id);
      if (response.status === 202) { setMessage("This review is reserved or still running. Keep its ID and load it later; retrying will not start a duplicate generation."); return; }
      if (!response.ok || data.status !== "complete") throw new Error(typeof data.error === "string" ? data.error : "NIM returned no supported review. Use the local evidence review.");
      const packet = parseCoachingPacket(data.packet); const catalog = buildCoachingCatalog(packet);
      const selected = validateCoachingPlan(data.plan, catalog);
      if (!loadSaved && JSON.stringify(packet) !== JSON.stringify(evidence!.packet)) throw new Error("The response does not match this analysis.");
      // Archived records cannot prove which local video is loaded: never attach seek links.
      if (loadSaved) { setEvidence({ packet, catalog, links: {}, currentName: "Saved numeric review", baselineName: undefined, sourceFingerprint: "" }); setArchived(true); }
      setPlan(selected); setAi(true);
      setMessage(loadSaved ? "Saved AI review loaded. Video links are withheld because this record does not identify your local video." : "NIM selected these points from the approved evidence. No model-written measurements or technique claims are shown.");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Hosted review unavailable. Your local review is unchanged.");
    } finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  const visible = evidence && plan ? plan.observationIds.map(id => evidence.catalog.observations.find(o => o.id === id)!) : [];
  const focus = evidence?.catalog.focuses.find(f => f.id === plan?.focusId);
  function links(id: string) {
    if (!canSeek || archived) return null;
    return evidence?.links[id]?.map(link => <button key={`${id}-${link.label}`} onClick={() => {
      if (!evidenceStillMatches()) { rejectStaleReview(); return; }
      onJump(link.rawTime);
    }} disabled={disabled}>{link.label}</button>);
  }
  return <div className="coaching-panel">
    <div className="coaching-intro"><div><strong>Know what changed. Know what to check.</strong>
      <p>Start with the accepted timing. Add a comparable run to see which measured sections changed and what still needs review.</p></div>
      <span className="coaching-local-badge">Works offline</span></div>
    <div className="coaching-controls">
      <label>Review focus<select value={goal} onChange={e => { invalidate(); setGoal(e.target.value as CoachingGoal); }}>
        <option value="overview">Overview</option><option value="start">Start</option><option value="halves">Sections around Hold 10</option><option value="consistency">Repeatability</option>
      </select></label>
      <label>Optional saved baseline<select value={baselineId} onChange={e => { invalidate(); setBaselineId(e.target.value); setComparable(false); setDistinctAttemptFingerprint(""); }}>
        <option value="">Single-run review</option>{baselineOptions.map(option => <option key={option.id} value={option.id} disabled={!option.eligible}>
          {option.name}{option.date ? ` · ${option.date}` : ""}{option.totalSeconds !== null ? ` · ${option.totalSeconds.toFixed(3)}s` : ""}{option.reason ? ` — ${option.reason}` : ""}
        </option>)}
      </select></label>
    </div>
    <p className="coaching-baseline-note">{baselineId ? `Baseline: ${selectedBaseline?.name ?? "unavailable"}. Compare the same climber on the same route with comparable recording conditions.`
      : baselineOptions.some(option => option.eligible) ? "A baseline adds measured differences. Choosing one does not replace your current attempt."
        : "No different timed baseline is ready yet. You can still review this run locally."}</p>
    {baselineId && <label className="coaching-check"><input type="checkbox" checked={comparable} onChange={e => { invalidate(); setComparable(e.target.checked); }} />I am comparing two distinct attempts by the same climber on the same route with comparable recording conditions</label>}
    {selectedBaseline?.requiresDistinctAttemptConfirmation && <div className="coaching-identity-check">
      <p>{selectedBaseline.warning}</p><label className="coaching-check"><input type="checkbox" checked={distinctAttemptsConfirmed}
        onChange={e => { invalidate(); setDistinctAttemptFingerprint(e.target.checked ? selectedIdentityFingerprint : ""); }} />These overlapping recording details belong to different climbing attempts, not edited copies of one attempt</label>
    </div>}
    <button className="primary" disabled={disabled || (!!baselineId && (!comparable || !selectedBaseline?.eligible || (selectedBaseline.requiresDistinctAttemptConfirmation && !distinctAttemptsConfirmed)))} onClick={localReview}>Review my run</button>
    <p className="coaching-privacy-note">Local review uses saved measurements. It does not upload your video or require an AI account.</p>
    {evidence && plan && <section className="coaching-result" aria-label="Evidence review">
      <p className="coaching-mode">{ai ? "AI-prioritized review · NVIDIA NIM" : "Local evidence review · rule based"}</p>
      <p className="muted">{evidence.currentName}{evidence.baselineName ? ` compared with ${evidence.baselineName}` : " · single-run review"}</p>
      <div className={`coaching-headline ${evidence.catalog.headline.state}`}><h3>{evidence.catalog.headline.title}</h3><p>{evidence.catalog.headline.detail}</p></div>
      {!canSeek && !archived && <p className="coaching-reattach-note">Your saved measurements are available offline. Reattach the original recording to open the source frames.</p>}
      {evidence.catalog.comparisonRows.length > 0 && <div className="coaching-comparison-wrap"><table className="coaching-comparison">
        <caption>Accepted interval comparison <small>Seconds · negative differences are shorter intervals</small></caption>
        <thead><tr><th scope="col">Section</th><th scope="col">Baseline</th><th scope="col">Current</th><th scope="col">Difference</th></tr></thead>
        <tbody>{evidence.catalog.comparisonRows.map(row => <tr key={row.id}>
          <th scope="row">{row.label}</th><td>{row.baselineSeconds.toFixed(3)}s</td><td>{row.currentSeconds.toFixed(3)}s</td>
          <td className={`coaching-delta ${row.outcome}`}><strong>{row.deltaSeconds > 0 ? "+" : row.deltaSeconds < 0 ? "−" : ""}{Math.abs(row.deltaSeconds).toFixed(3)}s</strong>
            <small>{row.outcome === "similar" ? "Within comparison rule" : row.outcome}<br />Rule: {row.thresholdSeconds.toFixed(3)}s</small></td>
        </tr>)}</tbody>
      </table></div>}
      <div className="coaching-observations"><h3 className="coaching-section-label">What the measurements show</h3>
        {visible.length === 0 ? <p>No performance finding is supported yet. Complete the timing check below.</p>
          : visible.map(o => <article key={o.id}><h4>{o.title}</h4><p>{o.text}</p><div className="button-row">{links(o.id)}</div></article>)}
      </div>
      {evidence.catalog.reviewTasks.length > 0 && <section className="coaching-review-tasks" aria-label="Evidence checks still needed">
        <h3 className="coaching-section-label">Checks still needed</h3>
        <p>These are evidence checks, not findings about your technique.</p>
        <ul>{evidence.catalog.reviewTasks.map(task => <li key={task.id} className={task.id === focus?.id ? "next-check" : undefined}>
          <h4>{task.id === focus?.id ? "Next check: " : ""}{task.title}</h4><p>{task.text}</p><div className="button-row">{task.evidenceIds.map(links)}</div>
        </li>)}</ul>
      </section>}
      {focus && !evidence.catalog.reviewTasks.some(task => task.id === focus.id) && <article className="coaching-focus"><h3>Next review: {focus.title}</h3><p>{focus.text}</p><div className="button-row">{focus.evidenceIds.map(links)}</div></article>}
      <details className="coaching-limits" open><summary>Limits of this review</summary>{evidence.catalog.limitations.map(l => <p key={l.id}><strong>{l.title}.</strong> {l.text}</p>)}</details>
    </section>}
    {!LOCAL_APP && <details className="coaching-hosted"><summary>Optional NVIDIA NIM review</summary>
      <p>{enabled ? "NVIDIA can prioritize approved review points. The measurements, comparison table, and required checks stay the same. This private workspace uses a shared access code; anyone with that code and a review link can read the saved review." : "Online AI prioritization is not enabled here. The full local evidence review is available without a connection or account."}</p>
      {enabled && <>
        <label>Workspace access code (not your NVIDIA API key)<input type="password" autoComplete="off" value={accessCode} onChange={e => setAccessCode(e.target.value)} disabled={busy} /></label>
        <label className="coaching-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Send this numeric evidence to NVIDIA and save the review on the server. No video, file names, names, or notes are sent. Records remain until the workspace owner deletes them.</label>
        <button disabled={disabled || busy || ai || !evidence || !consent || !accessCode} onClick={() => void hostedReview()}>{busy ? "Working…" : "Prioritize with NIM"}</button>
        {busy && <button onClick={stopWaiting}>Stop waiting</button>}
        <label>Saved review ID<input value={reviewId} onChange={e => setReviewId(e.target.value)} disabled={busy} /></label>
        <button disabled={busy || !accessCode || !/^[\w-]{21}$/.test(reviewId)} onClick={() => void hostedReview(true)}>Load saved review</button>
        {/^[\w-]{21}$/.test(reviewId) && <p><a href={`?coachingReview=${encodeURIComponent(reviewId)}#coaching-review`}>Saved review link</a> · workspace access code required</p>}
      </>}
    </details>}
    <p role="status" aria-live="polite">{message}</p>
  </div>;
}
