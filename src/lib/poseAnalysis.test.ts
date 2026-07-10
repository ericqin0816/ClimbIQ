import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import type { NormalizedZone } from "../types";
import { buildWallCalibration } from "./wallCalibration";
import { buildPoseSampleTimes, buildPoseSearchRegion, selectTrackedPose } from "./poseAnalysis";

const calibration = buildWallCalibration([
  { x: 0.25, y: 0.95 },
  { x: 0.75, y: 0.95 },
  { x: 0.68, y: 0.05 },
  { x: 0.32, y: 0.05 },
], 0, true);

const startBodyZone: NormalizedZone = {
  id: "startBody",
  label: "Start Body Zone",
  x1: 0.35,
  y1: 0.68,
  x2: 0.65,
  y2: 0.96,
};

describe("pose sampling", () => {
  it("never samples after the requested end time", () => {
    const times = buildPoseSampleTimes(0, 0.19, 10);
    expect(Math.max(...times)).toBeLessThanOrEqual(0.19 + 1e-7);
  });
});

describe("climber identity selection", () => {
  it("accepts the only person on the initial frame even when the body zone is tight", () => {
    const onlyPose = poseAt(0.5, 0.55);
    const result = selectTrackedPose([onlyPose], startBodyZone);
    expect(result.selected?.landmarks).toBe(onlyPose);
  });

  it("uses the Start Body Zone to choose between multiple people", () => {
    const climber = poseAt(0.5, 0.82);
    const official = poseAt(0.9, 0.82);
    const result = selectTrackedPose([official, climber], startBodyZone);
    expect(result.selected?.landmarks).toBe(climber);
  });

  it("does not silently switch to a far-away person after tracking begins", () => {
    const result = selectTrackedPose([poseAt(0.85, 0.3)], startBodyZone, { x: 0.3, y: 0.3 }, 0.1);
    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("rejected");
  });

  it("rejects two equally plausible continuity matches", () => {
    const result = selectTrackedPose(
      [poseAt(0.51, 0.5), poseAt(0.52, 0.5)],
      startBodyZone,
      { x: 0.5, y: 0.5 },
      0.1,
    );
    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("equally plausible");
  });
});

describe("moving pose search region", () => {
  it("starts around the body zone and always stays inside the image", () => {
    const region = buildPoseSearchRegion(calibration, startBodyZone);
    expect(region.left).toBeLessThan(0.5);
    expect(region.right).toBeGreaterThan(0.5);
    expect(region.top).toBeLessThan(0.82);
    expect(region.bottom).toBeGreaterThan(0.82);
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.right).toBeLessThanOrEqual(1);
    expect(region.bottom).toBeLessThanOrEqual(1);
  });

  it("follows the previously selected climber up the wall", () => {
    const low = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.8 }, 4, 0);
    const high = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.25 }, 5, 0);
    expect((high.top + high.bottom) / 2).toBeLessThan((low.top + low.bottom) / 2);
  });
});

function poseAt(x: number, y: number): NormalizedLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({
    x,
    y,
    z: 0,
    visibility: 1,
  })) as NormalizedLandmark[];
  landmarks[23] = { x: x - 0.02, y, z: 0, visibility: 1 };
  landmarks[24] = { x: x + 0.02, y, z: 0, visibility: 1 };
  return landmarks;
}
