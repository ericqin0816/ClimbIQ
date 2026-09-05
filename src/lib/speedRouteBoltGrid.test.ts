import { describe, expect, it } from "vitest";
import { SPEED_ROUTE_BOLTS, SPEED_ROUTE_BOLT_GRID_SOURCE } from "./speedRouteBoltGrid";

describe("published speed route attachment grid", () => {
  it("matches the independently specified starting bolt height above ground", () => {
    const first = SPEED_ROUTE_BOLTS[0];
    expect(first.panel).toBe("DX2");
    expect(first.gridPosition).toBe("F1");
    expect(first.wall.yMeters + SPEED_ROUTE_BOLT_GRID_SOURCE.groundClearanceMeters).toBe(1.8875);
    expect(first.wall.xMeters).toBe(2.25);
  });
  it("uses the drawing's eleven columns, skipping J and K", () => {
    expect(SPEED_ROUTE_BOLTS[10]).toMatchObject({ panel: "SN6", gridPosition: "L7", wall: { xMeters: 1.25, yMeters: 8.4375 } });
    expect(SPEED_ROUTE_BOLTS[19].wall.xMeters).toBe(1.375);
  });
  it("orders the final panel-grouped rows by height", () => {
    expect(SPEED_ROUTE_BOLTS.slice(-3).map(b => b.panel)).toEqual(["DX9", "DX9", "SN9"]);
    expect(SPEED_ROUTE_BOLTS[9]).toMatchObject({ id: 10, panel: "SN6", gridPosition: "H2", wall: { xMeters: 1, yMeters: 7.8125 } });
    for (let i = 1; i < SPEED_ROUTE_BOLTS.length; i++) expect(SPEED_ROUTE_BOLTS[i].wall.yMeters).toBeGreaterThan(SPEED_ROUTE_BOLTS[i - 1].wall.yMeters);
    expect(SPEED_ROUTE_BOLTS).toHaveLength(20);
  });
  it("keeps the bolt/contact distinction explicit", () => {
    expect(SPEED_ROUTE_BOLT_GRID_SOURCE.referenceKind).toBe("attachment-bolt");
  });
});
