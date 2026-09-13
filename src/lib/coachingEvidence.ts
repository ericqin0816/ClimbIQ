import type {SavedAnalysisSession, TimestampMarker} from "../types";
import {summarizeAttempt} from "./attemptComparison";
import {sanitizeTimestampSequence} from "./timestampIntegrity";
import {describeSpeedTrace} from "./biomechanicsPresentation";
import {buildSectionReview} from "./coachingSections";
import {buildCoachingCatalog, type CoachingGoal, type CoachingPacket, type CoachingRunFacts} from "./coachingPolicy";

export interface CoachingEvidenceLink {label:string; rawTime:number}
export function coachingRunFacts(session:SavedAnalysisSession):CoachingRunFacts {
  const summary=summarizeAttempt(session);
  const markers=sanitizeTimestampSequence(session.timestamps,session.videoMetadata?.duration);
  const marker=(id:TimestampMarker["id"])=>markers.find(m=>m.id===id&&Number.isFinite(m.rawTime));
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
    "timing-review":[...start,...finish],"hold10-review":[],tracking:[],
  };
  return {packet,catalog:buildCoachingCatalog(packet),links,currentName:current.name,baselineName:baseline?.name,sectionReview:buildSectionReview(current,baseline)};
}
export type CoachingEvidence = ReturnType<typeof buildCoachingEvidence>;
