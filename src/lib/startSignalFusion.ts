import type { Confidence } from "../types";

export type StartEvidenceKind = "color" | "audio" | "motion";

export interface StartEvidence {
  kind: StartEvidenceKind;
  rawTime: number;
  confidence: Confidence;
  reason: string;
  label?: string;
  /** Preserve a suspect cue for inspection, but do not let it establish the clock. */
  automaticVoteAllowed?: boolean;
  artifactReason?: string;
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
  const exactAudioCluster = clusters.find((cluster) =>
    cluster.some((item) => item.kind === "audio" && item.confidence === "High"),
  );
  // High audio is reserved for the exact same/same/different start protocol.
  // It cannot be outvoted by an unrelated Medium color + Low passerby-motion pair.
  const best = exactAudioCluster ?? ranked[0].cluster;
  const bestRanked = ranked.find((entry) => entry.cluster === best) ?? ranked[0];
  const sources = new Set(best.map((item) => item.kind));
  const eligible = best.filter(item => item.automaticVoteAllowed !== false);
  const strongColor = eligible.some((item) => item.kind === "color" && item.confidence !== "Low");
  const strongAudio = eligible.some((item) => item.kind === "audio" && item.confidence !== "Low");
  const strongMotion = eligible.some((item) => item.kind === "motion" && item.confidence !== "Low");
  const colorCount = eligible.filter((item) => item.kind === "color" && item.confidence !== "Low").length;
  const competing = ranked.find((entry) =>
    entry.cluster !== best &&
    entry.cluster.some((item) => item.confidence === "High") &&
    entry.score >= bestRanked.score * 0.78 &&
    Math.abs(weightedTime(entry.cluster) - weightedTime(best)) > AGREEMENT_SECONDS,
  );
  const conflict = Boolean(competing);

  let confidence: Confidence;
  let autoAccept = false;
  if (strongColor && strongAudio) {
    confidence = "High";
    autoAccept = !conflict;
  } else if (colorCount >= 2 && best.some((item) => item.confidence === "High" || item.confidence === "Medium")) {
    confidence = "High";
    autoAccept = !conflict;
  } else if (strongColor) {
    confidence = eligible.some((item) => item.kind === "motion") ? "Medium" : eligible.find((item) => item.kind === "color")!.confidence;
    autoAccept = !conflict && confidence === "High";
  } else if (strongAudio) {
    const audioConfidence = eligible.find((item) => item.kind === "audio")!.confidence;
    confidence = audioConfidence === "High" ? "High" : strongMotion ? "Medium" : audioConfidence;
    // Only the exact pitch-coded protocol is authoritative without a lane-light
    // transition. A generic gym beep can coincide with body motion by chance,
    // so Medium audio + motion remains a review suggestion.
    autoAccept = !conflict && audioConfidence === "High";
  } else {
    confidence = "Low";
  }

  // Artifacts remain useful review cursors, but may not shift an accepted
  // clock merely because they landed in the same cluster as a valid cue.
  const rawTime = roundMetric(weightedTime(autoAccept ? eligible : best));
  const rejectedEvidence = usable.filter((item) => !best.includes(item));
  const sourceSummary = Array.from(sources).map(sourceLabel).join(" + ");
  const conflictNote = conflict
    ? " A second strong cue disagreed, so the timestamp requires review."
    : "";
  const premovementNote = rejectedEvidence.some((item) => item.kind === "motion" && item.rawTime < rawTime - AGREEMENT_SECONDS)
    ? " Earlier body motion was treated as setup rocking rather than the start."
    : "";
  const artifactNotes = [...new Set(best.filter(item => item.automaticVoteAllowed === false).map(item => item.artifactReason).filter(Boolean))];
  return {
    found: true,
    rawTime,
    confidence,
    autoAccept,
    conflict,
    reason: `${autoAccept ? "Start evidence agreed" : "Start review cursor"} at ${rawTime.toFixed(3)}s using ${sourceSummary}.${premovementNote}${conflictNote}${artifactNotes.length ? ` ${artifactNotes.join(" ")}` : ""}`,
    supportingEvidence: best,
    rejectedEvidence,
  };
}

function clusterScore(cluster: StartEvidence[]): number {
  const reliable = cluster.filter((item) => item.confidence !== "Low");
  const sourceDiversity = new Set(reliable.map((item) => item.kind)).size;
  const colorCount = reliable.filter((item) => item.kind === "color").length;
  return cluster.reduce((sum, item) => sum + evidenceWeight(item), 0) + sourceDiversity * 1.8 + Math.max(0, colorCount - 1) * 1.5;
}

function weightedTime(cluster: StartEvidence[]): number {
  // High audio is reserved for the exact official pitch sequence and defines the
  // clock. Otherwise a refined light defines time; motion only corroborates it.
  const colorItems = cluster.filter((item) => item.kind === "color");
  const reliableColorItems = colorItems.filter((item) => item.confidence === "High" || item.confidence === "Medium");
  const highAudioItems = cluster.filter((item) => item.kind === "audio" && item.confidence === "High");
  const nonMotion = cluster.filter((item) => item.kind !== "motion");
  // One faint/coarse light cannot override the exact pitch-coded audio time. Two
  // agreeing lanes, or any refined Medium/High light, remain frame-accurate anchors.
  const values = highAudioItems.length
    ? highAudioItems
    : reliableColorItems.length
      ? reliableColorItems
      : colorItems.length >= 2
      ? colorItems
      : colorItems.length
          ? colorItems
          : nonMotion.length
            ? nonMotion
            : cluster;
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
