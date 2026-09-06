import type { Confidence } from "../types";
import { sanitizeObservationInterval } from "./timingEvidence";

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
  observationIntervalSeconds?: number;
  blueConfirmationRawTime?: number;
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
  observationIntervalSeconds?: number;
  visualTimingOutlierLabels?: string[];
}

const AGREEMENT_SECONDS = 0.38;

/** A full-frame discontinuity is not specific to the patch that exposed it.
 * Nearby cues belong to the same fusion event, so a different patch cannot
 * sidestep the failed scene check. Keep the clock inspectable, never automatic.
 */
export function requireContinuousStartScene(decision: FusedStartDecision, sceneCutTimes: readonly number[]): FusedStartDecision {
  if (!decision.found || decision.rawTime === undefined || !Number.isFinite(decision.rawTime)) return decision;
  const nearby = sceneCutTimes.some(time=>Number.isFinite(time) && time>=0 && Math.abs(time-decision.rawTime!)<=AGREEMENT_SECONDS+1e-9);
  if (!nearby) return decision;
  return {...decision,autoAccept:false,confidence:decision.confidence==="High"?"Medium":decision.confidence,
    reason:`Start requires review: a full-frame camera-cut check failed for a nearby cue in the same event. Another patch cannot verify the launch across that discontinuity. ${decision.reason}`};
}

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
  // Exact protocol audio already defines this clock. Do not change spatial
  // lane association by imposing a visual-clock vote that is not being used.
  const audioDefinesClock = best.some(item=>item.kind==="audio"&&item.confidence==="High"&&item.automaticVoteAllowed!==false);
  const visualTiming = audioDefinesClock ? {outliers:[] as StartEvidence[],ambiguous:false}
    : visualConfirmationConsensus(best.filter(item=>item.automaticVoteAllowed!==false));
  const supported = best.filter(item=>!visualTiming.outliers.includes(item));
  const sources = new Set(supported.map((item) => item.kind));
  const eligible = supported.filter(item => item.automaticVoteAllowed !== false);
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
  const conflict = Boolean(competing) || (visualTiming.ambiguous &&
    !eligible.some(item=>item.kind==="audio"&&item.confidence==="High"));

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
  const rawTime = roundMetric(weightedTime(autoAccept ? eligible : supported));
  const rejectedEvidence = usable.filter((item) => !supported.includes(item));
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
    observationIntervalSeconds: fusedObservationInterval(autoAccept ? eligible : supported),
    confidence,
    autoAccept,
    conflict,
    reason: `${autoAccept ? "Start evidence agreed" : "Start review cursor"} at ${rawTime.toFixed(3)}s using ${sourceSummary}.${premovementNote}${conflictNote}${artifactNotes.length ? ` ${artifactNotes.join(" ")}` : ""}${visualTiming.outliers.length ? " An earlier or later patch did not share the majority blue confirmation and was excluded from the clock." : ""}`,
    supportingEvidence: supported,
    rejectedEvidence,
    visualTimingOutlierLabels: visualTiming.outliers.flatMap(item=>item.label?[item.label]:[]),
  };
}

/** Broad audio/light association is not permission to average different visual
 * events. With three or more native-refined patches, require a unique majority
 * of blue confirmations inside a source-cadence-aware window. This selects
 * supporting clocks; the blue confirmation itself is never the start timestamp.
 */
export function visualConfirmationConsensus(evidence: StartEvidence[]): {outliers:StartEvidence[];ambiguous:boolean} {
  const native=evidence.filter(item=>item.kind==="color" && (item.confidence==="High"||item.confidence==="Medium") &&
    Number.isFinite(item.blueConfirmationRawTime) && item.blueConfirmationRawTime!>=item.rawTime &&
    sanitizeObservationInterval(item.observationIntervalSeconds)!==undefined)
    .sort((a,b)=>a.blueConfirmationRawTime!-b.blueConfirmationRawTime!);
  if(native.length<3)return {outliers:[],ambiguous:false};
  const window=Math.min(.2,Math.max(.1,...native.map(item=>2*item.observationIntervalSeconds!)));
  // Blue can become visible at different times in differently exposed patches.
  // If the departure clocks already agree, later confirmation is not a veto.
  const departureSpread = Math.max(...native.map(item => item.rawTime)) -
    Math.min(...native.map(item => item.rawTime));
  if (departureSpread <= window + 1e-9) return {outliers:[],ambiguous:false};
  const groups=native.map((first,index)=>native.slice(index).filter(item=>item.blueConfirmationRawTime!-first.blueConfirmationRawTime!<=window+1e-9));
  const maximum=Math.max(...groups.map(group=>group.length));
  const winners=groups.filter(group=>group.length===maximum);
  if(maximum<=native.length/2 || winners.length!==1)return {outliers:[],ambiguous:true};
  return {outliers:native.filter(item=>!winners[0].includes(item) &&
    winners[0].every(support => Math.abs(item.rawTime-support.rawTime)>window+1e-9)),ambiguous:false};
}

function clusterScore(cluster: StartEvidence[]): number {
  const reliable = cluster.filter((item) => item.confidence !== "Low");
  const sourceDiversity = new Set(reliable.map((item) => item.kind)).size;
  const colorCount = reliable.filter((item) => item.kind === "color").length;
  return cluster.reduce((sum, item) => sum + evidenceWeight(item), 0) + sourceDiversity * 1.8 + Math.max(0, colorCount - 1) * 1.5;
}

function weightedTime(cluster: StartEvidence[]): number {
  const values = clockEvidence(cluster);
  const totalWeight = values.reduce((sum, item) => sum + evidenceWeight(item), 0);
  return values.reduce((sum, item) => sum + item.rawTime * evidenceWeight(item), 0) / Math.max(totalWeight, 1e-6);
}

function clockEvidence(cluster: StartEvidence[]): StartEvidence[] {
  // High audio is reserved for the exact official pitch sequence and defines the
  // clock. Otherwise a refined light defines time; motion only corroborates it.
  const colorItems = cluster.filter((item) => item.kind === "color");
  const reliableColorItems = colorItems.filter((item) => item.confidence === "High" || item.confidence === "Medium");
  const highAudioItems = cluster.filter((item) => item.kind === "audio" && item.confidence === "High");
  const reliableAudioItems = cluster.filter((item) => item.kind === "audio" && item.confidence !== "Low" && item.confidence !== "None");
  const nonMotion = cluster.filter((item) => item.kind !== "motion");
  // One faint/coarse light cannot override the exact pitch-coded audio time. Two
  // agreeing lanes, or any refined Medium/High light, remain frame-accurate anchors.
  return highAudioItems.length
    ? highAudioItems
    : reliableColorItems.length
      ? reliableColorItems
      : reliableAudioItems.length
        ? reliableAudioItems
      : colorItems.length >= 2
      ? colorItems
      : colorItems.length
          ? colorItems
          : nonMotion.length
            ? nonMotion
            : cluster;
}

/** Do not borrow a light's resolution for an audio-defined clock, or imply that
 * averaging correlated lane lights produces finer precision than any source.
 */
export function fusedObservationInterval(evidence: StartEvidence[]): number | undefined {
  const clocks = clockEvidence(evidence);
  if (!clocks.length || clocks.some(item=>item.kind!=="color" || !Number.isFinite(item.rawTime) || item.rawTime<0 ||
      sanitizeObservationInterval(item.observationIntervalSeconds)===undefined)) return undefined;
  return sanitizeObservationInterval(Math.max(...clocks.map(item=>item.observationIntervalSeconds!)) +
    Math.max(...clocks.map(item=>item.rawTime))-Math.min(...clocks.map(item=>item.rawTime)));
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
