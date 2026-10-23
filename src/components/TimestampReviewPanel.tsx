import type { Confidence } from "../types";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FramePresentation } from "../lib/videoFramePresentation";
import "./TimestampReviewPanel.css";

export interface TimestampReviewPanelProps {
  label: string;
  instruction?: string;
  navigationOnly?: boolean;
  confidence?: Confidence;
  suggestedRawTime: number;
  currentTime: number;
  decodedRawTime?: number;
  sourceFrameDurationSeconds?: number;
  frameStatus: FramePresentation["status"];
  frameReady: boolean;
  busy: boolean;
  acceptLabel: string;
  onReturn: () => void;
  onAccept: () => void;
  onClose: () => void;
  onJumpToTime?: (time: number) => void;
  children?: ReactNode;
}

export default function TimestampReviewPanel(props: TimestampReviewPanelProps) {
  const region = useRef<HTMLElement>(null);
  const jumpToggle = useRef<HTMLButtonElement>(null);
  const jumpField = useRef<HTMLInputElement>(null);
  const jumpId = useId();
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("");
  useEffect(() => {
    const openingRegion = region.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (active === document.body || (active !== null && openingRegion?.contains(active)))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
    setJumpOpen(false);
  }, [props.label, props.suggestedRawTime]);
  useEffect(() => {
    if (jumpOpen) {
      jumpField.current?.focus({ preventScroll: true });
      jumpField.current?.select();
      jumpField.current?.scrollIntoView({ block: "nearest" });
    }
  }, [jumpOpen]);
  const time = props.decodedRawTime ?? props.currentTime;
  const adjustment = time - props.suggestedRawTime;
  const ready = props.frameReady && props.frameStatus !== "pending" && !props.busy;
  const source = props.decodedRawTime !== undefined ? "presentation"
    : props.frameStatus === "available" ? "unavailable" : props.frameStatus;
  const validJump = jumpInput.trim() !== "" && Number.isFinite(Number(jumpInput)) && Number(jumpInput) >= 0;
  const closeJump = () => {
    setJumpOpen(false);
    jumpToggle.current?.focus({ preventScroll: true });
  };
  return <section ref={region} tabIndex={-1} className="timestamp-review" data-navigation-only={props.navigationOnly || undefined} aria-labelledby="timestamp-review-title" aria-live="polite">
    <div className="timestamp-review-heading">
      <div><span className="review-eyebrow">{props.navigationOnly ? "Manual frame review" : "Review before accepting"}</span><h3 id="timestamp-review-title">{props.label}</h3></div>
      {props.confidence ? <span className="review-confidence">{props.confidence} confidence</span> : null}
    </div>
    <div className="timestamp-review-times">
      <div><span>{props.navigationOnly ? "Starting cursor" : "Suggested"}</span><strong>{props.suggestedRawTime.toFixed(3)}s</strong></div>
      {/* Keep the toggle focusable during a new seek; its guarded unavailable
          state must not drop keyboard focus when the form closes. */}
      <div className={props.onJumpToTime ? "review-current-time" : undefined}>{props.onJumpToTime ?
        <button ref={jumpToggle} type="button" className="review-seek-toggle" disabled={props.busy}
          aria-disabled={!ready} aria-expanded={jumpOpen} aria-controls={jumpId} aria-label="Jump to time"
          onClick={() => { if (!ready) return; setJumpInput(time.toFixed(3)); setJumpOpen(open => !open); }}>
          <span>{props.decodedRawTime !== undefined ? "Decoded frame" : "Cursor (approx.)"}</span>
          <strong>{time.toFixed(3)}s <span className="review-seek-label">Jump</span></strong>
        </button> : <><span>{props.decodedRawTime !== undefined ? "Decoded frame" : "Cursor (approx.)"}</span><strong>{time.toFixed(3)}s</strong></>}</div>
      {!props.navigationOnly && <div><span>Adjustment</span><strong>{adjustment >= 0 ? "+" : "−"}{Math.abs(adjustment).toFixed(3)}s</strong></div>}
    </div>
    {jumpOpen && props.onJumpToTime && <form id={jumpId} className="review-seek-form" onSubmit={event => {
      event.preventDefault();
      if (!validJump || !ready) return;
      props.onJumpToTime?.(Number(jumpInput));
      closeJump();
    }}>
      <label htmlFor={`${jumpId}-time`}>Raw video time (seconds)</label>
      <div><input ref={jumpField} id={`${jumpId}-time`} type="text" inputMode="decimal" value={jumpInput}
        aria-describedby={`${jumpId}-hint`} disabled={props.busy} onChange={event => setJumpInput(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeJump(); } }} />
        <button type="submit" disabled={!ready || !validJump}>Jump</button>
      </div>
      <p id={`${jumpId}-hint`}>Move the cursor, then check the displayed frame before accepting.</p>
    </form>}
    {props.navigationOnly && <p id="timestamp-review-navigation" className="review-navigation-hint">Find the actual event. This cursor is not a prediction.</p>}
    <div className="button-row timestamp-review-actions">
      <button className="primary" disabled={!ready} aria-describedby={`${props.navigationOnly ? "timestamp-review-navigation " : ""}timestamp-review-instruction timestamp-review-frame-source`} onClick={props.onAccept}>{ready ? `${props.acceptLabel} at ${time.toFixed(3)}s` : "Pause and wait for the frame"}</button>
      <button disabled={props.busy} onClick={props.onReturn}>{props.navigationOnly ? "Return to cursor" : "Return to suggestion"}</button>
      <button onClick={props.onClose}>Close review</button>
    </div>
    <p id="timestamp-review-instruction" className="review-instruction">{props.instruction ?? "Check the visible event before accepting."}</p>
    <p id="timestamp-review-frame-source" className="muted review-frame-source" data-frame-time-source={source}>
      {source === "presentation" ? "Using the presented frame’s timestamp."
        : source === "pending" ? "Waiting for the displayed frame…"
          : "Approximate cursor time — native frame time unavailable."}
    </p>
    {props.children}
    <details className="review-time-details"><summary>Timing details</summary>
      <p>Seek cursor: {props.currentTime.toFixed(3)}s. A native frame timestamp identifies the displayed source frame, not the exact physical contact instant. Without it, the paused cursor may fall between source frames. This provenance is saved with your marker.</p>
      <p>Frame stepping uses browser-decoded frames and reported intervals. On variable-rate video, it may not enumerate every encoded frame.</p>
      {props.sourceFrameDurationSeconds !== undefined && <p>Source frame duration: {(props.sourceFrameDurationSeconds * 1000).toFixed(2)} ms. This is the frame’s presentation interval, not a measured event-error bound.</p>}
    </details>
  </section>;
}
