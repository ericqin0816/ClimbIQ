import type { Confidence } from "../types";

export type StartEvidenceKind = "color" | "audio" | "motion";

export interface StartEvidence {
  kind: StartEvidenceKind;
  rawTime: number;
  confidence: Confidence;
  reason: string;
  label?: string;
}

export interface FusedStartDecision {
  found: boolean;
  rawTime?: number;
  confidence: Confidence;
  autoAccept: boolean;
  conflict: boolean;
  reason: string;
  supportingEvidence: StartEvidence[];
  rejectedEvidence: StartEvidence[];
}

const AGREEMENT_SECONDS = 0.38;

export function fuseStartEvidence(evidence: StartEvidence[]): FusedStartDecision {
  const usable = evidence
    .filter((item) => Number.isFinite(item.rawTime) && item.rawTime >= 0 && item.confidence !== "None")
    .sort((left, right) => left.rawTime - right.rawTime);
  if (!usable.length) {
    return {
      found: false,
      confidence: "None",
      autoAccept: false,
      conflict: false,
      reason: "No usable start evidence was found.",
      supportingEvidence: [],
      rejectedEvidence: [],
    };
  }

  const clusters: StartEvidence[][] = [];
  for (const item of usable) {
    const cluster = clusters.find((candidate) =>
      Math.abs(weightedTime(candidate) - item.rawTime) <= AGREEMENT_SECONDS,
    );
    if (cluster) {
      cluster.push(item);
    } else {
      clusters.push([item]);
    }
  }
  const ranked = clusters
    .map((cluster) => ({ cluster, score: clusterScore(cluster) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0].cluster;
  const sources = new Set(best.map((item) => item.kind));
  const strongColor = best.some((item) => item.kind === "color" && item.confidence !== "Low");
  const strongAudio = best.some((item) => item.kind === "audio" && item.confidence !== "Low");
  const colorCount = best.filter((item) => item.kind === "color").length;
  const conflict = ranked.length > 1 && ranked[1].score >= ranked[0].score * 0.78 &&
    Math.abs(weightedTime(ranked[1].cluster) - weightedTime(best)) > AGREEMENT_SECONDS;

  let confidence: Confidence;
  let autoAccept = false;
  if (strongColor && strongAudio) {
    confidence = "High";
    autoAccept = !conflict;
  } else if (colorCount >= 2 && best.some((item) => item.confidence === "High" || item.confidence === "Medium")) {
    confidence = "High";
    autoAccept = !conflict;
  } else if (strongColor) {
    confidence = best.some((item) => item.kind === "motion") ? "Medium" : best.find((item) => item.kind === "color")!.confidence;
    autoAccept = !conflict && confidence !== "Low";
  } else if (strongAudio) {
    const audioConfidence = best.find((item) => item.kind === "audio")!.confidence;
    confidence = sources.has("motion") ? "Medium" : audioConfidence;
    // Two independent cue types agreeing (beep + launch motion) is trustworthy
    // enough to write a reviewable timestamp automatically.
    autoAccept = !conflict && (audioConfidence === "High" || sources.has("motion"));
  } else {
    confidence = "Low";
  }

  const rawTime = roundMetric(weightedTime(best));
  const rejectedEvidence = usable.filter((item) => !best.includes(item));
  const sourceSummary = Array.from(sources).map(sourceLabel).join(" + ");
  const conflictNote = conflict
    ? " A second strong cue disagreed, so the timestamp requires review."
    : "";
  const premovementNote = rejectedEvidence.some((item) => item.kind === "motion" && item.rawTime < rawTime - AGREEMENT_SECONDS)
    ? " Earlier body motion was treated as setup rocking rather than the start."
    : "";
  return {
    found: true,
    rawTime,
    confidence,
    autoAccept,
    conflict,
    reason: `Start evidence agreed at ${rawTime.toFixed(3)}s using ${sourceSummary}.${premovementNote}${conflictNote}`,
    supportingEvidence: best,
    rejectedEvidence,
  };
}

function clusterScore(cluster: StartEvidence[]): number {
  const sourceDiversity = new Set(cluster.map((item) => item.kind)).size;
  const colorCount = cluster.filter((item) => item.kind === "color").length;
  return cluster.reduce((sum, item) => sum + evidenceWeight(item), 0) + sourceDiversity * 1.8 + Math.max(0, colorCount - 1) * 1.5;
}

function weightedTime(cluster: StartEvidence[]): number {
  // The light transition is frame-accurate while audio carries speaker/encoding
  // latency, so when light evidence exists it alone defines the timestamp and
  // audio/motion only confirm it. Audio is used when there is no light; motion
  // only when it is the sole cue.
  const colorItems = cluster.filter((item) => item.kind === "color");
  const nonMotion = cluster.filter((item) => item.kind !== "motion");
  const values = colorItems.length ? colorItems : nonMotion.length ? nonMotion : cluster;
  const totalWeight = values.reduce((sum, item) => sum + evidenceWeight(item), 0);
  return values.reduce((sum, item) => sum + item.rawTime * evidenceWeight(item), 0) / Math.max(totalWeight, 1e-6);
}

function evidenceWeight(item: StartEvidence): number {
  const confidenceWeight = item.confidence === "High" ? 3 : item.confidence === "Medium" ? 2 : 0.75;
  const sourceWeight = item.kind === "color" ? 1.15 : item.kind === "audio" ? 1 : 0.35;
  return confidenceWeight * sourceWeight;
}

function sourceLabel(kind: StartEvidenceKind): string {
  return kind === "color" ? "green→blue light" : kind === "audio" ? "final beep" : "body motion";
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
