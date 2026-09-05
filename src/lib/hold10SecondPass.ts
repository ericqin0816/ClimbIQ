import type { BiomechanicsFrame, BiomechanicsResult, NormalizedPoint, WallCalibration } from "../types";
import type { Hold10TargetResolution } from "./holdTarget";
import { detectHoldContact } from "./holdContact";
import { estimateHold10HeightPassage } from "./hold10HeightEstimate";
import { analyzePoseVideo, validatePoseTrackingSeed, PoseAnalysisCancelledError } from "./poseAnalysis";
import { seekTo } from "./videoFrameSampler";

export interface Hold10RefinementPlan {
  coarseRawTime: number;
  coarseHand?: "left" | "right";
  startRawTime: number;
  endRawTime: number;
  seed: { center: NormalizedPoint; rawTime: number };
}

export interface Hold10SecondPassEvidence {
  targetSource: Hold10TargetResolution["source"];
  coarseRawTime: number;
  candidateRawTime: number;
  refined: boolean;
  kind: "contact-candidate" | "height-passage" | "inconclusive";
  hand?: "left" | "right";
  sampleFps: 15;
  requestedFrames: number;
  selectedFrames: number;
  sampleBracket?: { startRawTime: number; endRawTime: number };
  shiftSeconds?: number;
  reason: string;
  requiresReview: true;
  diagnostics?: {
    contactDetected: boolean;
    contactRawTime?: number;
    contactReason?: string;
    candidateRawTime?: number;
    candidateReason: string;
  };
}

export interface Hold10EvidenceFrame {
  rawTime: number;
  label: string;
  imageUrl: string;
}

export interface Hold10SecondPassResult {
  evidence: Hold10SecondPassEvidence;
  /** Temporary on-device previews, excluded from saved sessions and exports. */
  previews: Hold10EvidenceFrame[];
}

function broadCandidate(result: BiomechanicsResult, calibration: WallCalibration, target: Hold10TargetResolution) {
  const contact = target.source !== "standard-template"
    ? detectHoldContact(result, calibration, target.wallTarget, { holdLabel: "Hold 10", observedRouteHolds: target.observedRouteHolds,
      allowApproximateEdgeProjection: target.allowApproximateEdgeProjection }) : undefined;
  return { candidate: contact?.detected ? contact : estimateHold10HeightPassage(result, calibration), contact };
}

/** Bound expensive inference to a short window and retain the original athlete. */
export function planHold10SecondPass(
  broad: BiomechanicsResult, calibration: WallCalibration, target: Hold10TargetResolution, duration: number,
): Hold10RefinementPlan | undefined {
  const { candidate } = broadCandidate(broad, calibration, target);
  if (!candidate.detected || candidate.rawTime === undefined || !Number.isFinite(duration) || duration <= 0) return undefined;
  const coarseRawTime = candidate.rawTime;
  if (coarseRawTime <= broad.startRawTime || coarseRawTime >= Math.min(duration, broad.endRawTime)) return undefined;
  const desiredStart = Math.max(broad.startRawTime, coarseRawTime - 0.7);
  const seedFrame = [...broad.frames].sort((a, b) => b.rawTime - a.rawTime).find(frame => frame.poseSelected !== false && frame.valid &&
    frame.rawTime >= broad.startRawTime && frame.rawTime <= desiredStart && desiredStart - frame.rawTime <= 0.3 && anchor(frame));
  if (!seedFrame) return undefined;
  const seed = validatePoseTrackingSeed({ center: anchor(seedFrame)!, rawTime: seedFrame.rawTime }, seedFrame.rawTime, calibration);
  if (!seed) return undefined;
  const endRawTime = Math.min(duration - 0.001, broad.endRawTime, coarseRawTime + 0.9);
  if (endRawTime - seed.rawTime < 0.4 || endRawTime - seed.rawTime > 2.2) return undefined;
  return { coarseRawTime, coarseHand: candidate.hand, startRawTime: seed.rawTime, endRawTime, seed };
}

export function assessHold10SecondPass(
  plan: Hold10RefinementPlan, dense: BiomechanicsResult, calibration: WallCalibration, target: Hold10TargetResolution,
): Hold10SecondPassEvidence {
  const { candidate, contact } = broadCandidate(dense, calibration, target);
  const selectedFrames = dense.frames.filter(f => f.poseSelected !== false && f.landmarks.length > 0).length;
  const eligible = candidate.detected && candidate.rawTime !== undefined &&
    candidate.rawTime >= plan.startRawTime && candidate.rawTime <= plan.endRawTime &&
    Math.abs(candidate.rawTime - plan.coarseRawTime) <= 0.45 && selectedFrames >= 4;
  const candidateRawTime = eligible ? candidate.rawTime! : plan.coarseRawTime;
  const contactCandidate = eligible && Boolean(contact?.detected);
  const disagreementReason = selectedFrames < 4
    ? `Only ${selectedFrames} nearby samples retained the selected athlete.`
    : !candidate.detected || candidate.rawTime === undefined
      ? contact?.reason ?? candidate.reason
      : candidate.rawTime < plan.startRawTime || candidate.rawTime > plan.endRawTime
        ? "The proposed event fell outside the closer scan."
        : `The denser candidate at ${candidate.rawTime.toFixed(3)}s disagreed with the broad cursor by ${Math.abs(candidate.rawTime - plan.coarseRawTime).toFixed(3)}s (review limit 0.450s).`;
  const tracked = dense.frames.filter(f => f.poseSelected !== false && handPoint(f, candidate.hand));
  const before = tracked.filter(f => f.rawTime <= candidateRawTime).at(-1);
  const after = tracked.find(f => f.rawTime >= candidateRawTime);
  const sampleBracket = eligible && before && after && after.rawTime - before.rawTime <= 0.15
    ? { startRawTime: before.rawTime, endRawTime: after.rawTime } : undefined;
  return {
    targetSource: target.source,
    coarseRawTime: plan.coarseRawTime, candidateRawTime, refined: Boolean(eligible),
    kind: contactCandidate ? "contact-candidate" : eligible ? "height-passage" : "inconclusive",
    hand: eligible ? candidate.hand : plan.coarseHand,
    sampleFps: 15, requestedFrames: dense.frames.length, selectedFrames, sampleBracket,
    shiftSeconds: eligible ? Math.round((candidateRawTime - plan.coarseRawTime) * 1000) / 1000 : undefined,
    reason: eligible ? contactCandidate
      ? `A denser scan found sustained hand proximity to the identified Hold 10. ${candidate.reason} Confirm the visible contact before setting a split.`
      : "A denser scan located the hand's height passage. The actual Hold 10 is not confirmed by this evidence; inspect the close-ups before setting contact."
      : `${disagreementReason} The original review cursor is retained; no contact or split was accepted.`,
    requiresReview: true,
    diagnostics: {
      contactDetected: Boolean(contact?.detected),
      contactRawTime: contact?.rawTime,
      contactReason: contact?.reason,
      candidateRawTime: candidate.rawTime,
      candidateReason: candidate.reason,
    },
  };
}

export async function runHold10SecondPass(options: {
  video: HTMLVideoElement;
  broad: BiomechanicsResult;
  calibration: WallCalibration;
  target: Hold10TargetResolution;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<Hold10SecondPassResult | undefined> {
  const { video, broad, calibration, target, signal, onProgress } = options;
  const plan = planHold10SecondPass(broad, calibration, target, video.duration);
  if (!plan) return undefined;
  const dense = await analyzePoseVideo({ video, startRawTime: plan.startRawTime, endRawTime: plan.endRawTime,
    settings: { ...broad.settings, sampleFps: 15 }, calibration, identityZone: broad.identityZone,
    trackingSeed: plan.seed, signal,
    onProgress: p => onProgress?.(`Inspecting Hold 10 more closely: ${p.processed}/${p.total} samples…`),
  });
  const evidence = assessHold10SecondPass(plan, dense, calibration, target);
  const previews = await captureEvidence(video, dense, plan, evidence, target, signal);
  return { evidence, previews };
}

async function captureEvidence(video: HTMLVideoElement, dense: BiomechanicsResult, plan: Hold10RefinementPlan,
  evidence: Hold10SecondPassEvidence, target: Hold10TargetResolution, signal?: AbortSignal): Promise<Hold10EvidenceFrame[]> {
  const nearest = dense.frames.reduce((a, b) => Math.abs(a.rawTime - evidence.candidateRawTime) < Math.abs(b.rawTime - evidence.candidateRawTime) ? a : b);
  const point = handPoint(nearest, evidence.hand) ?? plan.seed.center;
  // Use a fixed crop for all three images so the hand's motion is visible.
  const width = Math.min(0.65, 0.35 * video.videoHeight / video.videoWidth);
  const height = 0.35;
  const left = Math.max(0, Math.min(1 - width, point.x - width / 2));
  const top = Math.max(0, Math.min(1 - height, point.y - height / 2));
  const canvas = document.createElement("canvas");
  canvas.width = 480; canvas.height = Math.round(480 * height * video.videoHeight / (width * video.videoWidth));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create Hold 10 evidence previews.");
  const previews: Hold10EvidenceFrame[] = [];
  for (const [label, offset] of [["Before", -0.13], ["Candidate", 0], ["After", 0.13]] as const) {
    if (signal?.aborted) throw new PoseAnalysisCancelledError();
    const time = Math.max(plan.startRawTime, Math.min(plan.endRawTime, evidence.candidateRawTime + offset));
    await seekTo(video, time);
    if (signal?.aborted) throw new PoseAnalysisCancelledError();
    ctx.drawImage(video, left * video.videoWidth, top * video.videoHeight, width * video.videoWidth, height * video.videoHeight, 0, 0, canvas.width, canvas.height);
    const frame = dense.frames.reduce((a, b) => Math.abs(a.rawTime - time) < Math.abs(b.rawTime - time) ? a : b);
    const hand = Math.abs(frame.rawTime - time) <= 0.05 ? handPoint(frame, evidence.hand) : undefined;
    for (const [mark, color] of [[hand, "#38bdf8"], [target.source !== "standard-template" ? target.imagePoint : undefined, "#facc15"]] as const) {
      if (!mark) continue;
      const x = (mark.x - left) / width * canvas.width;
      const y = (mark.y - top) / height * canvas.height;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
    }
    previews.push({ label, rawTime: video.currentTime, imageUrl: canvas.toDataURL("image/jpeg", 0.82) });
  }
  return previews;
}

function anchor(frame: BiomechanicsFrame): NormalizedPoint | undefined {
  // COM is retained in compact saved sessions, whereas hip landmarks are not.
  // Use the same observed seed before and after reload so storage compaction
  // cannot itself change the second-pass crop. This is an image-space anchor,
  // not a COM-based claim that the hand contacted the hold.
  if (frame.imageCom && Number.isFinite(frame.imageCom.x) && Number.isFinite(frame.imageCom.y)) return frame.imageCom;
  const hips = [23, 24].map(index => frame.landmarks.find(l => l.index === index && l.visibility >= 0.2));
  if (hips[0] && hips[1]) return { x: (hips[0].x + hips[1].x) / 2, y: (hips[0].y + hips[1].y) / 2 };
  return undefined;
}

function handPoint(frame: BiomechanicsFrame, hand?: "left" | "right"): NormalizedPoint | undefined {
  if (!hand) return undefined;
  const indices = hand === "left" ? [17, 19, 21] : [18, 20, 22];
  const points = frame.landmarks.filter(p => indices.includes(p.index) && p.visibility >= 0.35 && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 2 || frame.poseSelected === false) return undefined;
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}
