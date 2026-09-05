import type { Hold10SecondPassResult } from "../lib/hold10SecondPass";
import "./Hold10SecondPassPanel.css";

export default function Hold10SecondPassPanel({ result, disabled, onReview }: {
  result: Hold10SecondPassResult; disabled: boolean; onReview: (rawTime: number) => void;
}) {
  const { evidence, previews } = result;
  return <section className="hold10-second-pass" aria-label="Hold 10 second-pass evidence"
    data-target-source={evidence.targetSource} data-evidence-kind={evidence.kind}>
    <div className="hold10-second-pass-heading">
      <div><h3>Hold 10 close-up</h3>
        <small>Second pass · {evidence.selectedFrames}/{evidence.requestedFrames} tracked samples · 15 samples/s</small></div>
      <span>{evidence.kind === "contact-candidate" ? "Possible contact" : evidence.kind === "height-passage" ? "Height estimate" : "Needs review"}</span>
    </div>
    <p>{evidence.kind === "contact-candidate"
      ? `The ${evidence.hand ?? "tracked"} hand stayed near the identified Hold 10. Check the close-ups, then confirm contact in the full video.`
      : evidence.kind === "height-passage"
        ? "The hand crossed the approximate Hold 10 height. This is a review cue, not confirmed contact with the hold."
        : evidence.reason}</p>
    {evidence.kind !== "inconclusive" && <details className="hold10-detection-details">
      <summary>How this was found</summary><p>{evidence.reason}</p>
    </details>}
    <p className="muted">Broad pass: {evidence.coarseRawTime.toFixed(3)}s · Review cursor: {evidence.candidateRawTime.toFixed(3)}s
      {evidence.shiftSeconds !== undefined && ` · Shift: ${evidence.shiftSeconds >= 0 ? "+" : ""}${evidence.shiftSeconds.toFixed(3)}s`}
      {evidence.sampleBracket && ` · Adjacent tracked samples: ${evidence.sampleBracket.startRawTime.toFixed(3)}–${evidence.sampleBracket.endRawTime.toFixed(3)}s`}
    </p>
    <div className="hold10-evidence-frames">
      {previews.map(frame => <button type="button" key={frame.label} onClick={() => onReview(frame.rawTime)} disabled={disabled}
        aria-label={`Review Hold 10 ${frame.label.toLowerCase()} at ${frame.rawTime.toFixed(3)} seconds`}>
        <img src={frame.imageUrl} alt={`${frame.label} close-up near the Hold 10 candidate`} />
        <span>{frame.label} <strong>{frame.rawTime.toFixed(3)}s</strong></span>
      </button>)}
    </div>
    <small>Blue ring: nearby tracked hand estimate. Yellow ring: identified hold, when available. Previews stay on this device. Click a close-up to inspect the full video before accepting contact.</small>
  </section>;
}
