import type { NormalizedPoint } from "../types";

export interface CalibrationDraftPoint { x: number | null; y: number | null }
export interface WallCalibrationDraft {
  points: [CalibrationDraftPoint, CalibrationDraftPoint, CalibrationDraftPoint, CalibrationDraftPoint];
  /** Most recently edited corner is undone first, including keyboard edits. */
  editOrder: number[];
}

export function emptyWallCalibrationDraft(): WallCalibrationDraft {
  return { points: [{ x: null, y: null }, { x: null, y: null }, { x: null, y: null }, { x: null, y: null }], editOrder: [] };
}

export function completeDraftPoint(point: CalibrationDraftPoint): point is NormalizedPoint {
  return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

export function completedCalibrationPoints(draft: WallCalibrationDraft): NormalizedPoint[] | null {
  return draft.points.every(completeDraftPoint) ? draft.points : null;
}

export function nextCalibrationCorner(draft: WallCalibrationDraft): number {
  return draft.points.findIndex(point => !completeDraftPoint(point));
}

function editPoint(draft: WallCalibrationDraft, index: number, point: CalibrationDraftPoint): WallCalibrationDraft {
  if (!Number.isInteger(index) || index < 0 || index >= 4) return draft;
  const points: WallCalibrationDraft["points"] = [...draft.points];
  points[index] = point;
  return { points, editOrder: [...draft.editOrder.filter(corner => corner !== index), index] };
}

/** Empty fields remain missing; entering X must never invent the missing Y. */
export function editCalibrationCoordinate(draft: WallCalibrationDraft, index: number, axis: "x" | "y", text: string): WallCalibrationDraft {
  if (!Number.isInteger(index) || index < 0 || index >= 4) return draft;
  const percent = text.trim() === "" ? NaN : Number(text);
  const coordinate = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : null;
  return editPoint(draft, index, { ...draft.points[index], [axis]: coordinate });
}

/** Pointer input fills the first unfinished named corner, preserving later keyboard entries. */
export function markNextCalibrationCorner(draft: WallCalibrationDraft, point: NormalizedPoint): WallCalibrationDraft {
  const index = nextCalibrationCorner(draft);
  return index < 0 || !completeDraftPoint(point) ? draft : editPoint(draft, index, point);
}

export function undoCalibrationCorner(draft: WallCalibrationDraft): WallCalibrationDraft {
  const index = draft.editOrder.at(-1);
  if (index === undefined) return draft;
  const points: WallCalibrationDraft["points"] = [...draft.points];
  points[index] = { x: null, y: null };
  return { points, editOrder: draft.editOrder.slice(0, -1) };
}
