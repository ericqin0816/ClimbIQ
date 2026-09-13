import type { SavedAnalysisSession } from "../types";
import { compareAttempts, summarizeAttempt, type AttemptMetricId } from "./attemptComparison";
import { analyzeRouteSplits } from "./routeSplits";
import { sanitizeTimestampSequence } from "./timestampIntegrity";

export interface CoachingSection {
  id: AttemptMetricId;
  label: string;
  seconds: number;
  baselineSeconds?: number;
  deltaSeconds?: number;
  startRawTime: number;
  endRawTime: number;
  text: string;
  evidence: string;
}

function sections(session: SavedAnalysisSession): CoachingSection[] {
  const summary = summarizeAttempt(session);
  const reliable = summary.metrics.filter(m => m.confidence === "High" || m.confidence === "Medium");
  if (!reliable.some(m => m.id === "total")) return [];
  const markers = sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration);
  const start = markers.find(m => m.id === "startSignal")?.rawTime;
  const finish = markers.find(m => m.id === "finishPad")?.rawTime;
  const hold = markers.find(m => m.id === "hold10" && m.acceptanceMode === "frame-review")?.rawTime;
  if (typeof start !== "number" || typeof finish !== "number") return [];
  const ranges = new Map<AttemptMetricId, [number, number]>();
  if (typeof hold === "number") {
    ranges.set("bottom-phase", [start, hold]);
    ranges.set("top-phase", [hold, finish]);
  }
  // summarizeAttempt applies timing/identity freshness and calibration checks.
  if (reliable.some(m => m.evidence === "COM wall estimate") && session.biomechanics?.result && session.biomechanics.calibration) {
    const route = analyzeRouteSplits({ ...session.biomechanics.result, startRawTime: start, endRawTime: finish },
      session.biomechanics.calibration.heightMeters, session.biomechanics.calibration.confidence ?? "Low");
    for (const section of route.sections) {
      if (section.available && typeof section.startRawTime === "number" && typeof section.endRawTime === "number") {
        ranges.set(`${section.id}-third` as AttemptMetricId, [section.startRawTime, section.endRawTime]);
      }
    }
  }
  return reliable.flatMap(m => {
    const range = ranges.get(m.id);
    if (!range || !range.every(Number.isFinite) || range[0] < start || range[1] > finish || range[1] <= range[0]) return [];
    return [{ id: m.id, label: m.label, seconds: m.valueSeconds, startRawTime: range[0], endRawTime: range[1], text: "", evidence: m.evidence }];
  });
}

/** Local review cues only. Raw video cursors never enter the hosted AI packet. */
export function buildSectionReview(current: SavedAnalysisSession, baseline?: SavedAnalysisSession) {
  const available = sections(current);
  const limits = "Section duration identifies where to look, not why it happened. It does not establish a technique fault or prescribe a drill.";
  if (baseline) {
    const baselineIds = new Set(sections(baseline).map(s => s.id));
    const common = available.filter(s => baselineIds.has(s.id));
    // Choose one partition; never add overlapping phase and wall-third differences.
    const phases = common.filter(s => s.id === "bottom-phase" || s.id === "top-phase");
    const selected = phases.length === 2 ? phases : common.filter(s => s.id.endsWith("-third"));
    const comparison = compareAttempts(baseline, current);
    const items = selected.flatMap(section => {
      const row = comparison.rows.find(r => r.id === section.id);
      if (!row || !["gained", "lost"].includes(row.outcome) || row.deltaSeconds === undefined || !row.baseline) return [];
      return [{ ...section, baselineSeconds: row.baseline.valueSeconds, deltaSeconds: row.deltaSeconds,
        text: `This section took ${Math.abs(row.deltaSeconds).toFixed(3)}s ${row.deltaSeconds > 0 ? "longer" : "less time"} than the selected baseline. Replay its entry and exit to inspect the difference.` }];
    }).sort((a, b) => b.deltaSeconds! - a.deltaSeconds!);
    return { items, note: items.length ? limits : selected.length ? "The comparable section differences are within the display thresholds; no section gain or loss is established." : "Both attempts need matching reviewed Hold 10 phases or reliable wall-third tracking before sections can be compared." };
  }
  const thirds = available.filter(s => s.id.endsWith("-third"));
  if (thirds.length !== 3) return { items: [] as CoachingSection[], note: "Run COM analysis with reliable wall calibration to locate sections to review, or select a comparable saved attempt with reviewed Hold 10 phases." };
  const ordered = [...thirds].sort((a, b) => b.seconds - a.seconds);
  const metrics = summarizeAttempt(current).metrics.filter(m => m.id.endsWith("-third"));
  const floor = Math.max(...metrics.map(m => m.comparisonFloorSeconds));
  if (ordered[0].seconds - ordered[2].seconds <= floor) return { items: [] as CoachingSection[], note: "No wall third stands out beyond the comparison threshold. This does not establish even technique or pacing." };
  return { items: [{ ...ordered[0], text: "This was the longest estimated wall third. Replay its entry and exit. Different moves, the launch, and the finish can naturally take different amounts of time; this is not proof of a mistake." }], note: limits };
}
