import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import "./MobileWorkflow.css";

export interface MobileWorkflowProps {
  hasVideo: boolean;
  hasResults: boolean;
  analysisRunning: boolean;
  savedCount: number;
}

export type NextStepStage = "waiting" | "loading" | "ready" | "analyzing" | "review-start" | "review-finish" | "results";

export interface NextStepCardProps {
  stage: NextStepStage;
  status?: string;
  onAnalyze?: () => void;
  onReview?: () => void;
  onChooseVideo?: () => void;
  onCancel?: () => void;
}

type WorkflowDestination = "upload" | "video-review" | "results" | "saved-attempts";

const DESTINATIONS: ReadonlyArray<{ id: WorkflowDestination; label: string; icon: ReactNode }> = [
  {
    id: "upload",
    label: "Analyze",
    icon: <><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></>,
  },
  {
    id: "video-review",
    label: "Review",
    icon: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  },
  {
    id: "results",
    label: "Results",
    icon: <><path d="M5 20V10m7 10V4m7 16v-7" /><path d="M3 20h18" /></>,
  },
  {
    id: "saved-attempts",
    label: "Saved",
    icon: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z" />,
  },
];

/** Mirrors the document sections; it does not create a separate mobile router. */
export function MobileWorkflow({ hasVideo, hasResults, analysisRunning, savedCount }: MobileWorkflowProps) {
  const [activeDestination, setActiveDestination] = useState<WorkflowDestination>("upload");

  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    let pendingFrame: number | undefined;

    function updateDestination() {
      pendingFrame = undefined;
      if (!media.matches) return;

      const readingLine = Math.min(window.innerHeight * 0.25, 160);
      let nearest: { id: WorkflowDestination; distance: number } | undefined;
      for (const destination of DESTINATIONS) {
        if (destination.id === "video-review" && (!hasVideo || analysisRunning)) continue;
        if (destination.id === "results" && (!hasResults || analysisRunning)) continue;
        const element = document.getElementById(destination.id);
        if (!element || element.getClientRects().length === 0) continue;
        const rect = element.getBoundingClientRect();
        const distance = readingLine < rect.top
          ? rect.top - readingLine
          : readingLine > rect.bottom
            ? readingLine - rect.bottom
            : 0;
        if (!nearest || distance < nearest.distance) nearest = { id: destination.id, distance };
      }
      if (nearest) setActiveDestination(nearest.id);
    }

    function scheduleUpdate() {
      if (pendingFrame === undefined) pendingFrame = window.requestAnimationFrame(updateDestination);
    }

    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    media.addEventListener("change", scheduleUpdate);
    return () => {
      if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      media.removeEventListener("change", scheduleUpdate);
    };
  }, [hasVideo, hasResults, analysisRunning, savedCount]);

  return (
    <nav className="mobile-workflow" aria-label="Mobile analysis navigation">
      {DESTINATIONS.map((destination) => {
        const disabledReason = destination.id === "video-review"
          ? !hasVideo ? "Choose a video to review" : analysisRunning ? "Available when analysis stops" : undefined
          : destination.id === "results"
            ? !hasResults ? "Analyze a video to see results" : analysisRunning ? "Available when analysis stops" : undefined
            : undefined;
        const contents = <>
          <span className="mobile-workflow-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {destination.icon}
            </svg>
            {destination.id === "saved-attempts" && savedCount > 0
              ? <span className="mobile-workflow-count" aria-hidden="true">{savedCount > 99 ? "99+" : savedCount}</span>
              : null}
          </span>
          <span>{destination.label}</span>
        </>;
        return disabledReason ? (
          <button key={destination.id} type="button" className="mobile-workflow-item" disabled title={disabledReason} aria-label={`${destination.label}: ${disabledReason}`}>
            {contents}
          </button>
        ) : (
          <a key={destination.id} href={`#${destination.id}`} className="mobile-workflow-item"
            aria-current={activeDestination === destination.id ? "location" : undefined}
            aria-label={destination.id === "saved-attempts" ? `Saved, ${savedCount} ${savedCount === 1 ? "attempt" : "attempts"}` : undefined}
            onClick={() => setActiveDestination(destination.id)}>
            {contents}
          </a>
        );
      })}
    </nav>
  );
}

const STEP_COPY: Record<NextStepStage, { number: string; label: string; title: string; description: string }> = {
  waiting: {
    number: "01", label: "Choose a recording", title: "One run. A clearer picture.",
    description: "Choose a speed-climbing recording to start. Keep the full lane, start signal, and finish in view.",
  },
  loading: {
    number: "01", label: "Opening your recording", title: "Reading the video details.",
    description: "The recording needs to finish loading before analysis or frame review is available.",
  },
  ready: {
    number: "02", label: "Analyze your run", title: "Your recording is ready.",
    description: "Find timing and movement on your device. Keep ClimbIQ open while the analysis runs.",
  },
  analyzing: {
    number: "02", label: "Analysis in progress", title: "Reading your run.",
    description: "Keep ClimbIQ open and your screen awake. Longer recordings take more time to process.",
  },
  "review-start": {
    number: "03", label: "Check the start", title: "Confirm the first signal.",
    description: "The start needs a closer look. Step through the suggested frame and accept it only when it matches the video.",
  },
  "review-finish": {
    number: "03", label: "Check the finish", title: "Confirm the finish frame.",
    description: "Check the visible finish contact or signal before using the total time. You can adjust it frame by frame.",
  },
  results: {
    number: "04", label: "Keep your progress", title: "Review it. Save it. Compare it.",
    description: "Check your timing against the video, then save this attempt to compare with your next run.",
  },
};

export function NextStepCard({ stage, status, onAnalyze, onReview, onChooseVideo, onCancel }: NextStepCardProps) {
  const copy = STEP_COPY[stage];
  const action = stage === "waiting" && onChooseVideo
    ? { label: "Choose a video", onClick: onChooseVideo }
    : stage === "ready" && onAnalyze
      ? { label: "Analyze this run", onClick: onAnalyze }
      : (stage === "review-start" || stage === "review-finish") && onReview
        ? { label: stage === "review-start" ? "Review start" : "Review finish", onClick: onReview }
        : undefined;

  return (
    <section className={`next-step-card next-step-${stage}`} aria-label="Your next step">
      <div className="next-step-number" aria-hidden="true">{copy.number}</div>
      <div className="next-step-content">
        <p className="next-step-label">{copy.label}</p>
        <h2>{copy.title}</h2>
        <p className="next-step-description">{copy.description}</p>
        {status ? <p className="next-step-status" role="status">{status}</p> : null}
      </div>
      {action ? <button type="button" className="next-step-action" onClick={action.onClick}>{action.label}<span aria-hidden="true">→</span></button> : null}
      {stage === "analyzing" && onCancel ? <button type="button" className="next-step-cancel" onClick={onCancel}>Cancel analysis</button> : null}
      {stage === "results" ? <a className="next-step-action" href="#save-analysis">Save this attempt<span aria-hidden="true">→</span></a> : null}
    </section>
  );
}
