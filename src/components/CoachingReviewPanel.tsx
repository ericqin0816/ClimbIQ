import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { buildCoachingEvidence, type CoachingEvidence } from "../lib/coachingEvidence";
import { buildCoachingCatalog, parseCoachingPacket, validateCoachingPlan, type CoachingGoal, type CoachingPlan } from "../lib/coachingPolicy";
import "./CoachingReviewPanel.css";

export default function CoachingReviewPanel({ getCurrentSession, sessions, onJump, disabled }: {
  getCurrentSession: () => SavedAnalysisSession; sessions: SavedAnalysisSession[];
  onJump: (time: number) => void; disabled: boolean;
}) {
  const [goal, setGoal] = useState<CoachingGoal>("overview");
  const [baselineId, setBaselineId] = useState("");
  const [comparable, setComparable] = useState(false);
  const [evidence, setEvidence] = useState<CoachingEvidence | null>(null);
  const [plan, setPlan] = useState<CoachingPlan | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [localAccess, setLocalAccess] = useState(false);
  const [connection, setConnection] = useState<"checking" | "ready" | "error">("checking");
  const [consent, setConsent] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(false);
  const [reviewId, setReviewId] = useState(() => new URLSearchParams(location.search).get("coachingReview") ?? "");
  const request = useRef<AbortController | null>(null);
  const requestId = useRef("");
  const connectionRequest = useRef<AbortController | null>(null);
  const checkConnection = useCallback(async () => {
    connectionRequest.current?.abort();
    const controller = new AbortController();
    connectionRequest.current = controller; setConnection("checking");
    try {
      const response = await fetch("/api/coaching?status=1", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data?.enabled !== "boolean") throw new Error();
      if (controller.signal.aborted) return;
      setEnabled(data.enabled); setLocalAccess(data.enabled && data.localAccess === true); setConnection("ready");
    } catch {
      if (!controller.signal.aborted) { setEnabled(false); setLocalAccess(false); setConnection("error"); }
    }
  }, []);
  useEffect(() => {
    void checkConnection();
    const refresh = () => { void checkConnection(); };
    window.addEventListener("focus", refresh);
    return () => { connectionRequest.current?.abort(); request.current?.abort(); window.removeEventListener("focus", refresh); };
  }, [checkConnection]);
  function invalidate() {
    request.current?.abort(); setBusy(false); setEvidence(null); setPlan(null); setAi(false); setMessage(""); requestId.current = "";
  }
  function localReview() {
    invalidate();
    try {
      const current = getCurrentSession();
      const baseline = comparable ? sessions.find(s => s.id === baselineId && s.id !== current.id) : undefined;
      const next = buildCoachingEvidence(current, goal, baseline);
      setEvidence(next); setPlan(next.catalog.defaultPlan); requestId.current = crypto.randomUUID();
    } catch { setMessage("This analysis does not yet contain usable evidence. Review the timing markers first."); }
  }
  async function hostedReview(loadSaved = false) {
    if (accessCode.trim().toLowerCase().startsWith("nvapi")) { setMessage("Do not enter your NVIDIA API key here. It belongs in server settings. This field takes a separate workspace access code."); return; }
    if (!enabled || (!localAccess && !accessCode) || (!loadSaved && (!evidence || !consent))) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(loadSaved ? `/api/coaching?id=${encodeURIComponent(reviewId)}` : "/api/coaching", {
        method: loadSaved ? "GET" : "POST", signal: controller.signal,
        headers: { ...(localAccess ? { "X-Climbiq-Local": "1" } : { Authorization: `Bearer ${accessCode}` }), ...(loadSaved ? {} : { "Content-Type": "application/json" }) },
        ...(loadSaved ? {} : { body: JSON.stringify({ consent: true, requestId: requestId.current, packet: evidence!.packet }) }),
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (typeof data.id === "string" && /^[\w-]{21}$/.test(data.id)) setReviewId(data.id);
      if (response.status === 202) { setMessage("This review is reserved or still running. Keep its ID and load it later; retrying will not start a duplicate generation."); return; }
      if (!response.ok || data.status !== "complete") throw new Error(data.error ?? "NIM returned no supported review. Use the local evidence review.");
      const packet = parseCoachingPacket(data.packet); const catalog = buildCoachingCatalog(packet);
      const selected = validateCoachingPlan(data.plan, catalog);
      if (!loadSaved && JSON.stringify(packet) !== JSON.stringify(evidence!.packet)) throw new Error("The response does not match this analysis.");
      // Archived records cannot prove which local video is loaded: never attach seek links.
      if (loadSaved) setEvidence({ packet, catalog, links: {}, currentName: "Saved numeric review", baselineName: undefined, sectionReview: { items: [], note: "Load the original analysis to inspect video sections." } });
      setPlan(selected); setAi(true);
      setMessage(loadSaved ? "Saved AI review loaded. Video links are withheld because this record does not identify your local video." : "NIM selected these points from the approved evidence. No model-written measurements or technique claims are shown.");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Hosted review unavailable. Your local review is unchanged.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const visible = evidence && plan ? plan.observationIds.map(id => evidence.catalog.observations.find(o => o.id === id)!) : [];
  const focus = evidence?.catalog.focuses.find(f => f.id === plan?.focusId);
  function links(id: string) {
    return evidence?.links[id]?.map(link => <button key={`${id}-${link.label}`} onClick={() => onJump(link.rawTime)} disabled={disabled}>{link.label}</button>);
  }
  return <div className="coaching-panel">
    <p className="muted">Turn accepted measurements into a short review. Uncertain contact, tracking gaps, and unsupported technique claims stay out of the conclusions.</p>
    <div className="coaching-controls">
      <label>Review focus<select value={goal} onChange={e => { invalidate(); setGoal(e.target.value as CoachingGoal); }}>
        <option value="overview">Overview</option><option value="start">Start</option><option value="halves">Bottom and top halves</option><option value="consistency">Consistency</option>
      </select></label>
      <label>Optional saved baseline<select value={baselineId} onChange={e => { invalidate(); setBaselineId(e.target.value); setComparable(false); }}>
        <option value="">Single-run review</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
    </div>
    {baselineId && <label className="coaching-check"><input type="checkbox" checked={comparable} onChange={e => { invalidate(); setComparable(e.target.checked); }} />Same climber and comparable recording setup</label>}
    <button className="primary" disabled={disabled || (!!baselineId && !comparable)} onClick={localReview}>Review my run</button>
    <section className="coaching-hosted" aria-label="AI review">
      <h3>AI review</h3>
      <p>{connection === "checking" ? "Checking AI connection…" : connection === "error" ? "Could not reach the AI server. Refresh the connection to try again; your analysis stays here." : localAccess ? "AI is connected on this computer. No access code needed." : enabled ? "Private workspace connected. Enter its workspace access code below." : "AI is not configured for this address. Settings on your Mac do not enable the public website. For your configured Mac setup, open http://127.0.0.1:5173/."}</p>
      <button disabled={connection === "checking"} onClick={() => void checkConnection()}>Refresh AI connection</button>
      {enabled && <>
        {!localAccess && <label>Workspace access code (not your NVIDIA API key)<input type="password" autoComplete="off" value={accessCode} onChange={e => setAccessCode(e.target.value)} /></label>}
        <label className="coaching-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Send this numeric evidence to NVIDIA and save the review on the server. No video, file names, names, or notes are sent. Records remain until the workspace owner deletes them.</label>
      </>}
      <button className="primary" disabled={!enabled || connection !== "ready" || disabled || busy || ai || !evidence || !consent || (!localAccess && !accessCode)} onClick={() => void hostedReview()}>{busy ? "Getting AI review…" : "Get AI review"}</button>
      <p role="status" aria-live="polite">{message}</p>
      {enabled && !evidence && <p>Choose Review my run above to prepare the measurements for AI.</p>}
      {enabled && evidence && !consent && <p>Check the sharing consent box to enable Get AI review.</p>}
      {enabled && <details><summary>Open a saved AI review</summary>
        <label>Saved review ID<input value={reviewId} onChange={e => setReviewId(e.target.value)} /></label>
        <button disabled={busy || (!localAccess && !accessCode) || !/^[\w-]{21}$/.test(reviewId)} onClick={() => void hostedReview(true)}>Load saved review</button>
        {/^[\w-]{21}$/.test(reviewId) && <p><a href={`?coachingReview=${encodeURIComponent(reviewId)}#coaching-review`}>Saved review link</a>{!localAccess && " · workspace access code required"}</p>}
      </details>}
    </section>
    {evidence && plan && <section className="coaching-result" aria-label="Evidence review">
      <p className="coaching-mode">{ai ? "AI-prioritized review · NVIDIA NIM" : "Local evidence review · not AI"}</p>
      <p className="muted">{evidence.currentName}{evidence.baselineName ? ` compared with ${evidence.baselineName}` : " · single-run review"}</p>
      <section aria-label="Sections to review">
        <h3>Sections to review</h3>
        <p className="muted">From local measurements · not AI technique analysis</p>
        {evidence.sectionReview.items.map(section => <article key={section.id}>
          <h4>{section.label}</h4>
          <p>{section.seconds.toFixed(3)}s{section.baselineSeconds !== undefined ? ` · baseline ${section.baselineSeconds.toFixed(3)}s` : ""} · {section.evidence}</p>
          <p>{section.text}</p>
          <div className="button-row">
            <button disabled={disabled} onClick={() => onJump(section.startRawTime)}>View {section.label} entry</button>
            <button disabled={disabled} onClick={() => onJump(section.endRawTime)}>View {section.label} exit</button>
          </div>
        </article>)}
        <p>{evidence.sectionReview.note}</p>
      </section>
      {visible.map(o => <article key={o.id}><h3>{o.title}</h3><p>{o.text}</p><div className="button-row">{links(o.id)}</div></article>)}
      {focus && <article className="coaching-focus"><h3>Next focus: {focus.title}</h3><p>{focus.text}</p><div className="button-row">{focus.evidenceIds.map(links)}</div></article>}
      <details open><summary>Limits of this review</summary>{evidence.catalog.limitations.map(l => <p key={l.id}><strong>{l.title}.</strong> {l.text}</p>)}</details>
    </section>}
  </div>;
}
