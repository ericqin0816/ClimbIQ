import { describe, expect, it } from "vitest";
import { datasetToSavedSession, decodeSavedSession } from "./sessionCodec";
import { DEFAULT_ANALYSIS_SESSION_SETTINGS } from "./analysisSettings";

const region = { id: "finishIndicator", label: "Finish Indicator Review Area", x1: .7, y1: .48, x2: .82, y2: .62 };
const dataset = (zones: object) => ({ appVersion: "0.30.0", session: {}, acceptedTimestamps: [], zones });

describe("saved manual finish indicator identity", () => {
  it("round-trips a dataset region without creating a physical pad, automatic light or accepted event", () => {
    const session = datasetToSavedSession(dataset({ finishIndicatorZone: region }));
    const restored = decodeSavedSession(JSON.parse(JSON.stringify(session)));
    expect(restored?.zones).toEqual({ finishIndicator: region });
    expect(restored?.timestamps.some(marker => marker.rawTime !== null && marker.rawTime !== undefined)).toBe(false);
    expect(restored?.zones.finishPad).toBeUndefined();
    expect(restored?.zones.finishLight).toBeUndefined();
  });

  it("keeps older datasets valid with no inferred marking region", () => {
    expect(datasetToSavedSession(dataset({})).zones).toEqual({});
  });

  it("normalizes imported region labels to the manual role while preserving separate pad/light roles", () => {
    const session = decodeSavedSession({ id: "manual-indicator", version: 1, name: "Review", createdAt: "2026-10-24T08:00:00Z",
      updatedAt: "2026-10-24T08:00:00Z", settings: DEFAULT_ANALYSIS_SESSION_SETTINGS, timestamps: [],
      zones: { finishIndicator: { ...region, id: "finishLight", label: "Automatic top finish light" } } });
    expect(session?.zones).toEqual({ finishIndicator: region });
  });
});
