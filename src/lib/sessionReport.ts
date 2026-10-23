import { yamlNumber, yamlString } from "./exportFormatting";
import type { SessionDataset } from "./sessionExport";
import type { TimestampMarker } from "../types";

interface ReportContext {
  fallbackDate: string;
  startReason?: string;
  movementReason?: string;
}

function formatTime(value: number | null | undefined) {
  return value === null || value === undefined ? "Not set" : `${value.toFixed(3)}s`;
}

/** Human and machine sections share the exact same captured dataset. No clocks or I/O. */
export function createSessionReport(dataset: SessionDataset, context: ReportContext): string {
  const { session, video, calibration, splitCalculations: splits, hold10PhaseAnalysis: phases } = dataset;
  const marker = (id: TimestampMarker["id"]) => dataset.acceptedTimestamps.find(item => item.markerId === id);
  const timestampRow = (id: TimestampMarker["id"], label: string) => {
    const value = marker(id);
    return `| ${label} | ${formatTime(value?.acceptedRawTime)} | ${formatTime(value?.climbTime)} | ${value?.source ?? "Not set"} | ${value?.confidence ?? "None"} | ${formatTime(value?.offsetApplied)} |\n`;
  };
  const splitRow = (label: string) => `| ${label} | ${formatTime(splits[label])} |\n`;
  const rgb = (value: typeof calibration.beforeStartRGB) => value ? `${value.r}, ${value.g}, ${value.b}` : "not set";
  const calibrationNote = !calibration.colorDelta ? "Not set"
    : `Before ${rgb(calibration.beforeStartRGB)}, after ${rgb(calibration.afterStartRGB)}, delta ${calibration.colorDelta.toFixed(3)}.`;
  const date = session.date || context.fallbackDate;
  return `---\n` +
    `type: climbiq-attempt\n` +
    `climber: ${yamlString(session.climberName)}\n` +
    `date: ${yamlString(date)}\n` +
    `session_name: ${yamlString(session.sessionName)}\n` +
    `video_file: ${yamlString(video.fileName)}\n` +
    `official_time: ${yamlNumber(video.officialTotalTime)}\n` +
    `reaction_time: ${yamlNumber(splits["Reaction Time"])}\n` +
    `launch_delay: ${yamlNumber(splits["Launch Delay"])}\n` +
    `start_to_hold_10: ${yamlNumber(splits["Start to Hold 10"])}\n` +
    `hold_10_to_finish: ${yamlNumber(splits["Hold 10 to Finish"])}\n` +
    `bottom_phase_share: ${yamlNumber(phases.bottomPhaseShare)}\n` +
    `top_phase_share: ${yamlNumber(phases.topPhaseShare)}\n` +
    `slower_phase: ${yamlString(phases.slowerPhase ?? "Not set")}\n` +
    `phase_difference: ${yamlNumber(phases.phaseDifferenceSeconds)}\n` +
    `calculated_total_time: ${yamlNumber(splits["Calculated Total Time"])}\n` +
    `tags:\n  - climbiq\n  - speed-climbing\n  - training-log\n---\n\n` +
    `# ClimbIQ Attempt - ${date}\n\n` +
    `## Summary\n` +
    `- Session: ${session.sessionName || "Not set"}\n` +
    `- Climber: ${session.climberName || "Not set"}\n` +
    `- Video file: ${video.fileName || "Not set"}\n` +
    `- Official time: ${formatTime(video.officialTotalTime)}\n` +
    `- Calculated total: ${formatTime(splits["Calculated Total Time"])}\n` +
    `- Start → Hold 10: ${formatTime(splits["Start to Hold 10"])}\n` +
    `- Hold 10 → Finish: ${formatTime(splits["Hold 10 to Finish"])}\n` +
    `- Phase balance: ${phases.available
      ? `${(phases.bottomPhaseShare! * 100).toFixed(1)}% before / ${((1 - phases.bottomPhaseShare!) * 100).toFixed(1)}% after Hold 10; ${phases.slowerPhase === "balanced" ? "balanced" : `${phases.slowerPhase === "start-to-hold10" ? "bottom" : "top"} phase ${phases.phaseDifferenceSeconds!.toFixed(3)}s longer`}`
      : "Not set"}\n` +
    `- Attempt type: ${session.attemptType || "Not set"}\n` +
    `- Location / gym: ${session.location || "Not set"}\n` +
    `- Notes: ${session.notes || "Not set"}\n\n` +
    `## Accepted Timestamps\n\n` +
    `| Marker | Raw Video Time | Climb Time | Source | Confidence | Offset |\n` +
    `|---|---:|---:|---|---|---:|\n` +
    timestampRow("startSignal", "Start Signal") + timestampRow("firstMovement", "Earliest Visible Motion") +
    timestampRow("committedLaunch", "Committed Launch") + timestampRow("firstHold", "First Hold") +
    timestampRow("hold10", "Hold 10") + timestampRow("finishPad", "Finish Pad") +
    `\n## Splits\n\n| Split | Time |\n|---|---:|\n` +
    ["Reaction Time", "Launch Delay", "Preload Gap", "Start to First Hold", "Movement to First Hold", "Start to Hold 10", "First Hold to Hold 10", "Hold 10 to Finish", "Movement Time", "Launch-to-Finish Time", "Calculated Total Time"].map(splitRow).join("") +
    `\n## Detection Notes\n` +
    `- Start Signal: ${marker("startSignal")?.note || context.startReason || "Not set"}\n` +
    `- First Movement: ${marker("firstMovement")?.note || context.movementReason || "Not set"}\n` +
    `- Finish: ${marker("finishPad")?.note || dataset.finishEvidenceAudit.reason || "Not set"}\n` +
    `- Calibration: ${calibrationNote}\n` +
    `- Warnings: ${dataset.detectionWarnings.join("; ") || "None"}\n\n` +
    `## Athlete Notes\nWrite observations here.\n\n` +
    `## Review Questions\n- Where did I lose time?\n- Was the start reaction clean?\n- Was the launch delayed?\n- Did I lose more time before or after Hold 10?\n- What should I focus on next?\n\n` +
    `## Machine Data\n\n` + "```json\n" + JSON.stringify({
      appVersion: dataset.appVersion, exportBuild: dataset.exportBuild, analysisBuild: dataset.analysisBuild, exportTimestamp: dataset.exportTimestamp,
      session: dataset.session, video: dataset.video, timestamps: dataset.acceptedTimestamps, splits: dataset.splitCalculations,
      zones: dataset.zones, calibration: dataset.calibration, settings: dataset.settings, biomechanics: dataset.biomechanics, warnings: dataset.detectionWarnings,
      startLaneEvidenceAudit: dataset.startLaneEvidenceAudit, finishEvidenceAudit: dataset.finishEvidenceAudit,
    }, null, 2) + "\n```\n";
}
