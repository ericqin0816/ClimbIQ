import { useEffect, useState } from "react";
import { holdScreenForAnalysis } from "../lib/analysisWakeLock";

export default function AnalysisActivity({ active, status, onCancel }: { active: boolean; status: string; onCancel: () => void }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = performance.now();
    setElapsedSeconds(0);
    const interval = window.setInterval(() => setElapsedSeconds(Math.floor((performance.now() - started) / 1000)), 1000);
    const release = holdScreenForAnalysis(document, navigator.wakeLock);
    return () => { window.clearInterval(interval); release(); };
  }, [active]);
  if (!active) return null;
  const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
  return <aside className="analysis-tray">
    <span className="analysis-spinner" aria-hidden="true" />
    <div><strong>ClimbIQ is analyzing your video</strong>
      <small aria-live="polite">{status || "Finding the athlete, timing signals, and wall geometry…"}</small>
      <small>{elapsed} elapsed · keep ClimbIQ open</small>
    </div>
    <button onClick={onCancel}>Cancel</button>
  </aside>;
}
