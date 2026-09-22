import type {SavedAnalysisSession, TimestampMarker} from "../types";
import {summarizeAttempt} from "./attemptComparison";
import {sanitizeTimestampSequence} from "./timestampIntegrity";
import {describeSpeedTrace} from "./biomechanicsPresentation";
import {buildCoachingCatalog, type CoachingGoal, type CoachingPacket, type CoachingRunFacts} from "./coachingPolicy";

export interface CoachingEvidenceLink {label:string; rawTime:number}
export interface CoachingBaselineOption {
  id: string; name: string; date: string; totalSeconds: number | null;
  eligible: boolean; reason?: string;
}

/** Local identity only. This string must never enter the hosted numeric packet. */
export function coachingEvidenceFingerprint(current: SavedAnalysisSession, baseline?: SavedAnalysisSession): string {
  const basis = (session: SavedAnalysisSession) => ({
    id: session.id, name: session.name, video: session.videoMetadata,
    timestamps: session.timestamps, athlete: session.zones.startBody,
    calibration: session.biomechanics?.calibration, settings: session.biomechanics?.settings,
    tracking: session.biomechanics?.result,
  });
  // Exclude updatedAt: creating a current snapshot changes it without changing evidence.
  return JSON.stringify([basis(current), baseline ? basis(baseline) : null]);
}

function isSameRecordingEvidence(current: SavedAnalysisSession, candidate: SavedAnalysisSession): boolean {
  const left = current.videoMetadata, right = candidate.videoMetadata;
  if (!left || !right || !left.fileName || left.fileName !== right.fileName ||
    left.duration !== right.duration || left.videoWidth !== right.videoWidth || left.videoHeight !== right.videoHeight) return false;
  const timing = (session: SavedAnalysisSession) => sanitizeTimestampSequence(session.timestamps, session.videoMetadata?.duration)
    .filter(marker => marker.rawTime !== null).map(marker => [marker.id, marker.rawTime, marker.source, marker.acceptanceMode]);
  return JSON.stringify(timing(current)) === JSON.stringify(timing(candidate));
}

export function coachingBaselineOptions(current: SavedAnalysisSession, sessions: SavedAnalysisSession[]): CoachingBaselineOption[] {
  return sessions.map(candidate => {
    const facts = coachingRunFacts(candidate);
    const reason = candidate.id === current.id ? "Current attempt"
      : isSameRecordingEvidence(current, candidate) ? "Same recording details and timing"
        : facts.timingState !== "accepted" ? "Start or Finish needs review" : undefined;
    return { id: candidate.id, name: candidate.name, date: candidate.date, totalSeconds: facts.totalSeconds,
      eligible: reason === undefined, reason };
  });
}

export function coachingRunFacts(session:SavedAnalysisSession):CoachingRunFacts {
  const summary=summarizeAttempt(session);
  const markers=sanitizeTimestampSequence(session.timestamps,session.videoMetadata?.duration);
  const marker=(id:TimestampMarker["id"])=>markers.find(m=>m.id===id&&m.source!=="Not set"&&Number.isFinite(m.rawTime));
  const metric=(id:string)=>summary.metrics.find(m=>m.id===id&&(m.confidence==="High"||m.confidence==="Medium"));
  const total=metric("total");
  const empty:CoachingRunFacts={timingState:!marker("startSignal")?"missing-start":!marker("finishPad")?"missing-finish":"review",
    totalSeconds:null,movementSeconds:null,reviewedHold10:false,bottomSeconds:null,topSeconds:null,speedCoverage:null,comparisonFloorSeconds:.1};
  if(!total || total.valueSeconds<=0 || total.valueSeconds>600)return empty;
  const bottom=metric("bottom-phase"),top=metric("top-phase");
  const reviewedHold10=marker("hold10")?.acceptanceMode==="frame-review" && !!bottom && !!top;
  const movement=metric("reaction")?.valueSeconds;
  const result=session.biomechanics?.result;
  return {timingState:"accepted",totalSeconds:total.valueSeconds,
    movementSeconds:movement!==undefined&&movement>=0&&movement<=Math.min(30,total.valueSeconds)?movement:null,
    reviewedHold10,bottomSeconds:reviewedHold10?bottom!.valueSeconds:null,topSeconds:reviewedHold10?top!.valueSeconds:null,
    speedCoverage:result && !summary.trackingNote && summary.trackingCoverage!==undefined ? describeSpeedTrace(result).coverage : null,
    comparisonFloorSeconds:Math.min(600,Math.max(.1,total.comparisonFloorSeconds,reviewedHold10?bottom!.comparisonFloorSeconds:0,reviewedHold10?top!.comparisonFloorSeconds:0))};
}

export function buildCoachingEvidence(current:SavedAnalysisSession,goal:CoachingGoal,baseline?:SavedAnalysisSession) {
  if (baseline && !coachingBaselineOptions(current, [baseline])[0].eligible) {
    throw new Error("Choose a different saved attempt with accepted Start and Finish timing.");
  }
  const packet:CoachingPacket={version:1,goal,current:coachingRunFacts(current),baseline:baseline?coachingRunFacts(baseline):null};
  const markers=sanitizeTimestampSequence(current.timestamps,current.videoMetadata?.duration);
  const link=(id:TimestampMarker["id"],label:string):CoachingEvidenceLink[]=>{
    const time=markers.find(m=>m.id===id)?.rawTime;
    return typeof time==="number"&&Number.isFinite(time)?[{label,rawTime:time}]:[];
  };
  const start=link("startSignal","View Start"),finish=link("finishPad","View Finish"),hold=link("hold10","View reviewed Hold 10");
  const links:Record<string,CoachingEvidenceLink[]>={
    total:[...start,...finish],movement:[...start,...link("firstMovement","View first movement")],halves:[...start,...hold,...finish],
    "total-change":[...start,...finish],"no-change":[...start,...finish],"bottom-change":[...start,...hold],"top-change":[...hold,...finish],
    "phase-balance":[...start,...hold,...finish],
    "timing-review":[...start,...finish],"hold10-review":link("hold10","Inspect current Hold 10 marker"),tracking:[],
  };
  return {packet,catalog:buildCoachingCatalog(packet),links,currentName:current.name,baselineName:baseline?.name,
    sourceFingerprint:coachingEvidenceFingerprint(current,baseline)};
}
export type CoachingEvidence = ReturnType<typeof buildCoachingEvidence>;
