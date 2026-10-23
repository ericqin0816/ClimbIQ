import { useLayoutEffect, useRef } from "react";
import "./PracticeWalkthrough.css";

export default function PracticeWalkthrough({ active, disabled, canReview, saved, holdReviewed, bothSaved, revealRequested = false, onRevealHandled, onOpen, onInspect, onReviewHold, onSave }: {
  active: "a" | "b" | null;
  disabled: boolean;
  canReview: boolean;
  saved: boolean;
  holdReviewed: boolean;
  bothSaved: boolean;
  revealRequested?: boolean;
  onRevealHandled?: () => void;
  onOpen(id: "a" | "b"): void;
  onInspect(event: "start" | "finish"): void;
  onReviewHold(): void;
  onSave(): void;
}) {
  const walkthrough = useRef<HTMLElement>(null);
  const revealHandled = useRef(false);
  const handleReveal = useRef(onRevealHandled);
  useLayoutEffect(() => { handleReveal.current = onRevealHandled; }, [onRevealHandled]);
  useLayoutEffect(() => {
    revealHandled.current = false;
    if (!revealRequested || !active) return;
    const onOutsideIntent = (event: Event) => {
      if (revealHandled.current || (event.target instanceof Node && walkthrough.current?.contains(event.target))) return;
      // Cancel immediately, before an outside action or a newly ready frame can
      // render. Only a fresh user-requested practice opening may reveal again.
      revealHandled.current = true;
      handleReveal.current?.();
    };
    document.addEventListener("pointerdown", onOutsideIntent, true);
    document.addEventListener("focusin", onOutsideIntent, true);
    document.addEventListener("keydown", onOutsideIntent, true);
    document.addEventListener("wheel", onOutsideIntent, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", onOutsideIntent, true);
      document.removeEventListener("focusin", onOutsideIntent, true);
      document.removeEventListener("keydown", onOutsideIntent, true);
      document.removeEventListener("wheel", onOutsideIntent, true);
    };
  }, [revealRequested, active]);
  useLayoutEffect(() => {
    if (!revealRequested || !active || !canReview || disabled || revealHandled.current) return;
    const step = walkthrough.current?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!step) return;
    revealHandled.current = true;
    step.scrollIntoView({ block: "center", behavior: "instant" });
    step.querySelector<HTMLElement>("button.primary, a.primary")?.focus({ preventScroll: true });
    handleReveal.current?.();
  }, [revealRequested, active, canReview, disabled]);
  const next = !holdReviewed ? "review" : !saved ? "save" : bothSaved ? "compare" : "other";
  const other = active === "a" ? "b" : "a";
  return <section ref={walkthrough} className="practice-walkthrough" aria-label="Practice walkthrough">
    <div><strong>{active ? `Practice ${active.toUpperCase()}: check, save, compare` : "Try a practice recording"}</strong>
      <p>Two short synthetic animations with authored timing. Learn the workflow on this device, with no upload or account.</p>
    </div>
    {!active ? <button type="button" disabled={disabled} onClick={() => onOpen("a")}>Open practice A</button> : <>
      <p className="practice-next" role="status"><strong>{next === "review" ? "Next: check the Hold 10 contact frame."
        : next === "save" ? "Contact reviewed. Next: save this practice attempt."
          : next === "compare" ? "Both practice attempts are saved. Next: compare their timing."
            : `Practice ${active.toUpperCase()} saved. Next: open practice ${other.toUpperCase()}.`}</strong></p>
      <ol>
        <li className={next === "review" ? "practice-current" : "practice-complete"} aria-current={next === "review" ? "step" : undefined}>
          <strong>{holdReviewed ? "Contact frame reviewed" : "Check the reference frames"}</strong>
          <p>Inspect the green start cue, finish-pad change, and yellow Hold 10 contact.</p>
          <div className="button-row"><button disabled={disabled || !canReview} onClick={() => onInspect("start")}>View practice start</button><button disabled={disabled || !canReview} onClick={() => onInspect("finish")}>View practice finish</button></div>
          <button className={next === "review" ? "primary practice-main-action" : undefined} disabled={disabled || !canReview} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onReviewHold(); }}>Review practice Hold 10</button>
        </li>
        <li className={next === "save" ? "practice-current" : saved ? "practice-complete" : undefined} aria-current={next === "save" ? "step" : undefined}>
          <strong>{saved ? `Practice ${active.toUpperCase()} saved` : "Save this attempt"}</strong>
          <div className="button-row"><button className={next === "save" ? "primary" : undefined} disabled={disabled} onClick={onSave}>Save practice attempt</button></div>
        </li>
        <li className={next === "other" || next === "compare" ? "practice-current" : undefined} aria-current={next === "other" || next === "compare" ? "step" : undefined}>
          <strong>{bothSaved ? "Compare your practice attempts" : "Try the second attempt"}</strong>
          <div className="button-row">
            {bothSaved && <a className={next === "compare" ? "button-link primary" : "button-link"} href="#attempt-comparison">Compare saved attempts</a>}
            <button className={next === "other" ? "primary" : undefined} disabled={disabled} onClick={() => onOpen(other)}>Open practice {other.toUpperCase()} as a new attempt</button>
          </div>
          <p>{bothSaved ? "Look for the largest reviewed phase change, then replay it." : "Review and save both attempts to compare their timing."} Corrections keep the same attempt identity.</p>
        </li>
      </ol>
      <small>These synthetic examples do not measure detector accuracy. Authored markers remain manual references until reviewed. Keep them separate from training history and independent validation.</small>
    </>}
  </section>;
}
