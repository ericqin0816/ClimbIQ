/** Shared numeric evidence contract: no video, names or free text. */
export const COACHING_GOALS = ["overview", "start", "halves", "consistency"] as const;
export const COACHING_POLICY_VERSION = 2;
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
export interface CoachingPacket { version: 1; goal: CoachingGoal; current: CoachingRunFacts; baseline: CoachingRunFacts | null }
export interface CoachingObservation { id: string; title: string; text: string }
export interface CoachingFocus { id: string; title: string; text: string; evidenceIds: string[] }
export interface CoachingPlan { observationIds: string[]; focusId: string }
export interface CoachingComparisonRow {
  id: "total" | "bottom" | "top";
  label: string;
  currentSeconds: number;
  baselineSeconds: number;
  deltaSeconds: number;
  thresholdSeconds: number;
  outcome: "shorter" | "longer" | "similar";
}
export interface CoachingHeadline {
  title: string; detail: string;
  state: "needs-review" | "single-run" | "shorter" | "longer" | "similar";
}
export interface CoachingCatalog {
  headline: CoachingHeadline;
  comparisonRows: CoachingComparisonRow[];
  observations: CoachingObservation[];
  /** Verification work is kept separate from performance observations. */
  reviewTasks: CoachingFocus[];
  limitations: CoachingObservation[];
  focuses: CoachingFocus[];
  defaultPlan: CoachingPlan;
}
const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const bounded = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const optionalNumber = (value: unknown, min: number, max: number) => value === null || bounded(value, min, max);
const seconds = (value: number) => value.toFixed(3);

export function parseCoachingPacket(value: unknown): CoachingPacket {
  const run = (v: unknown): v is CoachingRunFacts => {
    if (!keys(v, ["timingState", "totalSeconds", "movementSeconds", "reviewedHold10", "bottomSeconds", "topSeconds", "speedCoverage", "comparisonFloorSeconds"])) return false;
    if (!["missing-start", "missing-finish", "review", "accepted"].includes(String(v.timingState)) ||
      !optionalNumber(v.totalSeconds, .001, 600) || !optionalNumber(v.movementSeconds, 0, 30) ||
      typeof v.reviewedHold10 !== "boolean" || !optionalNumber(v.bottomSeconds, .001, 600) ||
      !optionalNumber(v.topSeconds, .001, 600) || !optionalNumber(v.speedCoverage, 0, 1) || !bounded(v.comparisonFloorSeconds, .1, 600)) return false;
    if (v.timingState !== "accepted") return v.totalSeconds === null && v.movementSeconds === null &&
      !v.reviewedHold10 && v.bottomSeconds === null && v.topSeconds === null && v.speedCoverage === null;
    if (v.totalSeconds === null || (v.movementSeconds !== null && (v.movementSeconds as number) > (v.totalSeconds as number))) return false;
    if (!v.reviewedHold10) return v.bottomSeconds === null && v.topSeconds === null;
    return v.bottomSeconds !== null && v.topSeconds !== null && Math.abs((v.bottomSeconds as number) + (v.topSeconds as number) - (v.totalSeconds as number)) < .005;
  };
  if (!keys(value, ["version", "goal", "current", "baseline"]) || value.version !== 1 ||
    !COACHING_GOALS.includes(value.goal as CoachingGoal) || !run(value.current) || (value.baseline !== null && !run(value.baseline))) throw new Error("Invalid coaching evidence.");
  return value as unknown as CoachingPacket;
}

function comparisonRow(id: CoachingComparisonRow["id"], label: string, current: number, baseline: number, floor: number): CoachingComparisonRow {
  const deltaSeconds = Math.round((current - baseline) * 1000) / 1000;
  return { id, label, currentSeconds: current, baselineSeconds: baseline, deltaSeconds, thresholdSeconds: floor,
    outcome: Math.abs(deltaSeconds) <= floor + 1e-9 ? "similar" : deltaSeconds < 0 ? "shorter" : "longer" };
}

/** Canonical sentences and rows are calculated here, never supplied by a model. */
export function buildCoachingCatalog(packet: CoachingPacket): CoachingCatalog {
  parseCoachingPacket(packet);
  const { current: c, baseline: b } = packet;
  const observations: CoachingObservation[] = [];
  const limitations: CoachingObservation[] = [{ id: "measurement-limits", title: "What this review can establish",
    text: "Video-derived timing and pose estimates are not independent ground truth. This review cannot diagnose technique, injury risk, or the cause of a timing change." }];
  const focuses: CoachingFocus[] = [];
  const reviewTasks: CoachingFocus[] = [];
  const comparisonRows: CoachingComparisonRow[] = [];
  const fact = (id: string, title: string, text: string) => observations.push({ id, title, text });
  const limit = (id: string, title: string, text: string) => limitations.push({ id, title, text });
  const focus = (id: string, title: string, text: string, evidenceIds: string[]) => {
    const item = { id, title, text, evidenceIds }; focuses.push(item); return item;
  };
  const task = (id: string, title: string, text: string, evidenceIds: string[]) => reviewTasks.push(focus(id, title, text, evidenceIds));
  let headline: CoachingHeadline = { title: "Confirm the timing before comparing runs.",
    detail: "The next step is to review the evidence. There is no supported performance conclusion yet.", state: "needs-review" };

  if (c.timingState !== "accepted") {
    limit("timing-review", "Review the timing first", c.timingState === "missing-start" ? "Start is not accepted. No performance conclusion is available."
      : c.timingState === "missing-finish" ? "Finish is not accepted. A suggested finish cannot establish a total or finishing pace."
        : "The timing is incomplete or below the review policy's confidence requirement.");
    task("review-timing", "Confirm Start and Finish", "Inspect the source frames and accept the correct markers before using this run for comparison.", ["timing-review"]);
  } else {
    headline = { title: `${seconds(c.totalSeconds!)}s accepted video time`,
      detail: "This describes one recorded attempt. Choose a comparable saved attempt to identify measured changes.", state: "single-run" };
    fact("total", "Accepted video timing", `The accepted Start → Finish interval is ${seconds(c.totalSeconds!)}s. This is the app's video estimate, not an electronic-timer verification.`);
    if (c.movementSeconds !== null) {
      fact("movement", "First visible movement", `First visible movement is ${seconds(c.movementSeconds)}s after Start. This is not an electronic reaction-time or false-start measurement.`);
      focus("review-start", "Inspect the launch", "Replay Start and first visible movement. Compare what is visible before attributing the delay to reaction or technique.", ["movement"]);
    } else task("review-movement", "Check first visible movement", "No first-movement interval meets this review's evidence requirements. Inspect the launch before drawing conclusions about the start.", ["movement"]);
    if (c.reviewedHold10) fact("halves", "Reviewed Hold 10 phases", `Start → Hold 10 is ${seconds(c.bottomSeconds!)}s; Hold 10 → Finish is ${seconds(c.topSeconds!)}s. These phases depend on the reviewed contact marker. They are not equal-distance or equal-difficulty halves.`);
    else {
      limit("hold10-review", "Hold 10 still needs review", "No frame-reviewed Hold 10 contact is available. Bottom/top-half conclusions are withheld.");
      task("review-hold10", "Confirm the Hold 10 contact", "Inspect the reach and surrounding frames. Confirm contact only when it is visible; a height crossing is not a contact time.", ["hold10-review"]);
    }
    if (c.speedCoverage === null) limit("tracking-unavailable", "No current speed trace", "Current, usable tracking is unavailable. The chart cannot support pacing or body-position advice.");
    else {
      fact("tracking", "Speed-trace availability", `Usable speed-trace segments cover ${Math.round(c.speedCoverage * 100)}% of the timed run. Coverage measures availability, not spatial accuracy or movement quality.`);
      if (c.speedCoverage < .95) limit("tracking-gaps", "Do not infer through gaps", "Tracking is incomplete. Missing sections and individual speed spikes do not establish slowing, fatigue, or technique faults.");
    }
    if (c.speedCoverage === null || c.speedCoverage < .8) task("improve-recording", "Check tracking before judging pace", "Check whether the full lane, start, and finish stayed visible with a fixed camera. Missing tracking calls for better evidence, not a technique diagnosis.", [c.speedCoverage === null ? "tracking-unavailable" : "tracking-gaps"]);
    if (b?.timingState === "accepted") {
      const floor = Math.max(c.comparisonFloorSeconds, b.comparisonFloorSeconds, .1);
      const total = comparisonRow("total", "Start → Finish", c.totalSeconds!, b.totalSeconds!, floor);
      comparisonRows.push(total);
      headline = {
        title: total.outcome === "similar" ? "No supported overall change." : `${seconds(Math.abs(total.deltaSeconds))}s ${total.outcome} overall`,
        detail: total.outcome === "similar" ? `The ${seconds(Math.abs(total.deltaSeconds))}s difference is within the ${seconds(floor)}s comparison rule. It is too small for this review to classify.`
          : `Compared with the selected baseline. The difference exceeds the ${seconds(floor)}s comparison rule; it does not establish why the time changed.`,
        state: total.outcome,
      };
      const compare = (row: CoachingComparisonRow, id: string, title: string) => {
        if (row.outcome === "similar") return false;
        fact(id, title, `${row.label} is ${seconds(Math.abs(row.deltaSeconds))}s ${row.outcome} than the selected baseline (${seconds(row.currentSeconds)}s vs ${seconds(row.baselineSeconds)}s). This exceeds the ${seconds(floor)}s comparison policy, which is not a measured error bound.`);
        return true;
      };
      if (!compare(total, "total-change", "Total-time comparison")) fact("no-change", "No supported overall change", `The total difference is within the ${seconds(floor)}s comparison policy. No overall gain or loss is established.`);
      if (c.reviewedHold10 && b.reviewedHold10) {
        const bottom = comparisonRow("bottom", "Start → Hold 10", c.bottomSeconds!, b.bottomSeconds!, floor);
        const top = comparisonRow("top", "Hold 10 → Finish", c.topSeconds!, b.topSeconds!, floor);
        comparisonRows.push(bottom, top);
        if (compare(bottom, "bottom-change", "Before Hold 10")) focus("review-bottom", "Compare the section before Hold 10", "Replay Start → Hold 10 in both attempts. Inspect the section with a supported timing difference before deciding what to change in training.", ["bottom-change"]);
        if (compare(top, "top-change", "After Hold 10")) focus("review-top", "Compare the section after Hold 10", "Replay Hold 10 → Finish in both attempts. The difference identifies where to look; the measurements do not show its cause.", ["top-change"]);
        if (bottom.outcome !== "similar" && top.outcome !== "similar" && bottom.outcome !== top.outcome) fact("phase-balance", "The section changes offset each other",
          `Before Hold 10 is ${seconds(Math.abs(bottom.deltaSeconds))}s ${bottom.outcome}; after Hold 10 is ${seconds(Math.abs(top.deltaSeconds))}s ${top.outcome}. ${total.outcome === "similar" ? "The total difference still falls within the comparison rule." : `Together, the two phases leave the run ${seconds(Math.abs(total.deltaSeconds))}s ${total.outcome} overall.`} A timing tradeoff is visible; its cause is not established.`);
        limit("phase-overlap", "Compare each section once", "The two Hold 10 phases partition the total. First movement and any wall-height splits overlap these phases; adding them would count some time twice.");
      } else {
        limit("comparison-contact-review", "Half comparisons withheld", "Both attempts need frame-reviewed Hold 10 contact before their phases can be compared. The total comparison remains available.");
        if (!b.reviewedHold10) task("review-baseline-hold10", "Review the baseline contact", "Open the baseline attempt and confirm its Hold 10 contact. A current-video link cannot review a different recording.", []);
      }
      limit("comparison-policy", "Small changes stay unclassified", `This review uses a conservative ${seconds(floor)}s comparison rule, including the largest supplied observation interval. It is a display rule, not a measured error bar or proof of statistical significance.`);
    } else limit("baseline-missing", b ? "Baseline timing needs review" : "One run is not a trend", b
      ? "The selected baseline does not have usable accepted Start and Finish timing. Single-run observations remain available; change claims are withheld."
      : "Choose a saved attempt from the same climber, route, and comparable recording setup to assess changes between runs.");
    focus("record-comparable", b?.timingState === "accepted" ? "Check whether the difference repeats" : "Save a comparable attempt",
      b?.timingState === "accepted" ? "Save another attempt from the same climber and setup. Two attempts can show a timing difference, but cannot establish a stable trend or the cause of that difference."
        : "Save this run, then record another attempt from the same climber, route, and setup. Compare the accepted intervals after checking both recordings.",
      [b?.timingState === "accepted" ? "total" : "baseline-missing"]);
  }
  const changedPhases = comparisonRows.filter(row => row.id !== "total" && row.outcome !== "similar")
    .sort((left, right) => Math.abs(right.deltaSeconds) - Math.abs(left.deltaSeconds) || left.id.localeCompare(right.id));
  const comparisonIds = comparisonRows.length ? [observations.some(item => item.id === "total-change") ? "total-change" : "no-change"] : [];
  const phaseIds = changedPhases.map(row => `${row.id}-change`);
  const preferredIds = packet.goal === "start" ? [...comparisonIds, "movement", ...phaseIds]
    : [...comparisonIds, ...(observations.some(item => item.id === "phase-balance") ? ["phase-balance"] : []), ...phaseIds,
      ...(packet.goal === "halves" ? ["halves", "total", "movement"] : ["total", "movement", "halves"]), "tracking"];
  const observationIds = [...new Set([...preferredIds, ...observations.map(item => item.id)])]
    .filter(id => observations.some(item => item.id === id)).slice(0, 3);
  const preferredFocus = c.timingState !== "accepted" ? "review-timing" : packet.goal === "start" ? (c.movementSeconds === null ? "review-movement" : "review-start")
    : packet.goal === "consistency" ? "record-comparable" : changedPhases[0] ? `review-${changedPhases[0].id}` : !c.reviewedHold10 ? "review-hold10" : "record-comparable";
  return { headline, comparisonRows, observations, reviewTasks, limitations, focuses,
    defaultPlan: { observationIds, focusId: (focuses.find(item => item.id === preferredFocus) ?? focuses[0]).id } };
}

/** The model may select IDs, never supply measurements, causes, drills or prose. */
export function validateCoachingPlan(value: unknown, catalog: CoachingCatalog): CoachingPlan {
  if (!keys(value, ["observationIds", "focusId"]) || !Array.isArray(value.observationIds) || value.observationIds.length > 3 ||
    value.observationIds.length < Math.min(1, catalog.observations.length) || new Set(value.observationIds).size !== value.observationIds.length ||
    !value.observationIds.every(id => typeof id === "string" && catalog.observations.some(item => item.id === id)) ||
    !catalog.focuses.some(item => item.id === value.focusId)) throw new Error("The AI response contained unsupported advice.");
  return { observationIds: value.observationIds as string[], focusId: value.focusId as string };
}
