import type {SavedAnalysisSession, TimestampMarker} from "../types";
import {summarizeAttempt, summarizeAttemptTiming} from "./attemptComparison";
import {sanitizeTimestampSequence} from "./timestampIntegrity";
import {describeSpeedTrace} from "./biomechanicsPresentation";
import {assessAttemptIdentity, resolveAttemptLineageId} from "./attemptIdentity";
import {buildCoachingCatalog, type CoachingGoal, type CoachingPacket, type CoachingRunFacts} from "./coachingPolicy";

export interface CoachingEvidenceLink {label:string; rawTime:number}
export interface CoachingBaselineOption {
  id: string; name: string; date: string; totalSeconds: number | null;
  eligible: boolean; reason?: string;
  requiresDistinctAttemptConfirmation: boolean; warning?: string;
}

/** Local identity only. This string must never enter the hosted numeric packet. */
export function coachingEvidenceFingerprint(current: SavedAnalysisSession, baseline?: SavedAnalysisSession): string {
  const basis = (session: SavedAnalysisSession) => ({
    id: session.id, lineage: resolveAttemptLineageId(session), name: session.name, video: session.videoMetadata,
    timestamps: session.timestamps, athlete: session.zones.startBody,
    calibration: session.biomechanics?.calibration, settings: session.biomechanics?.settings,
    tracking: session.biomechanics?.result,
  });
  // Exclude updatedAt: creating a current snapshot changes it without changing evidence.
  return JSON.stringify([basis(current), baseline ? basis(baseline) : null]);
}

export function coachingBaselineOptions(current: SavedAnalysisSession, sessions: SavedAnalysisSession[]): CoachingBaselineOption[] {
  return sessions.map(candidate => {
    const facts = coachingTimingFacts(candidate);
    const identity = assessAttemptIdentity(current, candidate);
    const reason = candidate.id === current.id ? "Current attempt"
      : identity.relationship === "same-attempt" ? "Another analysis of the same attempt"
        : facts.timingState !== "accepted" ? "Start or Finish needs review" : undefined;
    return { id: candidate.id, name: candidate.name, date: candidate.date, totalSeconds: facts.totalSeconds,
      eligible: reason === undefined, reason, requiresDistinctAttemptConfirmation: !reason && identity.requiresDistinctAttemptConfirmation,
      warning: !reason && identity.requiresDistinctAttemptConfirmation ? identity.explanation : undefined };
  });
}

/** Marker-only facts for candidate selection; detailed tracking stays with the chosen runs. */
export function coachingTimingFacts(session: SavedAnalysisSession): Pick<CoachingRunFacts, "timingState" | "totalSeconds"> & { comparisonFloorSeconds: number } {
  const { metrics, timestamps } = summarizeAttemptTiming(session);
  const marker = (id: TimestampMarker["id"]) => timestamps.find(item => item.id === id && item.source !== "Not set" && Number.isFinite(item.rawTime));
  const total = metrics.find(item => item.id === "total" && (item.confidence === "High" || item.confidence === "Medium"));
  if (!total || total.valueSeconds <= 0 || total.valueSeconds > 600) {
    return { timingState: !marker("startSignal") ? "missing-start" : !marker("finishPad") ? "missing-finish" : "review", totalSeconds: null, comparisonFloorSeconds: .1 };
  }
  return { timingState: "accepted", totalSeconds: total.valueSeconds, comparisonFloorSeconds: Math.min(600, Math.max(.1, total.comparisonFloorSeconds)) };
}

export function coachingRunFacts(session:SavedAnalysisSession):CoachingRunFacts {
  const summary=summarizeAttempt(session);
  const markers=sanitizeTimestampSequence(session.timestamps,session.videoMetadata?.duration);
  const marker=(id:TimestampMarker["id"])=>markers.find(m=>m.id===id&&m.source!=="Not set"&&Number.isFinite(m.rawTime));
  const metric=(id:string)=>summary.metrics.find(m=>m.id===id&&(m.confidence==="High"||m.confidence==="Medium"));
  const total=metric("total");
  const empty:CoachingRunFacts={timingState:!marker("startSignal")?"missing-start":!marker("finishPad")?"missing-finish":"review",
    totalSeconds:null,movementSeconds:null,reviewedHold10:false,bottomSeconds:null,topSeconds:null,speedCoverage:null,
    comparisonFloorsSeconds:{total:.1,bottom:null,top:null}};
  if(!total || total.valueSeconds<=0 || total.valueSeconds>600)return empty;
  const bottom=metric("bottom-phase"),top=metric("top-phase");
  const reviewedHold10=marker("hold10")?.acceptanceMode==="frame-review" && !!bottom && !!top;
  const movement=metric("reaction")?.valueSeconds;
  const result=session.biomechanics?.result;
  return {timingState:"accepted",totalSeconds:total.valueSeconds,
    movementSeconds:movement!==undefined&&movement>=0&&movement<=Math.min(30,total.valueSeconds)?movement:null,
    reviewedHold10,bottomSeconds:reviewedHold10?bottom!.valueSeconds:null,topSeconds:reviewedHold10?top!.valueSeconds:null,
    speedCoverage:result && !summary.trackingNote && summary.trackingCoverage!==undefined ? describeSpeedTrace(result).coverage : null,
    comparisonFloorsSeconds:{total:Math.min(600,Math.max(.1,total.comparisonFloorSeconds)),
      bottom:reviewedHold10?Math.min(600,Math.max(.1,bottom!.comparisonFloorSeconds)):null,
      top:reviewedHold10?Math.min(600,Math.max(.1,top!.comparisonFloorSeconds)):null}};
}

export function buildCoachingEvidence(current:SavedAnalysisSession,goal:CoachingGoal,baseline?:SavedAnalysisSession,
  options: {distinctAttemptsConfirmed?:boolean} = {}): CoachingEvidence {
  if (baseline) {
    const eligibility = coachingBaselineOptions(current, [baseline])[0];
    if (!eligibility.eligible) throw new Error("Choose a different saved attempt with accepted Start and Finish timing.");
    if (eligibility.requiresDistinctAttemptConfirmation && !options.distinctAttemptsConfirmed) throw new Error("Confirm these are two distinct climbing attempts before interpreting their timing differences.");
  }
  const packet:CoachingPacket={version:2,goal,current:coachingRunFacts(current),baseline:baseline?coachingRunFacts(baseline):null};
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
export interface CoachingEvidence {
  packet: CoachingPacket;
  catalog: ReturnType<typeof buildCoachingCatalog>;
  links: Record<string, CoachingEvidenceLink[]>;
  currentName: string;
  baselineName?: string;
  sourceFingerprint: string;
}
