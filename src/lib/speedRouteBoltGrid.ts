import type { WallPoint } from "../types";
import type { StandardSpeedHoldId } from "./standardSpeedRoute";

/**
 * Attachment-bolt reference, NOT a hand contact point or silhouette centroid.
 * Source: IFSC Speed Licence Rules – Speed Walls, 01/02/2022, pp. 5 and 7.
 * https://images.ifsc-climbing.org/ifsc/image/private/t_q_good/prd/urwl7n2hnnyvhiwiq0xg.pdf
 * Still linked by World Climbing's equipment page when checked 2026-09-05.
 * Coordinates are relative to the bottom-left edge of the panel grid, excluding
 * the 0.20 m ground clearance. SN is the left panel and DX the right panel.
 */
export const SPEED_ROUTE_BOLT_GRID_SOURCE = {
  id: "ifsc-2022-bolt-grid-v1",
  url: "https://images.ifsc-climbing.org/ifsc/image/private/t_q_good/prd/urwl7n2hnnyvhiwiq0xg.pdf",
  documentDate: "2022-02-01",
  referenceKind: "attachment-bolt" as const,
  groundClearanceMeters: 0.2,
};

const COLUMNS = "ABCDEFGHILM";
// Sorted by attachment height, not by the source table's panel grouping.
const ATTACHMENTS: ReadonlyArray<readonly ["SN" | "DX", number, string, number]> = [
  ["DX", 2, "F", 1], ["DX", 2, "G", 3], ["DX", 2, "A", 9],
  ["SN", 3, "G", 4], ["SN", 3, "M", 10],
  ["DX", 4, "B", 2], ["SN", 4, "M", 8],
  ["DX", 5, "C", 3], ["DX", 5, "E", 9],
  ["SN", 6, "H", 2], ["SN", 6, "L", 7], ["SN", 6, "F", 9],
  ["SN", 7, "M", 4], ["SN", 7, "G", 9],
  ["SN", 8, "L", 1], ["SN", 8, "I", 3], ["SN", 8, "C", 8],
  ["DX", 9, "A", 2], ["DX", 9, "E", 7], ["SN", 9, "M", 10],
];

export interface SpeedRouteBolt {
  id: StandardSpeedHoldId;
  panel: string;
  gridPosition: string;
  wall: Readonly<WallPoint>;
}

export const SPEED_ROUTE_BOLTS: readonly SpeedRouteBolt[] = Object.freeze(
  ATTACHMENTS.map(([side, panel, column, row], index) => Object.freeze({
    id: (index + 1) as StandardSpeedHoldId,
    panel: `${side}${panel}`,
    gridPosition: `${column}${row}`,
    wall: Object.freeze({
      xMeters: (side === "DX" ? 1.5 : 0) + 0.125 + COLUMNS.indexOf(column) * 0.125,
      yMeters: (panel - 1) * 1.5 + 0.1875 + (row - 1) * 0.125,
    }),
  })),
);
