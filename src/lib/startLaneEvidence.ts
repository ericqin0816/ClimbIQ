import type { Confidence, NormalizedZone, StartLightCalibration } from "../types";
import type { FusedStartDecision } from "./startSignalFusion";

export interface AnalysisLaneCandidate {
  laneId?: string;
  zone: NormalizedZone;
  calibration: StartLightCalibration;
  label: string;
  startRawTime: number;
  score: number;
}

export interface StartLaneEvidence extends AnalysisLaneCandidate {
  confidence: Confidence;
  automaticVoteAllowed?: boolean;
  artifactReason?: string;
}

export interface StartLaneAudit {
  laneId: string;
  label: string;
  zone: NormalizedZone;
  startRawTime: number;
  confidence: Confidence;
  eligible: boolean;
  selected: boolean;
  reason: string;
}

/** Identity belongs to the observed patch, not its array rank or audio confidence. */
export function startLaneId(zone: NormalizedZone): string {
  return `light:${[zone.x1, zone.y1, zone.x2, zone.y2].map(value => value.toFixed(6)).join(":")}`;
}

/** Keep the visual evidence ledger separate from the fused clock's precision.
 * A compatible audio hint stabilizes search/association, but never supplies an
 * eligibility vote. A lane still needs a cue supporting the selected event and
 * must pass its artifact check before it can reach movement/finish analysis.
 */
export function associateStartLanes(records: StartLaneEvidence[], decision: FusedStartDecision, searchHintTime?: number, trustedBodyZone?: NormalizedZone, recoveredVisual = false) {
  const finiteTime = decision.found && Number.isFinite(decision.rawTime) && decision.rawTime! >= 0;
  const inSelectedLane = (record: StartLaneEvidence) => !trustedBodyZone ||
    ((record.zone.x1 + record.zone.x2) / 2 >= trustedBodyZone.x1 - 0.035 &&
     (record.zone.x1 + record.zone.x2) / 2 <= trustedBodyZone.x2 + 0.035);
  const valid = records.filter(record => validLane(record) && record.automaticVoteAllowed !== false && inSelectedLane(record));
  const labels = new Set(decision.supportingEvidence.filter(item => item.kind === "color" && item.automaticVoteAllowed !== false).map(item => item.label));
  const seeds = finiteTime ? valid.filter(record => labels.has(record.label)) : [];
  const reliable = seeds.filter(record => record.confidence === "High" || record.confidence === "Medium");
  const anchors = reliable.length ? reliable : seeds;
  const hintCompatible = finiteTime && Number.isFinite(searchHintTime) && searchHintTime! >= 0 &&
    Math.abs(searchHintTime! - decision.rawTime!) <= 0.38;
  const weight = (record: StartLaneEvidence) => record.confidence === "High" ? 3 : record.confidence === "Medium" ? 2 : 0.75;
  const visualAnchor = anchors.length ? anchors.reduce((sum, record) => sum + record.startRawTime * weight(record), 0) /
    anchors.reduce((sum, record) => sum + weight(record), 0) : decision.rawTime;
  const associationTime = hintCompatible ? searchHintTime : visualAnchor;
  const supported = finiteTime && Number.isFinite(associationTime) ? valid.filter(record =>
    labels.has(record.label) || (record.confidence !== "Low" && Math.abs(record.startRawTime - associationTime!) <= 0.35),
  // The detail recovery must prefer the stronger visual evidence it recovered,
  // not a weak reflection nearest the beep. Standard-pass ordering stays intact.
  ).sort((left, right) => (recoveredVisual ? Number(left.confidence === "Low") - Number(right.confidence === "Low") : 0) ||
    Math.abs(left.startRawTime - associationTime!) - Math.abs(right.startRawTime - associationTime!) ||
    right.score - left.score || startLaneId(left.zone).localeCompare(startLaneId(right.zone))) : [];
  const reliableSupport = supported.filter(record => record.confidence !== "Low");
  // In a recovered pass, weak reflections are review evidence,
  // not alternate Finish sensors. A later color reversal cannot retroactively
  // prove that an uncertain patch belonged to the athlete's start light.
  const eligible = recoveredVisual && reliableSupport.length ? reliableSupport : supported;
  const candidates = deduplicateAnalysisLaneCandidates(eligible.map(record => ({ ...record, laneId: startLaneId(record.zone) })));
  const selected = eligible[0];
  const audit: StartLaneAudit[] = records.filter(validLane).map(record => ({
    laneId: startLaneId(record.zone), label: record.label, zone: record.zone,
    startRawTime: record.startRawTime, confidence: record.confidence,
    eligible: eligible.includes(record), selected: record === selected,
    reason: record.automaticVoteAllowed === false ? record.artifactReason ?? "Excluded start-light artifact."
      : !inSelectedLane(record) ? "Outside the user-selected athlete lane."
      : eligible.includes(record) ? "Visual cue supports the selected start event."
        : supported.includes(record) ? "Weak patch retained for review; stronger visual lane evidence is available."
        : "Visual cue does not support the selected start event.",
  }));
  return { selected, candidates, audit, associationTime };
}

function validLane(record: StartLaneEvidence): boolean {
  const z = record.zone;
  return record.confidence !== "None" && Number.isFinite(record.startRawTime) && record.startRawTime >= 0 &&
    Number.isFinite(record.score) && [z.x1, z.y1, z.x2, z.y2].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    z.x2 > z.x1 && z.y2 > z.y1 && [record.calibration.beforeStartRGB, record.calibration.afterStartRGB]
      .every(rgb => rgb && [rgb.r, rgb.g, rgb.b].every(value => Number.isFinite(value) && value >= 0 && value <= 255));
}

/** Preserve the existing physical-patch deduplication, including input priority. */
export function deduplicateAnalysisLaneCandidates<T extends AnalysisLaneCandidate>(candidates: T[]): T[] {
  const unique: T[] = [];
  for (const candidate of candidates) {
    const centerX = (candidate.zone.x1 + candidate.zone.x2) / 2;
    const centerY = (candidate.zone.y1 + candidate.zone.y2) / 2;
    if (!unique.some(existing => Math.hypot(centerX - (existing.zone.x1 + existing.zone.x2) / 2,
      centerY - (existing.zone.y1 + existing.zone.y2) / 2) < 0.035)) unique.push(candidate);
  }
  return unique;
}
