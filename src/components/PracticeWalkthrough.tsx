import "./PracticeWalkthrough.css";

export default function PracticeWalkthrough({ active, disabled, canReview, onOpen, onInspect, onReviewHold, onSave }: {
  active: "a" | "b" | null;
  disabled: boolean;
  canReview: boolean;
  onOpen(id: "a" | "b"): void;
  onInspect(event: "start" | "finish"): void;
  onReviewHold(): void;
  onSave(): void;
}) {
  return <section className="practice-walkthrough" aria-label="Practice walkthrough">
    <div><strong>{active ? `Practice ${active.toUpperCase()}: check, save, compare` : "Try a practice recording"}</strong>
      <p>Two short synthetic animations, with authored reference timing. No upload or account needed. These examples teach the workflow; they do not measure detector accuracy.</p>
    </div>
    {!active ? <button type="button" disabled={disabled} onClick={() => onOpen("a")}>Open practice A</button> : <>
      <ol>
        <li>Inspect the green start cue and finish-pad change.<div className="button-row"><button disabled={disabled || !canReview} onClick={() => onInspect("start")}>View practice start</button><button disabled={disabled || !canReview} onClick={() => onInspect("finish")}>View practice finish</button></div></li>
        <li>Review the yellow Hold 10 contact frame to enable phase differences.<div className="button-row"><button disabled={disabled || !canReview} onClick={onReviewHold}>Review practice Hold 10</button></div></li>
        <li>Save the attempt, then open the other animation and repeat.<div className="button-row"><button disabled={disabled} onClick={onSave}>Save practice attempt</button><button disabled={disabled} onClick={() => onOpen(active === "a" ? "b" : "a")}>Open practice {active === "a" ? "B" : "A"} as a new attempt</button></div></li>
        <li><a href="#saved-attempts">Compare saved attempts</a> and replay the section that changed. Corrections to one attempt retain its identity.</li>
      </ol>
      <small>Authored markers remain manual reference entries until you review them. Keep these synthetic examples separate from your training history and validation study.</small>
    </>}
  </section>;
}
