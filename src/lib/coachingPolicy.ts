/** Shared, provider-independent evidence contract. No video, names or free text. */
export const COACHING_GOALS = ["overview", "start", "halves", "consistency"] as const;
export type CoachingGoal = typeof COACHING_GOALS[number];
export interface CoachingRunFacts {
  timingState: "missing-start" | "missing-finish" | "review" | "accepted";
  totalSeconds: number | null;
  movementSeconds: number | null;
  reviewedHold10: boolean;
  bottomSeconds: number | null;
  topSeconds: number | null;
  speedCoverage: number | null;
  comparisonFloorSeconds: number;
}
export interface CoachingPacket {
  version: 1;
  goal: CoachingGoal;
  current: CoachingRunFacts;
  baseline: CoachingRunFacts | null;
}
export interface CoachingObservation { id: string; title: string; text: string }
export interface CoachingFocus { id: string; title: string; text: string; evidenceIds: string[] }
export interface CoachingPlan { observationIds: string[]; focusId: string }
export interface CoachingCatalog {
  observations: CoachingObservation[];
  limitations: CoachingObservation[];
  focuses: CoachingFocus[];
  defaultPlan: CoachingPlan;
}

const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === allowed.length && Object.keys(value).every(key=>allowed.includes(key));
const bounded = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value>=min && value<=max;
const optionalNumber = (value: unknown, min: number, max: number) => value===null || bounded(value,min,max);

export function parseCoachingPacket(value: unknown): CoachingPacket {
  const run = (v: unknown): v is CoachingRunFacts => {
    if (!keys(v,["timingState","totalSeconds","movementSeconds","reviewedHold10","bottomSeconds","topSeconds","speedCoverage","comparisonFloorSeconds"])) return false;
    if (!["missing-start","missing-finish","review","accepted"].includes(String(v.timingState)) ||
        !optionalNumber(v.totalSeconds,.001,600) || !optionalNumber(v.movementSeconds,0,30) ||
        typeof v.reviewedHold10!=="boolean" || !optionalNumber(v.bottomSeconds,.001,600) ||
        !optionalNumber(v.topSeconds,.001,600) || !optionalNumber(v.speedCoverage,0,1) ||
        !bounded(v.comparisonFloorSeconds,.1,600)) return false;
    if (v.timingState!=="accepted") return v.totalSeconds===null && v.movementSeconds===null &&
      !v.reviewedHold10 && v.bottomSeconds===null && v.topSeconds===null && v.speedCoverage===null;
    if (v.totalSeconds===null || (v.movementSeconds!==null && (v.movementSeconds as number)>(v.totalSeconds as number))) return false;
    if (!v.reviewedHold10) return v.bottomSeconds===null && v.topSeconds===null;
    return v.bottomSeconds!==null && v.topSeconds!==null && Math.abs((v.bottomSeconds as number)+(v.topSeconds as number)-(v.totalSeconds as number))<.005;
  };
  if (!keys(value,["version","goal","current","baseline"]) || value.version!==1 ||
      !COACHING_GOALS.includes(value.goal as CoachingGoal) || !run(value.current) ||
      (value.baseline!==null && !run(value.baseline))) throw new Error("Invalid coaching evidence.");
  return value as unknown as CoachingPacket;
}

/** The model may select IDs, never supply measurements, causes, drills or prose. */
export function buildCoachingCatalog(packet: CoachingPacket): CoachingCatalog {
  parseCoachingPacket(packet);
  const {current: c,baseline:b}=packet;
  const observations: CoachingObservation[]=[];
  const limitations: CoachingObservation[]=[{id:"measurement-limits",title:"What this review can establish",
    text:"Video-derived timing and pose estimates are not independent ground truth. This review cannot diagnose technique, injury risk, or the cause of a timing change."}];
  const focuses: CoachingFocus[]=[];
  const fact=(id:string,title:string,text:string)=>observations.push({id,title,text});
  const limit=(id:string,title:string,text:string)=>limitations.push({id,title,text});
  const focus=(id:string,title:string,text:string,evidenceIds:string[])=>focuses.push({id,title,text,evidenceIds});
  if (c.timingState!=="accepted") {
    limit("timing-review","Review the timing first",c.timingState==="missing-start" ? "Start is not accepted. No performance conclusion is available."
      : c.timingState==="missing-finish" ? "Finish is not accepted. A suggested finish cannot establish a total or finishing pace."
        : "The timing is incomplete or below the review policy's confidence requirement.");
    focus("review-timing","Confirm Start and Finish","Inspect the source frames and accepted markers before using this run for coaching.",["timing-review"]);
  } else {
    fact("total","Accepted video timing",`The accepted Start → Finish interval is ${c.totalSeconds!.toFixed(3)}s. This is the app's video estimate, not an electronic-timer verification.`);
    if (c.movementSeconds!==null) {
      fact("movement","First visible movement",`First visible movement is ${c.movementSeconds.toFixed(3)}s after Start. This is not an electronic reaction-time or false-start measurement.`);
      focus("review-start","Inspect the launch","Replay Start and first visible movement. Compare what is visible before attributing the delay to reaction or technique.",["movement"]);
    }
    if (c.reviewedHold10) fact("halves","Reviewed Hold 10 phases",`Start → Hold 10 is ${c.bottomSeconds!.toFixed(3)}s; Hold 10 → Finish is ${c.topSeconds!.toFixed(3)}s. These phases depend on the reviewed contact marker.`);
    else {
      limit("hold10-review","Hold 10 still needs review","No frame-reviewed Hold 10 contact is available. Bottom/top-half conclusions are withheld.");
      focus("review-hold10","Review the Hold 10 reach","Use the wider context strip to inspect the reach, then confirm contact in the full video before comparing the halves.",["hold10-review"]);
    }
    if (c.speedCoverage===null) limit("tracking-unavailable","No current speed trace","Current, usable tracking is unavailable. The chart cannot support pacing or body-position advice.");
    else {
      fact("tracking","Speed-trace availability",`A continuous speed trace covers ${Math.round(c.speedCoverage*100)}% of the timed run. Coverage is availability, not a spatial-accuracy score.`);
      if(c.speedCoverage<.95) limit("tracking-gaps","Do not infer through gaps","Tracking is incomplete. Missing sections and individual speed spikes do not establish slowing, fatigue, or technique faults.");
    }
    if(c.speedCoverage===null || c.speedCoverage<.8) focus("improve-recording","Keep the evidence usable","For the next recording, keep the camera fixed and the full selected lane, start light, and finish area visible. Do not draw pacing conclusions from missing frames.",[c.speedCoverage===null?"tracking-unavailable":"tracking-gaps"]);
    if(b?.timingState==="accepted") {
      const floor=Math.max(c.comparisonFloorSeconds,b.comparisonFloorSeconds,.1);
      const compare=(id:string,title:string,current:number,baseline:number)=>{
        const delta=current-baseline;
        if(Math.abs(delta)<=floor+1e-9) return false;
        fact(id,title,`The current interval is ${Math.abs(delta).toFixed(3)}s ${delta<0?"shorter":"longer"} than the selected baseline (${current.toFixed(3)}s vs ${baseline.toFixed(3)}s). This exceeds the ${floor.toFixed(3)}s comparison policy, which is not a measured error bound.`);
        return true;
      };
      const changed=compare("total-change","Total-time comparison",c.totalSeconds!,b.totalSeconds!);
      if(!changed) fact("no-change","No supported overall change",`The total difference is within the ${floor.toFixed(3)}s comparison policy. No overall gain or loss is established.`);
      if(c.reviewedHold10 && b.reviewedHold10) {
        if(compare("bottom-change","Bottom-half comparison",c.bottomSeconds!,b.bottomSeconds!)) focus("review-bottom","Compare the bottom-half clips","Replay Start → Hold 10 in both attempts. The timing difference identifies a section to inspect, not its cause.",["bottom-change"]);
        if(compare("top-change","Top-half comparison",c.topSeconds!,b.topSeconds!)) focus("review-top","Compare the top-half clips","Replay Hold 10 → Finish in both attempts. Ask what changed; the metrics alone cannot explain why.",["top-change"]);
      } else limit("comparison-contact-review","Half comparisons withheld","Both attempts need frame-reviewed Hold 10 contact before their halves can be compared.");
    } else limit("baseline-missing","One run is not a trend","Choose a saved attempt from the same climber and a comparable setup to assess changes between runs.");
    focus("record-comparable","Build a comparable baseline","Save this review and another attempt from the same climber and setup. Look for repeatable differences rather than a single apparent spike.",[b?"total":"baseline-missing"]);
  }
  const preferred=packet.goal==="start"?"review-start":packet.goal==="halves"?(c.reviewedHold10?"review-top":"review-hold10"):
    packet.goal==="consistency"?"record-comparable":c.reviewedHold10?"record-comparable":"review-hold10";
  return {observations,limitations,focuses,defaultPlan:{observationIds:observations.slice(0,3).map(o=>o.id),focusId:(focuses.find(f=>f.id===preferred)??focuses[0]).id}};
}

export function validateCoachingPlan(value:unknown,catalog:CoachingCatalog):CoachingPlan {
  if(!keys(value,["observationIds","focusId"]) || !Array.isArray(value.observationIds) || value.observationIds.length>3 ||
    value.observationIds.length<Math.min(1,catalog.observations.length) || new Set(value.observationIds).size!==value.observationIds.length ||
    !value.observationIds.every(id=>typeof id==="string"&&catalog.observations.some(o=>o.id===id)) ||
    !catalog.focuses.some(f=>f.id===value.focusId)) throw new Error("The AI response contained unsupported advice.");
  return {observationIds:value.observationIds as string[],focusId:value.focusId as string};
}
