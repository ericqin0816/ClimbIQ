import { useEffect, useRef, useState } from "react";
import type { NormalizedZone, StartSignalDetectionResult } from "../types";
import { normalizeFinishIndicatorZone } from "../lib/guidedFinishIndicator";
import { readDecodedVideoFrameTime } from "../lib/decodedVideoFrame";
import { bindTrackedFinishIndicatorAnchor, captureTrackedFinishIndicatorFrame, isTrackedFinishIndicatorAnchorCurrent,
  type TrackedFinishIndicatorAnchor, type TrackedFinishIndicatorFrameToken, type TrackedFinishIndicatorReview } from "../lib/trackedFinishIndicator";
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
  indicatorZone?: NormalizedZone;
  onIndicatorZone?: (zone?: NormalizedZone) => void;
  onIndicatorScan?: (zone: NormalizedZone, center: number) => Promise<StartSignalDetectionResult>;
  onIndicatorTrack?: (anchor: TrackedFinishIndicatorAnchor) => Promise<TrackedFinishIndicatorReview>;
  automaticRecovery?: FinishPadRecovery;
  onZone: (zone?: NormalizedZone) => void;
  onScan: (zone: NormalizedZone, center: number) => Promise<FinishReviewScan>;
  onCancel: () => void;
  onJump: (time: number) => void;
}

export default function FinishReviewPanel(props: Props) {
  const [closeup, setCloseup] = useState<FinishReviewFrame | null>(null);
  const [closeupTracked, setCloseupTracked] = useState(false);
  const [selection, setSelection] = useState<FinishReviewFrame | null>(null);
  const [fullSelection, setFullSelection] = useState(false);
  const [corner, setCorner] = useState<{ x: number; y: number } | null>(null);
  const [bounds, setBounds] = useState({ x1: "40", y1: "5", x2: "60", y2: "20" });
  const [error, setError] = useState("");
  const [scan, setScan] = useState<FinishReviewScan | null>(null);
  const [selectionKind, setSelectionKind] = useState<"pad" | "indicator">("pad");
  const [indicatorScan, setIndicatorScan] = useState<StartSignalDetectionResult | null>(null);
  const [selectionToken, setSelectionToken] = useState<TrackedFinishIndicatorFrameToken | null>(null);
  const [indicatorAnchor, setIndicatorAnchor] = useState<TrackedFinishIndicatorAnchor | null>(null);
  const [trackedScan, setTrackedScan] = useState<TrackedFinishIndicatorReview | null>(null);
  const [trackingHelp, setTrackingHelp] = useState("");
  const generation = useRef(0);
  const zoneKey = JSON.stringify([props.zone ?? null, props.indicatorZone ?? null]);
  const automatic = props.automaticRecovery;
  const cropZone = selectionKind === "indicator" && props.indicatorZone
    ? props.indicatorZone : props.zone ?? automatic?.target ?? props.contextZone;
  const cropKey = JSON.stringify(cropZone ?? null);
  const displayedScan = selectionKind === "pad" ? scan ?? (!props.zone ? automatic?.review : undefined) : undefined;
  const indicatorCursor = indicatorScan?.rawTime ?? indicatorScan?.candidates?.[0]?.rawTime;
  const video = props.video;
  const source = video?.src;
  const anchorReady = Boolean(video && indicatorAnchor && isTrackedFinishIndicatorAnchorCurrent(video, indicatorAnchor));
  const ready = props.frameReady && !props.busy && Boolean(video?.paused && !video.seeking && video.readyState >= 2);

  useEffect(() => {
    generation.current += 1;
    setScan(null); setIndicatorScan(null); setTrackedScan(null);
    setIndicatorAnchor(current => current && JSON.stringify(current.region) === JSON.stringify(props.indicatorZone) ? current : null);
    return () => { generation.current += 1; };
  }, [zoneKey, video]);

  useEffect(() => {
    setIndicatorAnchor(null); setSelectionToken(null); setSelection(null); setTrackingHelp("");
  }, [video, source]);

  useEffect(() => {
    if (props.busy && !props.scanning) {
      generation.current += 1;
      setScan(null); setIndicatorScan(null); setTrackedScan(null); setSelection(null); setSelectionToken(null); setCorner(null);
    }
  }, [props.busy, props.scanning]);

  useEffect(() => {
    setCloseupTracked(false);
    if (!video || !ready) { setCloseup(null); return; }
    let region = cropZone;
    if (selectionKind === "indicator" && trackedScan) {
      const decoded = readDecodedVideoFrameTime(video);
      const observed = decoded && trackedScan.observations.find(frame => Math.abs(frame.rawTime - decoded.mediaTime) <= .000001);
      // A marking rectangle belongs to one frame. Outside observed native
      // coverage it cannot represent the moving sensor at the current cursor.
      if (!observed) { setCloseup(null); return; }
      region = observed.region;
    }
    try {
      setCloseup(captureFinishReviewFrame(video, finishReviewCrop(region)));
      setCloseupTracked(selectionKind === "indicator" && Boolean(trackedScan));
    }
    catch { setCloseup(null); }
    // Coordinates, not parent object/function identity, control recapture.
  }, [video, props.currentTime, ready, cropKey, selectionKind, trackedScan]);

  function markPad(full = false, kind: "pad" | "indicator" = "pad") {
    if (!video || !ready) return;
    try {
      let token: TrackedFinishIndicatorFrameToken | null = null;
      let help = "";
      if (kind === "indicator" && props.onIndicatorTrack) {
        try { token = captureTrackedFinishIndicatorFrame(video); }
        catch { help = "Frame tracking is unavailable here. You can still scan a fixed indicator area or review frames manually."; }
      }
      const snapshot = captureFinishReviewFrame(video, { id: "finishPad", label: "Pad selection", x1: 0, y1: 0, x2: 1, y2: full ? 1 : 0.4 }, 640);
      if (token && (snapshot.timeSource !== "decoded-frame" || Math.abs(token.rawTime - snapshot.rawTime) > .000001)) {
        token = null; help = "The displayed frame changed during marking. Re-mark the indicator to enable tracking.";
      }
      setSelection(snapshot); setSelectionToken(token); setTrackingHelp(help);
      setFullSelection(full);
      setSelectionKind(kind);
      const zone = kind === "indicator" ? props.indicatorZone : props.zone;
      setBounds(zone ? { x1: String(zone.x1 * 100), y1: String(zone.y1 * 100),
        x2: String(zone.x2 * 100), y2: String(zone.y2 * 100) } : { x1: "40", y1: "5", x2: "60", y2: "20" });
      setCorner(null); setError("");
    } catch (failure) { setError(String(failure)); }
  }
  function applyArea() {
    if (props.busy) return;
    const numbers = Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value.trim() === "" ? NaN : Number(value) / 100])) as unknown as NormalizedZone;
    const zone = selectionKind === "indicator" ? normalizeFinishIndicatorZone(numbers) : normalizeFinishPadZone(numbers);
    if (!zone) { setError(`Choose a visible ${selectionKind} area with two different corners, smaller than a quarter of the image.`); return; }
    try {
      if (selectionKind === "indicator") {
        setIndicatorAnchor(selectionToken ? bindTrackedFinishIndicatorAnchor(selectionToken, zone) : null);
        props.onIndicatorZone?.(zone);
      } else props.onZone(zone);
      setSelection(null); setSelectionToken(null); setError(""); setScan(null); setIndicatorScan(null); setTrackedScan(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Capture and mark the indicator again."); }
  }
  async function rescanIndicator() {
    if (!props.indicatorZone || !props.onIndicatorScan || !ready || !video) return;
    const request = ++generation.current;
    setSelectionKind("indicator"); setError(""); setIndicatorScan(null); setTrackedScan(null);
    try {
      const result = await props.onIndicatorScan(props.indicatorZone, video.currentTime);
      if (request === generation.current) setIndicatorScan(result);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Indicator scan stopped.");
    }
  }
  async function trackIndicator() {
    if (!indicatorAnchor || !anchorReady || !props.onIndicatorTrack || !ready) return;
    const request = ++generation.current;
    setSelectionKind("indicator"); setError(""); setIndicatorScan(null); setTrackedScan(null);
    try {
      const result = await props.onIndicatorTrack(indicatorAnchor);
      if (request === generation.current) { setTrackedScan(result); setIndicatorScan(result.result); }
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Indicator tracking stopped.");
    }
  }
  async function rescan() {
    if (!props.zone || !ready || !video) return;
    const request = ++generation.current;
    setSelectionKind("pad"); setError(""); setScan(null);
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
      {ready && closeup ? <figure className="finish-closeup" data-tracked-closeup={closeupTracked ? "true" : undefined}>
        <img src={closeup.imageUrl} alt={selectionKind === "indicator" && props.indicatorZone ? "Marked finish indicator with surrounding context at the current video frame" : props.zone ? "Marked finish pad with surrounding context at the current video frame" : "Upper finish area at the current video frame"} />
        <figcaption>{closeup.rawTime.toFixed(3)}s · {closeup.timeSource === "decoded-frame" ? "decoded frame" : "approximate cursor"} · {closeupTracked ? "tracked context · review only" : selectionKind === "indicator" && props.indicatorZone ? "marked indicator · review only" : props.zone ? "marked area" : automatic?.target ? "automatic target · unverified" : "unverified overview"}</figcaption>
      </figure> : <p className="muted">{ready && selectionKind === "indicator" && trackedScan
        ? "This frame is outside the tracked observations. Inspect the candidate, or mark the indicator again on this frame."
        : "Pause and wait for the frame to see a synchronized close-up."}</p>}
      <div className="finish-review-buttons">
        <button disabled={!ready} onClick={() => markPad()}>{props.zone ? "Edit pad area" : "Mark finish pad"}</button>
        <button disabled={!ready || !props.zone} onClick={() => void rescan()}>Rescan near current frame</button>
        {props.zone && <button disabled={props.busy} onClick={() => { props.onZone(undefined); setScan(null); }}>Clear pad area</button>}
        {props.scanning && <button onClick={props.onCancel}>Cancel finish rescan</button>}
      </div>
      {props.onIndicatorZone && <>
        <div className="finish-review-buttons">
          <button disabled={!ready} onClick={() => markPad(true, "indicator")}>{props.indicatorZone ? "Edit finish indicator" : "Mark finish indicator"}</button>
          <button disabled={!ready || !props.indicatorZone || !props.onIndicatorScan} onClick={() => void rescanIndicator()}>Scan marked indicator</button>
          {props.onIndicatorTrack && <button disabled={!ready || !anchorReady} onClick={() => void trackIndicator()}>Track marked indicator</button>}
          {props.indicatorZone && <button disabled={props.busy} onClick={() => { props.onIndicatorZone?.(undefined); setIndicatorAnchor(null); setIndicatorScan(null); setTrackedScan(null); }}>Clear indicator area</button>}
        </div>
        <p className="finish-review-help">For a visible timing light, mark only that indicator in your lane. This is separate from the pad. Scan near its color change in a fixed-camera shot; review the suggested frame before accepting Finish.</p>
        {props.onIndicatorTrack && <p className="finish-review-help">{anchorReady && indicatorAnchor
          ? `Tracking starts from your marking frame at ${indicatorAnchor.rawTime.toFixed(3)}s and inspects ±1.25 seconds around it. It stops when surrounding context is lost. Review the suggested frame before accepting Finish.`
          : "To follow a moving camera, pause near the indicator’s color change and mark it here. Saved areas need a fresh marking frame for tracking."}</p>}
        {trackingHelp && <p className="finish-review-help">{trackingHelp}</p>}
      </>}
      <p className="finish-review-help">{!props.zone && automatic?.target
        ? "Check that the automatic crop contains the actual pad, not a scoreboard. Mark a different area if needed. Use fixed-camera footage."
        : "Mark the actual pad, not the scoreboard. Use a fixed-camera shot; re-mark after camera movement. A rescan inspects ±1.25 seconds without changing accepted timing."}</p>
      {!props.zone && automatic && <p className="finish-review-help" data-automatic-finish-review>{automatic.review
        ? `Automatically located target. Approach window: ${automatic.review.start.toFixed(2)}–${automatic.review.end.toFixed(2)}s. Review required; no Finish was accepted.`
        : automatic.reason}</p>}
    </>}
    {selection && <div className="finish-pad-selection">
      <p>Click two opposite corners around the {selectionKind === "indicator" ? "finish indicator" : "pad"}, or enter percentages below. Frame: {selection.rawTime.toFixed(3)}s.</p>
      <button disabled={!ready} onClick={() => markPad(!fullSelection, selectionKind)}>{fullSelection ? "Zoom selection to upper wall" : "Show full frame for marking"}</button>
      <button type="button" className={`finish-pad-image${fullSelection ? " full-frame" : ""}`} aria-label={`Mark a ${selectionKind} corner on the selection image`} disabled={props.busy}
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
        <img src={selection.imageUrl} alt={`${fullSelection ? "Full paused frame" : "Enlarged upper wall"} for marking the finish ${selectionKind}`} />
        {corner ? <span className="finish-pad-corner" style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100 / (fullSelection ? 1 : 0.4)}%` }} />
          : <span className="finish-pad-box" style={{ left: `${Math.min(Number(bounds.x1), Number(bounds.x2))}%`, top: `${Math.min(Number(bounds.y1), Number(bounds.y2)) / (fullSelection ? 1 : 0.4)}%`,
            width: `${Math.abs(Number(bounds.x2) - Number(bounds.x1))}%`, height: `${Math.abs(Number(bounds.y2) - Number(bounds.y1)) / (fullSelection ? 1 : 0.4)}%` }} />}
      </button>
      <p role="status">{corner ? "First corner set. Choose the opposite corner." : `Choose two corners, then use this ${selectionKind} area.`}</p>
      <div className="finish-pad-coordinates">{(["x1", "y1", "x2", "y2"] as const).map((key, index) =>
        <label key={key}>{["Left %", "Top %", "Right %", "Bottom %"][index]}
          <input type="number" min="0" max="100" step="0.1" disabled={props.busy} value={bounds[key]} onChange={event => setBounds(current => ({ ...current, [key]: event.target.value }))} />
        </label>)}</div>
      <div className="finish-review-buttons"><button disabled={props.busy || Boolean(corner)} onClick={applyArea}>Use this {selectionKind} area</button>
        <button disabled={props.busy} onClick={() => { setSelection(null); setSelectionToken(null); setCorner(null); setError(""); }}>Cancel marking</button></div>
    </div>}
    {props.scanning && <p role="status">{props.progress}</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {indicatorScan && <div className="finish-rescan-result" data-guided-indicator-result>
      <p>{indicatorScan.reason.replace(/\bFinish detected from\b/g, "Indicator color-change candidate from")}</p>
      {trackedScan && <p className="muted" data-tracked-indicator-status>{trackedScan.status === "complete" ? "Full review window tracked" : trackedScan.status === "partial" ? "Only part of the review window was tracked" : "Tracking could not establish a review window"}
        {trackedScan.observedWindow ? ` · observed ${trackedScan.observedWindow.start.toFixed(3)}–${trackedScan.observedWindow.end.toFixed(3)}s` : ""}
        {` · ${trackedScan.observations.length} observed frames. This is a navigation aid; inspect the actual indicator and event.`}</p>}
      {indicatorCursor !== undefined && Number.isFinite(indicatorCursor) && <button disabled={props.busy}
        onClick={() => props.onJump(indicatorCursor)}>Inspect unverified indicator candidate at {indicatorCursor.toFixed(3)}s</button>}
      <p className="muted">User-selected sensor and search window. No timing was accepted by this scan.</p>
    </div>}
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
