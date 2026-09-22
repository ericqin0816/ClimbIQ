import { useEffect, useRef } from "react";
import "./VideoAttachmentChoice.css";

interface VideoAttachmentChoiceProps {
  fileName: string;
  previewDataUrl?: string;
  sessionName: string;
  onAttach: () => void;
  onNewAttempt: () => void;
  onCancel: () => void;
}

export default function VideoAttachmentChoice({ fileName, previewDataUrl, sessionName, onAttach, onNewAttempt, onCancel }: VideoAttachmentChoiceProps) {
  const choiceRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!returnFocusRef.current) returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    choiceRef.current?.focus({ preventScroll: true });
    choiceRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);

  function cancelChoice() {
    const previousControl = returnFocusRef.current;
    onCancel();
    // Wait for the pending choice to release any disabled initiating control.
    window.requestAnimationFrame(() => {
      if (previousControl?.isConnected && (document.activeElement === document.body || !document.activeElement)) previousControl.focus();
    });
  }

  return <section ref={choiceRef} className="video-attachment-choice" tabIndex={-1} aria-labelledby="video-attachment-title" data-video-attachment-choice>
    {previewDataUrl && <img src={previewDataUrl} alt={`Preview of ${fileName}`} />}
    <div>
      <h3 id="video-attachment-title">Is this the original recording?</h3>
      <p><strong>{fileName}</strong> has compatible recording details for <strong>{sessionName}</strong>. A matching filename alone cannot confirm it is the same run.</p>
      <p>Attach it to review the saved timing, or start a new attempt with its own measurements.</p>
      <div className="button-row">
        <button type="button" className="primary" onClick={onAttach}>Attach to this attempt</button>
        <button type="button" onClick={onNewAttempt}>Analyze as a new attempt</button>
        <button type="button" onClick={cancelChoice}>Cancel</button>
      </div>
    </div>
  </section>;
}
