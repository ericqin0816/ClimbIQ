import { useEffect, useRef, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { prepareVideo, type PreparedVideo } from "../lib/preparedVideo";
import { comparisonPlaybackRange, comparisonPlaybackTime, type ComparisonPhase } from "../lib/comparisonPlayback";
import { seekTo } from "../lib/videoFrameSampler";
import { practiceIdForLineage, practiceRecordings } from "../lib/practiceRecordings";
import { resolveAppAssetUrl } from "../lib/appAssets";
import "./ComparisonPlayback.css";

const SIDES = ["baseline", "candidate"] as const;
type Side = typeof SIDES[number];

export default function ComparisonPlayback({ baseline, candidate, preferredPhase }: { baseline: SavedAnalysisSession; candidate: SavedAnalysisSession; preferredPhase?: "bottom" | "top" }) {
  const sessions = { baseline, candidate };
  const players = useRef<Partial<Record<Side, HTMLVideoElement>>>({});
  const sources = useRef<Partial<Record<Side, PreparedVideo>>>({});
  const requests = useRef<Partial<Record<Side, AbortController>>>({});
  const operation = useRef(0);
  const playbackActive = useRef(false);
  const completedSides = useRef(new Set<Side>());
  const frame = useRef<number | null>(null);
  const [urls, setUrls] = useState<Partial<Record<Side, string>>>({});
  const [confirmed, setConfirmed] = useState<Partial<Record<Side, boolean>>>({});
  const [verifiedPractice, setVerifiedPractice] = useState<Partial<Record<Side, boolean>>>({});
  const [ready, setReady] = useState<Partial<Record<Side, boolean>>>({});
  const [loading, setLoading] = useState<Partial<Record<Side, boolean>>>({});
  const [message, setMessage] = useState("");
  const [playing, setPlaying] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [phase, setPhase] = useState<ComparisonPhase>("total");
  const [elapsed, setElapsed] = useState(0);
  const ranges = { baseline: comparisonPlaybackRange(baseline, phase), candidate: comparisonPlaybackRange(candidate, phase) };
  const maximum = Math.max(...SIDES.map(side => ranges[side] ? ranges[side]!.end - ranges[side]!.start : 0));
  const canReplay = !SIDES.some(side => loading[side]) && SIDES.every(side => urls[side] && confirmed[side] && ready[side] && ranges[side]);
  const baselinePractice = practiceIdForLineage(baseline.attemptLineageId ?? null);
  const candidatePractice = practiceIdForLineage(candidate.attemptLineageId ?? null);
  const practicePair = baselinePractice !== null && candidatePractice !== null && baselinePractice !== candidatePractice;
  const practicePairReady = canReplay && SIDES.every(side => verifiedPractice[side]);
  const canReplayPreferred = canReplay && preferredPhase && comparisonPlaybackRange(baseline, preferredPhase) && comparisonPlaybackRange(candidate, preferredPhase);
  const phaseLabel = phase === "bottom" ? "Bottom: start → Hold 10" : phase === "top" ? "Top: Hold 10 → finish" : "Whole attempt";
  const playbackStatus = seeking ? "Preparing frame" : playing ? "Playing" : maximum > 0 && elapsed >= maximum ? "Finished" : elapsed > 0 ? "Paused" : "Ready";

  function pause() {
    playbackActive.current = false;
    operation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    for (const side of SIDES) players.current[side]?.pause();
    setPlaying(false);
    setSeeking(false);
  }

  useEffect(() => () => {
    operation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    for (const side of SIDES) {
      requests.current[side]?.abort();
      players.current[side]?.pause();
      sources.current[side]?.dispose();
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) pause(); };
    const onPageHide = () => pause();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  async function attach(side: Side, file?: File, associatePractice = false) {
    pause();
    requests.current[side]?.abort();
    const request = new AbortController();
    requests.current[side] = request;
    setLoading(value => ({ ...value, [side]: true }));
    setMessage("");
    try {
      let verified = false;
      if (!file) {
        const id = practiceIdForLineage(sessions[side].attemptLineageId ?? null);
        const entry = practiceRecordings.find(item => item.id === id);
        if (!entry) throw new Error("Choose the original recording for this attempt.");
        const response = await fetch(resolveAppAssetUrl("samples/" + entry.file, import.meta.env.BASE_URL, location.href), { signal: request.signal });
        if (!response.ok) throw new Error("The practice recording could not be loaded.");
        const bytes = await response.arrayBuffer();
        if (!globalThis.crypto?.subtle) throw new Error("This browser cannot verify the bundled recording. Choose its original file and confirm the attempt instead.");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
        if (hash !== entry.sha256) throw new Error("Practice recording integrity check failed. Reload ClimbIQ and try again.");
        if (request.signal.aborted) return;
        file = new File([bytes], entry.file, { type: "video/mp4" });
        verified = associatePractice;
      }
      const prepared = await prepareVideo(file, { signal: request.signal });
      if (request.signal.aborted || requests.current[side] !== request) { prepared.dispose(); return; }
      const range = comparisonPlaybackRange(sessions[side], "total");
      if (!range || range.end > prepared.metadata.duration) {
        prepared.dispose();
        throw new Error("This recording does not contain the saved attempt's complete time range.");
      }
      pause();
      sources.current[side]?.dispose();
      sources.current[side] = prepared;
      setConfirmed(value => ({ ...value, [side]: verified }));
      setVerifiedPractice(value => ({ ...value, [side]: verified }));
      setReady(value => ({ ...value, [side]: false }));
      setUrls(value => ({ ...value, [side]: prepared.objectUrl }));
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not attach this recording.");
    } finally {
      if (requests.current[side] === request) {
        requests.current[side] = undefined;
        setLoading(value => ({ ...value, [side]: false }));
      }
    }
  }

  function preparePracticePair() {
    if (!practicePair || seeking || SIDES.some(side => loading[side])) return;
    // Both assets have independent abort owners. Each must match its bundled
    // content hash before its canonical practice lineage is associated.
    void Promise.all(SIDES.map(side => attach(side, undefined, true)));
  }

  async function position(nextPhase: ComparisonPhase, time: number, play: boolean, reveal = true) {
    pause();
    completedSides.current.clear();
    const token = operation.current;
    const pair = { baseline: comparisonPlaybackRange(baseline, nextPhase), candidate: comparisonPlaybackRange(candidate, nextPhase) };
    const pairPlayers = { ...players.current };
    const pairSources = { baseline: pairPlayers.baseline?.src, candidate: pairPlayers.candidate?.src };
    if (SIDES.some(side => loading[side]) || !SIDES.every(side => confirmed[side] && ready[side] && pair[side] &&
      pairPlayers[side] && pairSources[side] === sources.current[side]?.objectUrl)) return;
    const current = () => operation.current === token && SIDES.every(side =>
      players.current[side] === pairPlayers[side] && pairPlayers[side]!.src === pairSources[side] &&
      sources.current[side]?.objectUrl === pairSources[side]);
    const end = Math.max(...SIDES.map(side => pair[side]!.end - pair[side]!.start));
    const positionTime = Math.max(0, Math.min(time, end));
    for (const side of SIDES) if (positionTime >= pair[side]!.end - pair[side]!.start) completedSides.current.add(side);
    if (play && reveal) document.getElementById("comparison-replay")?.scrollIntoView({ block: "start", behavior: "instant" });
    setSeeking(true);
    setPhase(nextPhase);
    setMessage("");
    try {
      await Promise.all(SIDES.map(side => seekTo(pairPlayers[side]!, comparisonPlaybackTime(pair[side]!, positionTime), { exact: true })));
      if (!current()) return;
      setElapsed(positionTime);
      if (!play || completedSides.current.size === SIDES.length) { setSeeking(false); return; }
      await Promise.all(SIDES.filter(side => !completedSides.current.has(side)).map(side => pairPlayers[side]!.play()));
      // Pause/replacement already cancelled this owner. A late play promise must
      // never pause a newer replay using these players.
      if (!current()) return;
      setSeeking(false);
      playbackActive.current = true;
      setPlaying(true);
      const started = performance.now() - positionTime * 1000;
      const tick = () => {
        if (!current()) return;
        const seconds = Math.min(end, (performance.now() - started) / 1000);
        setElapsed(seconds);
        const boundaryReached = SIDES.some(side => !completedSides.current.has(side) &&
          seconds >= pair[side]!.end - pair[side]!.start);
        const correctionNeeded = SIDES.some(side => !completedSides.current.has(side) &&
          Math.abs(pairPlayers[side]!.currentTime - comparisonPlaybackTime(pair[side]!, seconds)) > 0.12);
        if (seconds >= end || boundaryReached || correctionNeeded) {
          // Seeking active players can itself emit waiting at readyState 1.
          // Give the pair one paused preparation owner, preserve elapsed time
          // while decoding, and resume only sides that have not finished.
          void position(nextPhase, seconds, seconds < end, false);
          return;
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    } catch (error) {
      if (current()) {
        pause();
        setMessage(error instanceof Error ? error.message : "Playback stopped. Try replaying this section.");
      }
    }
  }

  return <section id="comparison-replay" tabIndex={-1} className="comparison-playback" aria-label="Synchronized comparison replay">
    <h3>Replay the section that changed</h3>
    {!canReplay && <p>{practicePair ? "Prepare the two included practice recordings, then replay the changed phase."
      : "Attach each original recording and confirm its attempt."}</p>}
    <div className="comparison-replay-next">
      {practicePair && !practicePairReady && <button className="primary" disabled={seeking || SIDES.some(side => loading[side])} onClick={preparePracticePair}>Prepare practice replay</button>}
      {preferredPhase && <button className={canReplayPreferred ? "primary" : undefined} disabled={!canReplayPreferred || seeking} onClick={() => { void position(preferredPhase, 0, true); }}>Replay changed {preferredPhase} phase</button>}
      {!preferredPhase && <button className={canReplay ? "primary" : undefined} disabled={!canReplay || seeking} aria-pressed={phase === "total"} onClick={() => { void position("total", 0, true); }}>Replay whole attempt</button>}
      {(canReplay || playing || seeking) && <button disabled={!playing && !seeking} onClick={pause}>Pause comparison</button>}
      {practicePairReady && <p role="status">Practice replay ready. Both bundled recordings are verified.</p>}
      {!practicePair && !canReplay && <p>Attach and confirm both recordings below to enable replay.</p>}
    </div>
    <p className="comparison-playback-status" role="status">{phaseLabel} · {playbackStatus}</p>
    <div className={`comparison-players${canReplay ? " is-ready" : ""}`}>{SIDES.map(side => {
      const column = side === "baseline" ? 1 : 2;
      const sideReady = confirmed[side] === true && ready[side] === true;
      return <div className="comparison-player" key={side}>
        <strong className="comparison-player-name" style={{ gridColumn: column }}>{side === "baseline" ? "Baseline" : "New attempt"}: {sessions[side].name}</strong>
        <div className="comparison-player-source" style={{ gridColumn: column }}>
          <details className="comparison-change-recording" open={!sideReady}>
            <summary hidden={!sideReady}>Change {side === "baseline" ? "baseline" : "new attempt"} recording</summary>
            <div className="comparison-attachment-fields">
              <label>Attach {side === "baseline" ? "baseline" : "new attempt"} recording<input type="file" accept="video/*" disabled={seeking || loading[side]} onChange={event => {
                const file = event.target.files?.[0]; event.target.value = ""; if (file) void attach(side, file);
              }} /></label>
              {practiceIdForLineage(sessions[side].attemptLineageId ?? null) && <button disabled={loading[side] || seeking} onClick={() => { void attach(side); }}>Use {side === "baseline" ? "baseline" : "new attempt"} practice recording</button>}
            </div>
          </details>
          {loading[side] && <p role="status">Checking recording…</p>}
          {urls[side] && (verifiedPractice[side] ? <small className="comparison-verified">Verified bundled synthetic recording</small>
            : <label className="comparison-recording-check"><input type="checkbox" checked={confirmed[side] === true} onChange={event => { pause(); setConfirmed(value => ({ ...value, [side]: event.target.checked })); }} />This is the original recording for {sessions[side].name}</label>)}
        </div>
        {urls[side] && <div className="comparison-player-media" style={{ gridColumn: column }}>
          <video key={urls[side]} aria-label={`${side === "baseline" ? "Baseline" : "New attempt"} recording: ${sessions[side].name}`} ref={node => { if (node) players.current[side] = node; else delete players.current[side]; }} src={urls[side]} muted playsInline preload="auto"
            onLoadedData={event => { if (event.currentTarget.src === sources.current[side]?.objectUrl && event.currentTarget.readyState >= 2) setReady(value => ({ ...value, [side]: true })); }}
            onWaiting={event => {
              // A queued waiting notice can arrive after native readiness has
              // recovered. Pause the pair only while this decoder still lacks
              // future data; preserve the current-stall and ownership guards.
              if (event.currentTarget.src === sources.current[side]?.objectUrl && playbackActive.current &&
                  !completedSides.current.has(side) && event.currentTarget.readyState < 3) {
                pause(); setMessage("Playback buffered. Replay this section when the recordings are ready.");
              }
            }}
            onError={event => { if (event.currentTarget.src !== sources.current[side]?.objectUrl) return; pause(); setReady(value => ({ ...value, [side]: false })); setMessage("This attached recording could not be decoded. Choose its original file again."); }} />
        </div>}
      </div>;
    })}</div>
    <details className="comparison-replay-help">
      <summary>How replay is synchronized</summary>
      <p>Replay uses equal elapsed time from each section's entry; the faster attempt stops at its own finish. Saved summaries do not contain videos.</p>
    </details>
    <div className="button-row">
      {preferredPhase && <button disabled={!canReplay || seeking} aria-pressed={phase === "total"} onClick={() => { void position("total", 0, true); }}>Replay whole attempt</button>}
      {(["bottom", "top"] as const).map(value => <button key={value} aria-pressed={phase === value} disabled={!canReplay || seeking || !comparisonPlaybackRange(baseline, value) || !comparisonPlaybackRange(candidate, value)} onClick={() => { void position(value, 0, true); }}>Replay {value} phase</button>)}
    </div>
    <label>Section elapsed: {elapsed.toFixed(2)}s<input aria-label="Comparison elapsed time" type="range" min="0" max={maximum || 1} step="0.033333" value={Math.min(maximum, elapsed)} disabled={!canReplay || seeking} onChange={event => { void position(phase, Number(event.target.value), false); }} /></label>
    <p className="muted">Bottom and top replay require a frame-reviewed Hold 10 marker in both attempts. Filename and duration matches alone never establish recording identity.</p>
    {message && <p role="alert">{message}</p>}
  </section>;
}
