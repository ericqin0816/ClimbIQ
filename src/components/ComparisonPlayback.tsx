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

export default function ComparisonPlayback({ baseline, candidate }: { baseline: SavedAnalysisSession; candidate: SavedAnalysisSession }) {
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

  async function attach(side: Side, file?: File) {
    pause();
    requests.current[side]?.abort();
    const request = new AbortController();
    requests.current[side] = request;
    setLoading(value => ({ ...value, [side]: true }));
    setMessage("");
    try {
      if (!file) {
        const id = practiceIdForLineage(sessions[side].attemptLineageId ?? null);
        const entry = practiceRecordings.find(item => item.id === id);
        if (!entry) throw new Error("Choose the original recording for this attempt.");
        const response = await fetch(resolveAppAssetUrl("samples/" + entry.file, import.meta.env.BASE_URL, location.href), { signal: request.signal });
        if (!response.ok) throw new Error("The practice recording could not be loaded.");
        file = new File([await response.blob()], entry.file, { type: "video/mp4" });
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
      setConfirmed(value => ({ ...value, [side]: false }));
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

  async function position(nextPhase: ComparisonPhase, time: number, play: boolean) {
    pause();
    completedSides.current.clear();
    const token = operation.current;
    const pair = { baseline: comparisonPlaybackRange(baseline, nextPhase), candidate: comparisonPlaybackRange(candidate, nextPhase) };
    if (SIDES.some(side => loading[side]) || !SIDES.every(side => confirmed[side] && ready[side] && pair[side])) return;
    setSeeking(true);
    setPhase(nextPhase);
    setMessage("");
    try {
      await Promise.all(SIDES.map(side => seekTo(players.current[side]!, comparisonPlaybackTime(pair[side]!, time))));
      if (operation.current !== token) return;
      setElapsed(time);
      if (!play) { setSeeking(false); return; }
      await Promise.all(SIDES.map(side => players.current[side]!.play()));
      // Pause/replacement already cancelled this owner. A late play promise must
      // never pause a newer replay using these players.
      if (operation.current !== token) return;
      setSeeking(false);
      playbackActive.current = true;
      setPlaying(true);
      const started = performance.now() - time * 1000;
      const end = Math.max(...SIDES.map(side => pair[side]!.end - pair[side]!.start));
      const tick = () => {
        if (operation.current !== token) return;
        const seconds = Math.min(end, (performance.now() - started) / 1000);
        setElapsed(seconds);
        for (const side of SIDES) {
          const video = players.current[side]!;
          const target = comparisonPlaybackTime(pair[side]!, seconds);
          if (seconds >= pair[side]!.end - pair[side]!.start) {
            if (!completedSides.current.has(side)) {
              completedSides.current.add(side);
              video.pause();
              video.currentTime = pair[side]!.end;
            }
          } else if (Math.abs(video.currentTime - target) > 0.12) video.currentTime = target;
        }
        if (seconds < end) frame.current = requestAnimationFrame(tick);
        else {
          pause();
          for (const side of SIDES) players.current[side]!.currentTime = pair[side]!.end;
        }
      };
      frame.current = requestAnimationFrame(tick);
    } catch (error) {
      if (operation.current === token) {
        pause();
        setMessage(error instanceof Error ? error.message : "Playback stopped. Try replaying this section.");
      }
    }
  }

  return <section className="comparison-playback" aria-label="Synchronized comparison replay">
    <h3>Replay the section that changed</h3>
    <p>Attach each original recording and confirm its attempt. Replay uses equal elapsed time from each section's entry; the faster attempt stops at its own finish. Saved summaries do not contain videos.</p>
    <div className="comparison-players">{SIDES.map(side => <div key={side}>
      <strong>{side === "baseline" ? "Baseline" : "New attempt"}: {sessions[side].name}</strong>
      <label>Attach {side === "baseline" ? "baseline" : "new attempt"} recording<input type="file" accept="video/*" disabled={seeking || loading[side]} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void attach(side, file);
      }} /></label>
      {practiceIdForLineage(sessions[side].attemptLineageId ?? null) && <button disabled={loading[side] || seeking} onClick={() => { void attach(side); }}>Use {side === "baseline" ? "baseline" : "new attempt"} practice recording</button>}
      {loading[side] && <p role="status">Checking recording…</p>}
      {urls[side] && <>
        <video key={urls[side]} ref={node => { if (node) players.current[side] = node; else delete players.current[side]; }} src={urls[side]} muted playsInline preload="auto"
          onLoadedData={event => { if (event.currentTarget.src === sources.current[side]?.objectUrl && event.currentTarget.readyState >= 2) setReady(value => ({ ...value, [side]: true })); }}
          onWaiting={event => { if (event.currentTarget.src === sources.current[side]?.objectUrl && playbackActive.current && !completedSides.current.has(side)) { pause(); setMessage("Playback buffered. Replay this section when the recordings are ready."); } }}
          onError={event => { if (event.currentTarget.src !== sources.current[side]?.objectUrl) return; pause(); setReady(value => ({ ...value, [side]: false })); setMessage("This attached recording could not be decoded. Choose its original file again."); }} />
        <label className="comparison-recording-check"><input type="checkbox" checked={confirmed[side] === true} onChange={event => { pause(); setConfirmed(value => ({ ...value, [side]: event.target.checked })); }} />This is the original recording for {sessions[side].name}</label>
      </>}
    </div>)}</div>
    <div className="button-row">
      <button disabled={!canReplay || seeking} onClick={() => { void position("total", 0, true); }}>Replay whole attempt</button>
      {(["bottom", "top"] as const).map(value => <button key={value} disabled={!canReplay || seeking || !comparisonPlaybackRange(baseline, value) || !comparisonPlaybackRange(candidate, value)} onClick={() => { void position(value, 0, true); }}>Replay {value} phase</button>)}
      <button disabled={!playing && !seeking} onClick={pause}>Pause comparison</button>
    </div>
    <label>Section elapsed: {elapsed.toFixed(2)}s<input aria-label="Comparison elapsed time" type="range" min="0" max={maximum || 1} step="0.033333" value={Math.min(maximum, elapsed)} disabled={!canReplay || seeking} onChange={event => { void position(phase, Number(event.target.value), false); }} /></label>
    <p className="muted">Bottom and top replay require a frame-reviewed Hold 10 marker in both attempts. Filename and duration matches alone never establish recording identity.</p>
    {message && <p role="alert">{message}</p>}
  </section>;
}
