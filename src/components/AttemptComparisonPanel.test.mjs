import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AttemptComparisonPanel from "./AttemptComparisonPanel";

function session(id, finish) {
  return {
    id, version: 1, name: id, climberName: "Climber", date: "2026-10-23", location: "Gym",
    attemptType: "Training", notes: "", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z",
    videoMetadata: null, zones: {}, startLightCalibration: {}, settings: {},
    timestamps: [
      { id: "startSignal", label: "Start", rawTime: 1, climbTime: 0, source: "Manual", confidence: "Medium", acceptanceMode: "frame-review" },
      { id: "finishPad", label: "Finish", rawTime: finish, climbTime: finish - 1, source: "Manual", confidence: "Medium", acceptanceMode: "frame-review" },
    ],
  };
}

describe("saved attempt comparability review", () => {
  it("shows recorded deltas and a meaningful contextual review without making a training claim", () => {
    const html = renderToStaticMarkup(createElement(AttemptComparisonPanel, { sessions: [session("a", 11), session("b", 10.7)] }));
    expect(html).toContain("0.300s · Recorded difference");
    expect(html).toContain("same climber on the same route");
    expect(html).toContain("comparable normal-speed video clocks");
    expect(html).toContain("same physical events");
    expect(html).toContain("not independent verification or a timing-accuracy guarantee");
    expect(html).not.toMatch(/was .*faster|was .*slower|Replay changed/);
  });
  it("does not allow contextual review to unlock analyses of the same attempt", () => {
    const a = session("a", 11), b = session("b", 10.7); b.attemptLineageId = a.id;
    const html = renderToStaticMarkup(createElement(AttemptComparisonPanel, { sessions: [a, b] }));
    expect(html).toContain("Annotation comparison only");
    expect(html).toContain('type="checkbox" disabled=""');
    expect(html).toContain("annotation differences");
  });
  it("keeps mixed practice-personal figures observable with contextual confirmation disabled", () => {
    const a = session("a", 11), b = session("b", 10.7); a.attemptLineageId = "climbiq-practice-v1-a";
    const html = renderToStaticMarkup(createElement(AttemptComparisonPanel, { sessions: [a, b] }));
    expect(html).toContain("0.300s · Recorded difference");
    expect(html).toContain('type="checkbox" disabled=""');
    expect(html).toContain("bundled synthetic practice and a personal recording");
  });
});
