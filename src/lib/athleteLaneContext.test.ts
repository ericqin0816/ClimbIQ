import { describe, expect, it } from "vitest";
import { athleteRegionGeometry, canContinueSuggestedLaneRun, clearAthleteDependentMarkers, hasFreshLaneRunContext, laneRunContextKey } from "./athleteLaneContext";
import { createPracticeSession } from "./practiceRecordings";
import type { NormalizedZone } from "../types";

const left: NormalizedZone = { id: "startBody", label: "Selected climber", x1: .1, x2: .45, y1: .4, y2: .9 };
const context = { source: "blob:current-source", acceptedStart: 9.4, trustedBodyZone: left };

describe("source-bound athlete lane context", () => {
  it("requires current native source, accepted Start, selected geometry and actual candidate evidence", () => {
    const key = laneRunContextKey(context);
    expect(hasFreshLaneRunContext(key, { ...context }, 2)).toBe(true);
    for (const changed of [{ ...context, source: "blob:another-recording" }, { ...context, acceptedStart: 9.5 },
      { ...context, trustedBodyZone: { ...left, x1: .55, x2: .99 } }, { ...context, trustedBodyZone: undefined }]) {
      expect(hasFreshLaneRunContext(key, changed, 2)).toBe(false);
    }
    expect(hasFreshLaneRunContext(key, context, 0)).toBe(false);
    expect(hasFreshLaneRunContext(null, context, 2)).toBe(false);
    expect(laneRunContextKey({ ...context, source: "" })).toBeNull();
    expect(laneRunContextKey({ ...context, acceptedStart: NaN })).toBeNull();
  });

  it("does not invent a new athlete from a label while detecting moved/deleted geometry", () => {
    expect(athleteRegionGeometry({ ...left, label: "Renamed" })).toEqual(athleteRegionGeometry(left));
    expect(athleteRegionGeometry({ ...left, x1: .55, x2: .99 })).not.toEqual(athleteRegionGeometry(left));
    expect(athleteRegionGeometry()).not.toEqual(athleteRegionGeometry(left));
  });

  it("continues only the exact offered Start with its original source and selected athlete context", () => {
    const key = laneRunContextKey(context);
    expect(canContinueSuggestedLaneRun(key, 9.4, 9.4, context)).toBe(true);
    expect(canContinueSuggestedLaneRun(key, 9.4, undefined, context)).toBe(true);
    // Neither the same displayed millisecond nor a neighboring source frame
    // establishes that an altered Start is the event discovered in that run.
    for (const reviewed of [9.4000001, 9.4004, 9.433367, 19.4, NaN]) {
      expect(canContinueSuggestedLaneRun(key, 9.4, reviewed, context)).toBe(false);
    }
    expect(canContinueSuggestedLaneRun(null, 9.4, 9.4, context)).toBe(false);
    expect(canContinueSuggestedLaneRun(key, 9.4, 9.4, { ...context, source: "blob:reattached" })).toBe(false);
    expect(canContinueSuggestedLaneRun(key, 9.4, 9.4, { ...context, trustedBodyZone: { ...left, x1: .55 } })).toBe(false);
  });

  it("clears all athlete-specific annotations on selection change while preserving Start and attempt lineage", () => {
    const session = createPracticeSession("a"), before = structuredClone(session);
    session.timestamps.find(marker => marker.id === "hold10")!.acceptanceMode = "frame-review";
    const oldStart = structuredClone(session.timestamps[0]);
    const timestamps = clearAthleteDependentMarkers(session.timestamps);
    expect(timestamps[0]).toEqual(oldStart);
    expect(timestamps.slice(1).every(marker => marker.rawTime === null && marker.source === "Not set")).toBe(true);
    expect(session.attemptLineageId).toBe(before.attemptLineageId);
    expect(session.timestamps.find(marker => marker.id === "hold10")?.rawTime).not.toBeNull();
  });
});
