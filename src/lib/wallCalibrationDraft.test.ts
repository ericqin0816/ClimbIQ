import { describe, expect, it } from "vitest";
import { buildWallCalibration, validateWallCalibration } from "./wallCalibration";
import { completedCalibrationPoints, editCalibrationCoordinate, emptyWallCalibrationDraft, markNextCalibrationCorner, nextCalibrationCorner, undoCalibrationCorner } from "./wallCalibrationDraft";

describe("wall corner entry", () => {
  it("supports editing corner four before corner one without holes or invented coordinates", () => {
    let draft = editCalibrationCoordinate(emptyWallCalibrationDraft(), 3, "x", "10");
    draft = editCalibrationCoordinate(draft, 3, "x", "12");
    expect(draft.points).toEqual([{ x: null, y: null }, { x: null, y: null }, { x: null, y: null }, { x: .12, y: null }]);
    expect(draft.points.map(point => point.x)).toEqual([null, null, null, .12]);
    expect(completedCalibrationPoints(draft)).toBeNull();
    expect(nextCalibrationCorner(draft)).toBe(0);
  });

  it("preserves missing values when a field is cleared and permits mixed keyboard and pointer entry", () => {
    let draft = emptyWallCalibrationDraft();
    draft = editCalibrationCoordinate(draft, 3, "x", "10");
    draft = editCalibrationCoordinate(draft, 3, "y", "10");
    draft = markNextCalibrationCorner(draft, { x: .1, y: .9 });
    draft = markNextCalibrationCorner(draft, { x: .9, y: .9 });
    draft = markNextCalibrationCorner(draft, { x: .9, y: .1 });
    const complete = completedCalibrationPoints(draft);
    expect(complete).toHaveLength(4);
    expect(validateWallCalibration(buildWallCalibration(complete!, 1, true)).valid).toBe(true);
    expect(nextCalibrationCorner(draft)).toBe(-1);
    draft = editCalibrationCoordinate(draft, 1, "x", "");
    expect(draft.points[1]).toEqual({ x: null, y: .9 });
    expect(completedCalibrationPoints(draft)).toBeNull();
    expect(nextCalibrationCorner(draft)).toBe(1);
    expect(editCalibrationCoordinate(draft, 1, "x", "not a number").points[1].x).toBeNull();
  });

  it("undoes the last edited corner rather than deleting another out-of-order corner", () => {
    let draft = editCalibrationCoordinate(emptyWallCalibrationDraft(), 3, "x", "15");
    draft = editCalibrationCoordinate(draft, 3, "y", "10");
    draft = markNextCalibrationCorner(draft, { x: .1, y: .9 });
    draft = undoCalibrationCorner(draft);
    expect(draft.points[0]).toEqual({ x: null, y: null });
    expect(draft.points[3]).toEqual({ x: .15, y: .1 });
    draft = undoCalibrationCorner(draft);
    expect(draft).toEqual(emptyWallCalibrationDraft());
  });
});
