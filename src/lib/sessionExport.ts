import type { BiomechanicsResult, BiomechanicsSession, DetectionCandidate, FirstMovementDetectionResult, SavedAnalysisSession, StartSignalDetectionResult, TimestampMarker } from "../types";
import type { AppBuildIdentity } from "./buildIdentity";
import type { Hold10SecondPassResult } from "./hold10SecondPass";
import { calculateHold10PhaseSplits } from "./hold10Splits";
import { getTimestamp } from "./sessionCodec";
import { startLaneId } from "./startLaneEvidence";
import { summarizeSourceSampleTiming } from "./sourceSampleTiming";
import { timestampAcceptanceAudit } from "./timestampIntegrity";

export interface SessionExportInput {
  session: SavedAnalysisSession;
  exportBuild: AppBuildIdentity;
  exportedAt: string;
  biomechanics: BiomechanicsSession;
  effectiveBiomechanicsResult?: BiomechanicsResult;
  startResult: StartSignalDetectionResult | null;
  movementResult: FirstMovementDetectionResult | null;
  finishResult: StartSignalDetectionResult | null;
  secondPassEvidence?: Hold10SecondPassResult["evidence"];
  startEvidenceStatus: string;
  autoAnalysisStatus: string;
  finishStatus: string;
}

export function buildSplitMap(rows: Array<{ label: string; value: number | null }>): Record<string, number | null> {
  return Object.fromEntries(rows.map(row => [row.label, row.value]));
}

function exportCandidates(candidates: DetectionCandidate[], acceptedMarker: TimestampMarker) {
  return candidates.map(candidate => {
    const accepted = acceptedMarker.rawTime !== null && Math.abs(acceptedMarker.rawTime - candidate.rawTime) <= .02;
    return { candidateRawTime: candidate.rawTime, candidateType: candidate.kind, score: candidate.score,
      confidence: candidate.confidence, reason: candidate.reason, accepted, rejected: !accepted };
  });
}

function detectionWarnings({ session, startResult, movementResult, finishResult }: SessionExportInput): string[] {
  const warnings: string[] = [];
  for (const result of [startResult, movementResult, finishResult]) if (result?.debug.failureReason) warnings.push(result.debug.failureReason);
  if (movementResult?.debug.movementAlreadyUnderway) warnings.push("Movement appears to already be underway near Start Signal.");
  if (movementResult?.debug.suspiciousFirstFrameDetection) warnings.push("First Movement candidate occurred at the first sampled frame.");
  if (startResult?.debug.sceneContinuity?.assessable && !startResult.debug.sceneContinuity.continuous) warnings.push(startResult.debug.sceneContinuity.reason);
  const area = (zone: { x1: number; x2: number; y1: number; y2: number }) => Math.abs((zone.x2 - zone.x1) * (zone.y2 - zone.y1));
  if (session.zones.startLight && area(session.zones.startLight) > .05) warnings.push("Start Light Zone may be large for light detection.");
  if (session.zones.startBody && area(session.zones.startBody) > .3) warnings.push("Start Body Zone is large and may include background motion.");
  return warnings;
}

/** A pure serialization boundary: clocks, build identity, and analysis are supplied once. */
export function createSessionDataset(input: SessionExportInput) {
  const { session, startResult, movementResult, finishResult } = input;
  const { timestamps, zones, videoMetadata: metadata, startLightCalibration: calibration } = session;
  const hold10PhaseSplits = calculateHold10PhaseSplits(getTimestamp(timestamps, "startSignal").rawTime,
    getTimestamp(timestamps, "hold10").rawTime, getTimestamp(timestamps, "finishPad").rawTime, getTimestamp(timestamps, "hold10").confidence);
  const official = session.settings.officialTotalTime;
  const officialNumber = Number(official);
  return {
    appVersion: input.exportBuild.appVersion,
    exportBuild: input.exportBuild,
    // This is the last accepted detector Start build, never the importing/exporting build.
    analysisBuild: session.analysisBuild ?? null,
    exportTimestamp: input.exportedAt,
    session: { sessionId: session.id, attemptLineageId: session.attemptLineageId, sessionName: session.name,
      climberName: session.climberName, date: session.date, notes: session.notes, location: session.location,
      gym: session.location, attemptType: session.attemptType },
    video: { fileName: metadata?.fileName ?? session.videoFileName ?? "", duration: metadata?.duration ?? null,
      videoWidth: metadata?.videoWidth ?? null, videoHeight: metadata?.videoHeight ?? null,
      officialTotalTime: Number.isFinite(officialNumber) && official.trim() !== "" ? officialNumber : null },
    zones: { startLightZone: zones.startLight ?? null, startBodyZone: zones.startBody ?? null, hold10Zone: zones.hold10 ?? null,
      finishLightZone: zones.finishLight ?? null, finishPadZone: zones.finishPad ?? null },
    calibration: { beforeStartRGB: calibration.beforeStartRGB ?? null, afterStartRGB: calibration.afterStartRGB ?? null,
      calibrationFrameBeforeTime: calibration.calibrationFrameBeforeTime ?? null, calibrationFrameAfterTime: calibration.calibrationFrameAfterTime ?? null,
      colorDelta: calibration.colorDelta ?? null },
    settings: session.settings,
    acceptedTimestamps: timestamps.map(item => ({ markerId: item.id, label: item.label, acceptedRawTime: item.rawTime,
      climbTime: item.climbTime, detectedRawTime: item.detectedRawTime ?? null, offsetApplied: item.offsetApplied ?? 0,
      source: item.source, confidence: item.confidence, observationIntervalSeconds: item.observationIntervalSeconds ?? null,
      ...timestampAcceptanceAudit(item), userAdjusted: item.rawTime !== null && item.detectedRawTime !== undefined && item.detectedRawTime !== null
        ? Math.abs(item.rawTime - item.detectedRawTime) > .001 : false, note: item.note ?? "" })),
    candidates: { startSignal: exportCandidates(startResult?.candidates ?? [], getTimestamp(timestamps, "startSignal")),
      firstMovement: exportCandidates(movementResult?.candidates ?? [], getTimestamp(timestamps, "firstMovement")),
      committedLaunch: exportCandidates(movementResult?.candidates ?? [], getTimestamp(timestamps, "committedLaunch")),
      finishPad: exportCandidates(finishResult?.candidates ?? [], getTimestamp(timestamps, "finishPad")) },
    splitCalculations: session.splitCalculations ?? {},
    sourceFrameTimingAudit: input.effectiveBiomechanicsResult ? summarizeSourceSampleTiming(input.effectiveBiomechanicsResult.frames) : null,
    hold10PhaseAnalysis: { available: hold10PhaseSplits.available, startToHold10Seconds: hold10PhaseSplits.startToHold10Seconds ?? null,
      hold10ToFinishSeconds: hold10PhaseSplits.hold10ToFinishSeconds ?? null, bottomPhaseShare: hold10PhaseSplits.hold10Share ?? null,
      topPhaseShare: hold10PhaseSplits.hold10Share === undefined ? null : Math.round((1 - hold10PhaseSplits.hold10Share) * 1000) / 1000,
      slowerPhase: hold10PhaseSplits.slowerPhase ?? null, phaseDifferenceSeconds: hold10PhaseSplits.phaseDifferenceSeconds ?? null,
      confidence: hold10PhaseSplits.confidence, reason: hold10PhaseSplits.reason },
    hold10SecondPassEvidence: input.secondPassEvidence ?? null,
    detectionWarnings: detectionWarnings(input),
    automationAudit: { startEvidence: input.startEvidenceStatus || null, automaticAnalysis: input.autoAnalysisStatus || null, finishAnalysis: input.finishStatus || null },
    startLaneEvidenceAudit: { scope: "current-analysis-only", isGroundTruthLabel: false,
      audioSearchHintTime: startResult?.debug.audioSearchHintTime ?? null, audioConfidence: startResult?.debug.audioConfidence ?? null,
      audioTimingWindow: startResult?.debug.audioTimingWindow ?? null,
      associationTime: startResult?.debug.laneAssociationTime ?? null, entries: startResult?.debug.laneEvidence ?? [],
      activeLightLaneId: zones.startLight ? startLaneId(zones.startLight) : null },
    finishEvidenceAudit: { scope: "current-analysis-only", isGroundTruthLabel: false, isEventAccuracyBound: false,
      available: finishResult !== null, detected: finishResult?.detected ?? null, proposedRawTime: finishResult?.rawTime ?? null,
      confidence: finishResult?.confidence ?? null, reason: finishResult?.reason ?? null,
      detectionMethod: finishResult?.debug.detectionMethod ?? null,
      evidenceKind: finishResult?.debug.finishEvidenceKind ?? null,
      sourceFrameSamplingFailed: finishResult === null ? null : finishResult.debug.sourceFrameSamplingFailed ?? false,
      partialSourceObservation: finishResult?.debug.partialSourceObservation ?? null },
    biomechanics: input.biomechanics,
    athleteNotes: session.notes,
  };
}

export type SessionDataset = ReturnType<typeof createSessionDataset>;
