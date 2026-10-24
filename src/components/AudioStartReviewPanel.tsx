import { useEffect, useRef, useState } from "react";
import type { AudioStartReviewOutcome } from "../lib/audioStartReview";
import "./AudioStartReviewPanel.css";

interface Props {
  file: File | null;
  sourceKey: string;
  sourceGeneration: number;
  window: { start: number; end: number };
  busy: boolean;
  isCurrentSource: (file: File, key: string, generation: number) => boolean;
  onInspect: (time: number) => void;
}

/** Independent, explicit review action. It has no automatic-result setter. */
export default function AudioStartReviewPanel(props: Props) {
  const [review, setReview] = useState<{ outcome: AudioStartReviewOutcome; windowKey: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef(props);
  current.current = props;
  const active = useRef(true);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const windowKey = `${props.window.start}:${props.window.end}`;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current += 1; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    request.current += 1;
    controller.current?.abort(); controller.current = null;
    setReview(null); setRunning(false); setMessage("");
  }, [props.file, props.sourceKey, props.sourceGeneration, windowKey]);

  const belongs = (file: File, key: string, generation: number, selectedWindow: string) => active.current &&
    current.current.file === file && current.current.sourceKey === key && current.current.sourceGeneration === generation &&
    `${current.current.window.start}:${current.current.window.end}` === selectedWindow &&
    current.current.isCurrentSource(file, key, generation);
  const visible = review && belongs(review.outcome.source.file, review.outcome.source.sourceKey,
    review.outcome.source.sourceGeneration, review.windowKey) ? review.outcome : null;

  async function findCue() {
    if (!props.file || !props.sourceKey || props.busy || running) return;
    const file = props.file, key = props.sourceKey, generation = props.sourceGeneration, selectedWindow = windowKey;
    const task = ++request.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    const owns = () => task === request.current && !abort.signal.aborted && belongs(file, key, generation, selectedWindow);
    setRunning(true); setReview(null); setMessage("Looking for a recorded countdown…");
    try {
      const { findAudioStartReview } = await import("../lib/audioStartReview");
      if (!owns()) return;
      const outcome = await findAudioStartReview({ file, sourceKey: key, sourceGeneration: generation,
        searchStart: props.window.start, searchEnd: props.window.end, signal: abort.signal,
        isCurrentSource: () => owns(), onProgress: text => { if (owns()) setMessage(text); } });
      if (owns()) { setReview({ outcome, windowKey: selectedWindow }); setMessage(""); }
    } catch (error) {
      if (task === request.current && belongs(file, key, generation, selectedWindow)) {
        setMessage(abort.signal.aborted ? "Audio review cancelled." : error instanceof Error ? error.message : "Audio review could not finish.");
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      if (task === request.current && active.current) setRunning(false);
    }
  }

  return <div className="audio-start-review" data-audio-start-review>
    <h4>Recorded start cue <span>Manual review</span></h4>
    <p>Search {props.window.start.toFixed(2)}–{props.window.end.toFixed(2)}s of this recording for another countdown.
      Suggestions only move the review cursor; check the recording before accepting Start.</p>
    <div className="audio-start-review-actions">
      <button type="button" disabled={!props.file || !props.sourceKey || props.busy || running} onClick={() => void findCue()}>Find a recorded start cue</button>
      {running && <button type="button" onClick={() => controller.current?.abort()}>Cancel audio review</button>}
    </div>
    {!props.file && <p>Attach this recording to search its audio.</p>}
    {message && <p role="status">{message}</p>}
    {visible && <div data-audio-review-result>
      {visible.proposal ? <>
        <p>Unverified recorded-cue suggestion. No Start was accepted.</p>
        <button type="button" disabled={props.busy || running} onClick={() => {
          if (visible.proposal && belongs(visible.source.file, visible.source.sourceKey, visible.source.sourceGeneration, windowKey)) {
            props.onInspect(visible.proposal.rawTime);
          }
        }}>Inspect recorded cue at {visible.proposal.rawTime.toFixed(3)}s</button>
      </> : <p>{visible.reason} You can keep reviewing the video manually.</p>}
    </div>}
  </div>;
}
