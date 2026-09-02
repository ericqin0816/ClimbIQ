import { describe, expect, it } from "vitest";
import type { TimestampMarker, TimestampSource } from "../types";
import { reconcileHold10Marker } from "./hold10MarkerPolicy";

describe("Hold 10 accepted-marker policy", () => {
  it("does not turn a fresh detector proposal into an accepted marker", () => {
    const timestamps = sequence("Not set", null);
    expect(reconcileHold10Marker(timestamps, 11.515)).toBe(timestamps);
    expect(timestamps.find((marker) => marker.id === "hold10")?.rawTime).toBeNull();
  });

  it("preserves a user-reviewed manual marker when detection changes", () => {
    const timestamps = sequence("Manual", 11.5);
    expect(reconcileHold10Marker(timestamps, 11.8)).toBe(timestamps);
  });

  it("clears a stale marker written automatically by an older version", () => {
    const reconciled = reconcileHold10Marker(sequence("Hold contact detection", 11.5), 11.8);
    const hold10 = reconciled.find((marker) => marker.id === "hold10")!;
    expect(hold10.rawTime).toBeNull();
    expect(hold10.source).toBe("Not set");
  });

  it("keeps a matching legacy automatic marker until the user reviews it", () => {
    const timestamps = sequence("Hold contact detection", 11.5);
    expect(reconcileHold10Marker(timestamps, 11.5)).toBe(timestamps);
  });
});

function sequence(hold10Source: TimestampSource, hold10RawTime: number | null): TimestampMarker[] {
  return [
    marker("startSignal", "Start Signal", "Manual", 7.13),
    marker("hold10", "Hold 10", hold10Source, hold10RawTime),
    marker("finishPad", "Finish Pad", "Manual", 17.48),
  ];
}

function marker(
  id: TimestampMarker["id"],
  label: string,
  source: TimestampSource,
  rawTime: number | null,
): TimestampMarker {
  return {
    id,
    label,
    rawTime,
    climbTime: rawTime === null ? null : id === "startSignal" ? 0 : rawTime - 7.13,
    source,
    confidence: rawTime === null ? "None" : "Medium",
  };
}
