import "./RecordingGuide.css";

export function RecordingGuide() {
  return (
    <details className="recording-guide">
      <summary>
        <span className="recording-guide-symbol" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" />
          </svg>
        </span>
        <span><strong>Get a useful recording</strong><small>A quick checklist before you start</small></span>
        <span className="recording-guide-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="recording-guide-content">
        <ol className="recording-guide-checklist">
          <li><strong>One attempt, one steady camera.</strong><span>Use a continuous recording without cuts, zooms, or slow-motion edits.</span></li>
          <li><strong>Keep the entire lane in view.</strong><span>Include the climber, start signal, and finish area. Leave room above the finish pad.</span></li>
          <li><strong>Start early. Finish late.</strong><span>Record before the start signal and keep filming until after the finish. Keep the original audio.</span></li>
          <li><strong>Check the suggested frames.</strong><span>Blur, blocked holds, and a moving camera can affect detection. Review uncertain start and finish times.</span></li>
        </ol>
        <div className="recording-guide-notes">
          <p><strong>Your video stays on your device.</strong> Video analysis runs locally. Saved attempts contain analysis data; keep the original recording for future frame review.</p>
          <p><strong>Training estimates.</strong> Video timing is limited by the recording and detected frames. It does not replace official race timing. Independent timing accuracy has not been established.</p>
        </div>
      </div>
    </details>
  );
}

export default RecordingGuide;
