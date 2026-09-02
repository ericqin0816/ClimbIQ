import { describe, expect, it } from "vitest";
import type { TimestampMarker, TimestampSource } from "../types";
import { isLegacyAutomaticHold10Marker } from "./hold10MarkerPolicy";

describe("Hold 10 accepted-marker policy", () => {
  it("does not turn a fresh detector proposal into an accepted marker", () => {
    const timestamps = sequence("Not set", null);
    expect(isLegacyAutomaticHold10Marker(timestamps.find((marker) => marker.id === "hold10")!)).toBe(false);
    expect(timestamps.find((marker) => marker.id === "hold10")?.rawTime).toBeNull();
  });

  it("preserves a user-reviewed manual marker when detection changes", () => {
    const timestamps = sequence("Manual", 11.5);
    expect(isLegacyAutomaticHold10Marker(timestamps.find((marker) => marker.id === "hold10")!)).toBe(false);
  });

  it.each(["COM halfway estimate", "Hold contact detection", "Future / experimental"] as const)(
    "identifies a legacy automatic marker from %s",
    (source) => {
      const marker = sequence(source, 11.5).find((item) => item.id === "hold10")!;
      expect(isLegacyAutomaticHold10Marker(marker)).toBe(true);
    },
  );

  it("does not classify another marker as legacy Hold 10 evidence", () => {
    const start = sequence("Manual", 11.5).find((marker) => marker.id === "startSignal")!;
    start.source = "Hold contact detection";
    expect(isLegacyAutomaticHold10Marker(start)).toBe(false);
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
