import type { Confidence } from "../types";
import type { FramePresentation } from "../lib/videoFramePresentation";
import "./TimestampReviewPanel.css";

export interface TimestampReviewPanelProps {
  label: string;
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
}

export default function TimestampReviewPanel(props: TimestampReviewPanelProps) {
  const time = props.decodedRawTime ?? props.currentTime;
  const adjustment = time - props.suggestedRawTime;
  const ready = props.frameReady && props.frameStatus !== "pending" && !props.busy;
  const source = props.decodedRawTime !== undefined ? "presentation"
    : props.frameStatus === "available" ? "unavailable" : props.frameStatus;
  return <section className="timestamp-review" aria-labelledby="timestamp-review-title" aria-live="polite">
    <div className="timestamp-review-heading">
      <div><span className="review-eyebrow">Review before accepting</span><h3 id="timestamp-review-title">{props.label}</h3></div>
      {props.confidence ? <span className="review-confidence">{props.confidence} confidence</span> : null}
    </div>
    <div className="timestamp-review-times">
      <div><span>Suggested</span><strong>{props.suggestedRawTime.toFixed(3)}s</strong></div>
      <div><span>{props.decodedRawTime !== undefined ? "Decoded frame" : "Cursor (approx.)"}</span><strong>{time.toFixed(3)}s</strong></div>
      <div><span>Adjustment</span><strong>{adjustment >= 0 ? "+" : "−"}{Math.abs(adjustment).toFixed(3)}s</strong></div>
    </div>
    <p className="review-instruction">Check the visible event, then accept the frame.</p>
    <p className="muted review-frame-source" data-frame-time-source={source}>
      {source === "presentation" ? "Using the presented frame’s timestamp."
        : source === "pending" ? "Waiting for the displayed frame…"
          : "Approximate cursor time — native frame time unavailable."}
    </p>
    <details className="review-time-details"><summary>Timing details</summary>
      <p>Seek cursor: {props.currentTime.toFixed(3)}s. A native frame timestamp identifies the displayed source frame, not the exact physical contact instant. Without it, the paused cursor may fall between source frames. This provenance is saved with your marker.</p>
      <p>Frame stepping uses browser-decoded frames and reported intervals. On variable-rate video, it may not enumerate every encoded frame.</p>
      {props.sourceFrameDurationSeconds !== undefined && <p>Source frame duration: {(props.sourceFrameDurationSeconds * 1000).toFixed(2)} ms. This is the frame’s presentation interval, not a measured event-error bound.</p>}
    </details>
    <div className="button-row timestamp-review-actions">
      <button disabled={props.busy} onClick={props.onReturn}>Return to suggestion</button>
      <button className="primary" disabled={!ready} onClick={props.onAccept}>{ready ? `${props.acceptLabel} at ${time.toFixed(3)}s` : "Pause and wait for the frame"}</button>
      <button onClick={props.onClose}>Close review</button>
    </div>
  </section>;
}
