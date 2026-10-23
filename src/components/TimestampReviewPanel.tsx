import type { Confidence } from "../types";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { FramePresentation } from "../lib/videoFramePresentation";
import "./TimestampReviewPanel.css";

export interface TimestampReviewPanelProps {
  label: string;
  instruction?: string;
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
  children?: ReactNode;
}

export default function TimestampReviewPanel(props: TimestampReviewPanelProps) {
  const region = useRef<HTMLElement>(null);
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
  }, [props.label, props.suggestedRawTime]);
  const time = props.decodedRawTime ?? props.currentTime;
  const adjustment = time - props.suggestedRawTime;
  const ready = props.frameReady && props.frameStatus !== "pending" && !props.busy;
  const source = props.decodedRawTime !== undefined ? "presentation"
    : props.frameStatus === "available" ? "unavailable" : props.frameStatus;
  return <section ref={region} tabIndex={-1} className="timestamp-review" aria-labelledby="timestamp-review-title" aria-live="polite">
    <div className="timestamp-review-heading">
      <div><span className="review-eyebrow">Review before accepting</span><h3 id="timestamp-review-title">{props.label}</h3></div>
      {props.confidence ? <span className="review-confidence">{props.confidence} confidence</span> : null}
    </div>
    <div className="timestamp-review-times">
      <div><span>Suggested</span><strong>{props.suggestedRawTime.toFixed(3)}s</strong></div>
      <div><span>{props.decodedRawTime !== undefined ? "Decoded frame" : "Cursor (approx.)"}</span><strong>{time.toFixed(3)}s</strong></div>
      <div><span>Adjustment</span><strong>{adjustment >= 0 ? "+" : "−"}{Math.abs(adjustment).toFixed(3)}s</strong></div>
    </div>
    <div className="button-row timestamp-review-actions">
      <button className="primary" disabled={!ready} aria-describedby="timestamp-review-instruction timestamp-review-frame-source" onClick={props.onAccept}>{ready ? `${props.acceptLabel} at ${time.toFixed(3)}s` : "Pause and wait for the frame"}</button>
      <button disabled={props.busy} onClick={props.onReturn}>Return to suggestion</button>
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
