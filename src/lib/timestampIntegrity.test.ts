import { describe, expect, it } from "vitest";
import type { TimestampMarker } from "../types";
import {
  applyTimestampAcceptance,
  clearMarkerTimestamp,
  sanitizeTimestampSequence,
} from "./timestampIntegrity";

describe("timestamp integrity", () => {
  it("clears every dependent marker when Start changes", () => {
    const result = applyTimestampAcceptance(populated(), {
      id: "startSignal",
      rawTime: 6,
      source: "Manual",
      confidence: "Medium",
      durationSeconds: 20,
    });
    expect(result.accepted).toBe(true);
    expect(result.timestamps.find((marker) => marker.id === "startSignal")?.rawTime).toBe(6);
    expect(result.timestamps.filter((marker) => marker.id !== "startSignal").every((marker) => marker.rawTime === null)).toBe(true);
  });

  it("clears derived markers that fall after a corrected earlier finish", () => {
    const markers = populated();
    markers.find((marker) => marker.id === "hold10")!.rawTime = 14;
    const result = applyTimestampAcceptance(markers, {
      id: "finishPad",
      rawTime: 12,
      source: "Manual",
      confidence: "Medium",
    });
    expect(result.accepted).toBe(true);
    expect(result.timestamps.find((marker) => marker.id === "hold10")?.rawTime).toBeNull();
    expect(result.timestamps.find((marker) => marker.id === "firstMovement")?.rawTime).toBe(5.1);
  });

  it("rejects derived markers before Start or at/after Finish", () => {
    expect(accept("hold10", 4.9).accepted).toBe(false);
    expect(accept("hold10", 15).accepted).toBe(false);
    expect(accept("finishPad", 5).accepted).toBe(false);
  });

  it("rejects timestamps outside the loaded video", () => {
    const result = applyTimestampAcceptance(populated(), {
      id: "finishPad",
      rawTime: 25,
      source: "Manual",
      confidence: "Medium",
      durationSeconds: 20,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("end of the loaded video");
  });

  it.each(["COM halfway estimate", "Hold contact detection", "Future / experimental"] as const)(
    "clears an imported legacy automatic Hold 10 marker from %s",
    (source) => {
      const markers = populated();
      const hold10 = markers.find((marker) => marker.id === "hold10")!;
      hold10.source = source;
      hold10.confidence = "High";
      const sanitized = sanitizeTimestampSequence(markers, 20);
      expect(sanitized.find((marker) => marker.id === "hold10")).toMatchObject({
        rawTime: null,
        source: "Not set",
        confidence: "None",
      });
    },
  );

  it("clearing Start also clears all dependent timing", () => {
    const result = clearMarkerTimestamp(populated(), "startSignal");
    expect(result.every((marker) => marker.rawTime === null)).toBe(true);
  });

  it("rounds accepted raw and climb times consistently", () => {
    const result = applyTimestampAcceptance(populated(), {
      id: "hold10",
      rawTime: 10.55555,
      source: "Manual",
      confidence: "Medium",
    });
    const marker = result.timestamps.find((item) => item.id === "hold10")!;
    expect(marker.rawTime).toBe(10.556);
    expect(marker.climbTime).toBe(5.556);
  });

  it("sanitizes imported markers with invalid ordering and evidence labels", () => {
    const markers = populated();
    const movement = markers.find((marker) => marker.id === "firstMovement")!;
    movement.rawTime = 4;
    movement.source = "untrusted source" as never;
    movement.confidence = "Certain" as never;
    const hold10 = markers.find((marker) => marker.id === "hold10")!;
    hold10.rawTime = 18;
    const sanitized = sanitizeTimestampSequence(markers, 20);
    expect(sanitized.find((marker) => marker.id === "firstMovement")?.rawTime).toBeNull();
    expect(sanitized.find((marker) => marker.id === "hold10")?.rawTime).toBeNull();
  });

  it("clears an imported sequence when Start is missing", () => {
    const markers = populated();
    markers.find((marker) => marker.id === "startSignal")!.rawTime = Number.NaN;
    expect(sanitizeTimestampSequence(markers).every((marker) => marker.rawTime === null)).toBe(true);
  });

  it("downgrades unknown imported evidence labels without discarding a valid time", () => {
    const markers = populated();
    const hold10 = markers.find((marker) => marker.id === "hold10")!;
    hold10.source = "mystery" as never;
    hold10.confidence = "Certain" as never;
    const sanitized = sanitizeTimestampSequence(markers);
    expect(sanitized.find((marker) => marker.id === "hold10")).toMatchObject({
      rawTime: 10,
      source: "Manual",
      confidence: "Low",
    });
  });
});

function accept(id: TimestampMarker["id"], rawTime: number) {
  return applyTimestampAcceptance(populated(), {
    id,
    rawTime,
    source: "Manual",
    confidence: "Medium",
  });
}

function populated(): TimestampMarker[] {
  return [
    marker("startSignal", "Start Signal", 5, 0),
    marker("firstMovement", "Earliest Visible Motion", 5.1, 0.1),
    marker("committedLaunch", "Committed Launch", 5.2, 0.2),
    marker("firstHold", "First Hold", 6, 1),
    marker("hold10", "Hold 10", 10, 5),
    marker("finishPad", "Finish Pad", 15, 10),
  ];
}

function marker(id: TimestampMarker["id"], label: string, rawTime: number, climbTime: number): TimestampMarker {
  return { id, label, rawTime, climbTime, source: "Manual", confidence: "Medium" };
}
