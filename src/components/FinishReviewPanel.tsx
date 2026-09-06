import { useEffect, useRef, useState } from "react";
import type { NormalizedZone } from "../types";
import type { FinishPadRecovery } from "../lib/finishPadRecoveryScan";
import { captureFinishReviewFrame, finishReviewCrop, normalizeFinishPadZone,
  type FinishReviewFrame, type FinishReviewScan } from "../lib/finishReview";
import "./FinishReviewPanel.css";

interface Props {
  video: HTMLVideoElement | null;
  currentTime: number;
  frameReady: boolean;
  busy: boolean;
  scanning: boolean;
  progress: string;
  zone?: NormalizedZone;
  contextZone?: NormalizedZone;
  automaticRecovery?: FinishPadRecovery;
  onZone: (zone?: NormalizedZone) => void;
  onScan: (zone: NormalizedZone, center: number) => Promise<FinishReviewScan>;
  onCancel: () => void;
  onJump: (time: number) => void;
}

export default function FinishReviewPanel(props: Props) {
  const [closeup, setCloseup] = useState<FinishReviewFrame | null>(null);
  const [selection, setSelection] = useState<FinishReviewFrame | null>(null);
  const [fullSelection, setFullSelection] = useState(false);
  const [corner, setCorner] = useState<{ x: number; y: number } | null>(null);
  const [bounds, setBounds] = useState({ x1: "40", y1: "5", x2: "60", y2: "20" });
  const [error, setError] = useState("");
  const [scan, setScan] = useState<FinishReviewScan | null>(null);
  const generation = useRef(0);
  const zoneKey = JSON.stringify(props.zone ?? null);
  const automatic = props.automaticRecovery;
  const cropZone = props.zone ?? automatic?.target ?? props.contextZone;
  const cropKey = JSON.stringify(cropZone ?? null);
  const displayedScan = scan ?? (!props.zone ? automatic?.review : undefined);
  const video = props.video;
  const ready = props.frameReady && !props.busy && Boolean(video?.paused && !video.seeking && video.readyState >= 2);

  useEffect(() => {
    generation.current += 1;
    setScan(null);
    return () => { generation.current += 1; };
  }, [zoneKey, video]);

  useEffect(() => {
    if (props.busy && !props.scanning) {
      generation.current += 1;
      setScan(null); setSelection(null); setCorner(null);
    }
  }, [props.busy, props.scanning]);

  useEffect(() => {
    if (!video || !ready) { setCloseup(null); return; }
    try { setCloseup(captureFinishReviewFrame(video, finishReviewCrop(cropZone))); }
    catch { setCloseup(null); }
    // Coordinates, not parent object/function identity, control recapture.
  }, [video, props.currentTime, ready, cropKey]);

  function markPad(full = false) {
    if (!video || !ready) return;
    try {
      setSelection(captureFinishReviewFrame(video, { id: "finishPad", label: "Pad selection", x1: 0, y1: 0, x2: 1, y2: full ? 1 : 0.4 }, 640));
      setFullSelection(full);
      if (props.zone) setBounds({ x1: String(props.zone.x1 * 100), y1: String(props.zone.y1 * 100),
        x2: String(props.zone.x2 * 100), y2: String(props.zone.y2 * 100) });
      setCorner(null); setError("");
    } catch (failure) { setError(String(failure)); }
  }
  function applyArea() {
    if (props.busy) return;
    const numbers = Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value.trim() === "" ? NaN : Number(value) / 100])) as unknown as NormalizedZone;
    const zone = normalizeFinishPadZone(numbers);
    if (!zone) { setError("Choose a visible pad area with two different corners, smaller than a quarter of the image."); return; }
    props.onZone(zone); setSelection(null); setError(""); setScan(null);
  }
  async function rescan() {
    if (!props.zone || !ready || !video) return;
    const request = ++generation.current;
    setError(""); setScan(null);
    try {
      const result = await props.onScan(props.zone, video.currentTime);
      if (request === generation.current) setScan(result);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Finish rescan stopped.");
    }
  }

  return <div className="finish-review-tools" data-finish-review-tools>
    <h4>Finish close-up <span>Manual review</span></h4>
    {!selection && <>
      {ready && closeup ? <figure className="finish-closeup">
        <img src={closeup.imageUrl} alt={props.zone ? "Marked finish pad with surrounding context at the current video frame" : "Upper finish area at the current video frame"} />
        <figcaption>{closeup.rawTime.toFixed(3)}s · {closeup.timeSource === "decoded-frame" ? "decoded frame" : "approximate cursor"} · {props.zone ? "marked area" : automatic?.target ? "automatic target · unverified" : "unverified overview"}</figcaption>
      </figure> : <p className="muted">Pause and wait for the frame to see a synchronized close-up.</p>}
      <div className="finish-review-buttons">
        <button disabled={!ready} onClick={() => markPad()}>{props.zone ? "Edit pad area" : "Mark finish pad"}</button>
        <button disabled={!ready || !props.zone} onClick={() => void rescan()}>Rescan near current frame</button>
        {props.zone && <button disabled={props.busy} onClick={() => { props.onZone(undefined); setScan(null); }}>Clear pad area</button>}
        {props.scanning && <button onClick={props.onCancel}>Cancel finish rescan</button>}
      </div>
      <p className="finish-review-help">{!props.zone && automatic?.target
        ? "Check that the automatic crop contains the actual pad, not a scoreboard. Mark a different area if needed. Use fixed-camera footage."
        : "Mark the actual pad, not the scoreboard. Use a fixed-camera shot; re-mark after camera movement. A rescan inspects ±1.25 seconds without changing accepted timing."}</p>
      {!props.zone && automatic && <p className="finish-review-help" data-automatic-finish-review>{automatic.review
        ? `Automatically located target. Approach window: ${automatic.review.start.toFixed(2)}–${automatic.review.end.toFixed(2)}s. Review required; no Finish was accepted.`
        : automatic.reason}</p>}
    </>}
    {selection && <div className="finish-pad-selection">
      <p>Click two opposite corners around the pad, or enter percentages below. Frame: {selection.rawTime.toFixed(3)}s.</p>
      <button disabled={!ready} onClick={() => markPad(!fullSelection)}>{fullSelection ? "Zoom selection to upper wall" : "Show full frame for marking"}</button>
      <button type="button" className={`finish-pad-image${fullSelection ? " full-frame" : ""}`} aria-label="Mark a pad corner on the selection image" disabled={props.busy}
        onClick={event => {
          // Keyboard users have equivalent labelled coordinate inputs below.
          if (event.detail === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * (fullSelection ? 1 : 0.4) };
          if (!corner) { setCorner(point); return; }
          setBounds({ x1: (Math.min(corner.x, point.x) * 100).toFixed(2), y1: (Math.min(corner.y, point.y) * 100).toFixed(2),
            x2: (Math.max(corner.x, point.x) * 100).toFixed(2), y2: (Math.max(corner.y, point.y) * 100).toFixed(2) });
          setCorner(null);
        }}>
        <img src={selection.imageUrl} alt={fullSelection ? "Full paused frame for marking the finish pad" : "Enlarged upper wall for marking the finish pad"} />
        {corner ? <span className="finish-pad-corner" style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100 / (fullSelection ? 1 : 0.4)}%` }} />
          : <span className="finish-pad-box" style={{ left: `${Math.min(Number(bounds.x1), Number(bounds.x2))}%`, top: `${Math.min(Number(bounds.y1), Number(bounds.y2)) / (fullSelection ? 1 : 0.4)}%`,
            width: `${Math.abs(Number(bounds.x2) - Number(bounds.x1))}%`, height: `${Math.abs(Number(bounds.y2) - Number(bounds.y1)) / (fullSelection ? 1 : 0.4)}%` }} />}
      </button>
      <p role="status">{corner ? "First corner set. Choose the opposite corner." : "Choose two corners, then use this pad area."}</p>
      <div className="finish-pad-coordinates">{(["x1", "y1", "x2", "y2"] as const).map((key, index) =>
        <label key={key}>{["Left %", "Top %", "Right %", "Bottom %"][index]}
          <input type="number" min="0" max="100" step="0.1" disabled={props.busy} value={bounds[key]} onChange={event => setBounds(current => ({ ...current, [key]: event.target.value }))} />
        </label>)}</div>
      <div className="finish-review-buttons"><button disabled={props.busy || Boolean(corner)} onClick={applyArea}>Use this pad area</button>
        <button disabled={props.busy} onClick={() => { setSelection(null); setCorner(null); setError(""); }}>Cancel marking</button></div>
    </div>}
    {props.scanning && <p role="status">{props.progress}</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {displayedScan && <div className="finish-rescan-result">
      <p>{displayedScan.reason}</p>
      <div className="finish-review-filmstrip">{displayedScan.frames.map((frame, index) => <button key={`${frame.cursorTime}-${index}`} disabled={props.busy}
        onClick={() => props.onJump(frame.cursorTime)} aria-label={`Inspect finish close-up at ${frame.rawTime.toFixed(3)} seconds`}>
        <img src={frame.imageUrl} alt={`Nearby finish frame ${index + 1}`} /><span>{frame.rawTime.toFixed(3)}s</span>
      </button>)}</div>
      <p className="muted">{displayedScan.comparedFrames} compared samples · {displayedScan.nativeTimedFrames} with native frame timing. Thumbnails navigate the full video; they never accept Finish.</p>
    </div>}
  </div>;
}
