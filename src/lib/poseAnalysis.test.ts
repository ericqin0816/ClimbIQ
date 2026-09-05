import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import type { NormalizedZone, WallCalibration } from "../types";
import { buildWallCalibration } from "./wallCalibration";
import {
  buildPoseCropRaster,
  buildPoseRecoverySearchRegion,
  buildPoseSampleTimes,
  buildPoseSearchRegion,
  expandPoseSearchRegion,
  mapPoseLandmarksFromRegion,
  nextPoseInferenceTimestamp,
  poseLaneCorridorAtY,
  poseRecoveryStep,
  selectTrackedPose,
} from "./poseAnalysis";

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

const approximateLeftLaneCalibration: WallCalibration = {
  ...buildWallCalibration([
    { x: 0.16, y: 0.94 },
    { x: 0.48, y: 0.91 },
    { x: 0.42, y: 0.08 },
    { x: 0.30, y: 0.05 },
  ], 0, true),
  source: "automatic-approximate",
  confidence: "Medium",
};

const dividerAnchoredLeftLaneCalibration: WallCalibration = {
  ...buildWallCalibration([
    { x: 0.15, y: 0.94 },
    { x: 0.5, y: 0.94 },
    { x: 0.5, y: 0.06 },
    { x: 0.32, y: 0.06 },
  ], 0, true),
  source: "automatic-approximate",
  confidence: "Medium",
  reason: "Approximate left-lane geometry inferred from the upper timing lights and wall-to-mat edge.",
};

describe("pose sampling", () => {
  it("keeps recovery search regions consistent at the same elapsed time across sample rates", () => {
    for (const previousCenter of [undefined, { x: 0.5, y: 0.4 }]) {
      for (const elapsed of [0, 0.2, 0.4, 0.8, 1.2, 2, 3]) {
        const regions = [5, 10, 15].map(fps => buildPoseSearchRegion(
          calibration, startBodyZone, previousCenter,
          poseRecoveryStep(Math.round(elapsed * fps), fps),
          poseRecoveryStep(Math.round(elapsed * fps), fps),
        ));
        expect(regions[1]).toEqual(regions[0]);
        expect(regions[2]).toEqual(regions[0]);
      }
    }
  });

  it("preserves every existing 5 fps recovery step", () => {
    for (let count = 0; count < 100; count++) expect(poseRecoveryStep(count, 5)).toBe(count);
  });

  it("never samples after the requested end time", () => {
    const times = buildPoseSampleTimes(0, 0.19, 10);
    expect(Math.max(...times)).toBeLessThanOrEqual(0.19 + 1e-7);
  });

  it("keeps repeated inference timestamps strictly increasing", () => {
    const first = nextPoseInferenceTimestamp(6.46, -1);
    const retry = nextPoseInferenceTimestamp(6.46, first);
    const roundedSameNextFrame = nextPoseInferenceTimestamp(6.4604, retry);
    expect([first, retry, roundedSameNextFrame]).toEqual([6460, 6461, 6462]);
  });
});

describe("cropped pose inference", () => {
  it("builds a bounded crop canvas while preserving the source aspect ratio", () => {
    const raster = buildPoseCropRaster(1080, 1920, {
      left: 0.2,
      top: 0.25,
      right: 0.8,
      bottom: 0.75,
    });

    expect(raster.sourceX).toBeCloseTo(216);
    expect(raster.sourceY).toBeCloseTo(480);
    expect(raster.sourceWidth).toBeCloseTo(648);
    expect(raster.sourceHeight).toBeCloseTo(960);
    expect(raster.outputWidth).toBe(518);
    expect(raster.outputHeight).toBe(768);
    expect(raster.outputWidth / raster.outputHeight).toBeCloseTo(
      raster.sourceWidth / raster.sourceHeight,
      2,
    );
  });

  it("maps crop-normalized landmarks back into full-video coordinates", () => {
    const region = { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 };
    const [mapped] = mapPoseLandmarksFromRegion([
      { x: 0.2, y: 0.75, z: -0.4, visibility: 0.9 },
    ], region);

    expect(mapped.x).toBeCloseTo(0.35);
    expect(mapped.y).toBeCloseTo(0.65);
    expect(mapped.z).toBeCloseTo(-0.2);
    expect(mapped.visibility).toBe(0.9);
  });

  it("upscales a tiny top-wall crop to a detector-friendly canvas", () => {
    const raster = buildPoseCropRaster(480, 854, {
      left: 0.35,
      top: 0.08,
      right: 0.55,
      bottom: 0.26,
    });

    expect(Math.min(raster.outputWidth, raster.outputHeight)).toBeGreaterThanOrEqual(192);
    expect(Math.max(raster.outputWidth, raster.outputHeight)).toBeLessThanOrEqual(768);
    expect(raster.outputWidth / raster.outputHeight).toBeCloseTo(
      raster.sourceWidth / raster.sourceHeight,
      2,
    );
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

  it("keeps the closest very-near continuity match when the detector returns overlapping poses", () => {
    const closest = poseAt(0.51, 0.5);
    const result = selectTrackedPose(
      [poseAt(0.52, 0.5), closest],
      startBodyZone,
      { x: 0.5, y: 0.5 },
      0.1,
    );
    expect(result.selected?.landmarks).toBe(closest);
  });

  it("still rejects equally plausible people outside the tight continuity lock", () => {
    const result = selectTrackedPose(
      [poseAt(0.58, 0.5), poseAt(0.585, 0.5)],
      startBodyZone,
      { x: 0.5, y: 0.5 },
      0.1,
    );
    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("equally plausible");
  });

  it("keeps the left-lane climber instead of a nearby right-lane person after a tracking gap", () => {
    const leftClimber = poseAt(0.38, 0.24);
    const rightLanePerson = poseAt(0.54, 0.25);
    const result = selectTrackedPose(
      [rightLanePerson, leftClimber],
      startBodyZone,
      { x: 0.46, y: 0.55 },
      0.9,
      approximateLeftLaneCalibration,
    );

    expect(result.selected?.landmarks).toBe(leftClimber);
  });

  it("rejects a neighboring-lane pose even when it is the only candidate after a long gap", () => {
    const result = selectTrackedPose(
      [poseAt(0.56, 0.2)],
      startBodyZone,
      { x: 0.43, y: 0.5 },
      1.1,
      approximateLeftLaneCalibration,
    );

    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("outside the selected climbing lane");
  });

  it("does not extend an automatic lane corridor across the shared divider", () => {
    const corridor = poseLaneCorridorAtY(dividerAnchoredLeftLaneCalibration, 0.5);
    const result = selectTrackedPose(
      [poseAt(0.55, 0.5)],
      startBodyZone,
      { x: 0.43, y: 0.52 },
      1,
      dividerAnchoredLeftLaneCalibration,
      0.45,
    );

    expect(corridor.right).toBeLessThan(0.53);
    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("outside the selected climbing lane");
  });

  it("does not fall back to a lower athlete after the climber established a high-wall track", () => {
    const result = selectTrackedPose(
      [poseAt(0.42, 0.38)],
      startBodyZone,
      { x: 0.39, y: 0.18 },
      1.2,
      calibration,
      0.17,
    );

    expect(result.selected).toBeUndefined();
    expect(result.warning).toContain("rejected");
  });

  it("still permits body compression or a shoulder-to-hip anchor transition", () => {
    const sameClimber = poseAt(0.4, 0.25);
    const result = selectTrackedPose(
      [sameClimber],
      startBodyZone,
      { x: 0.39, y: 0.18 },
      0.2,
      calibration,
      0.17,
    );

    expect(result.selected?.landmarks).toBe(sameClimber);
  });

  it("follows a skewed approximate lane trapezoid with a perspective-aware margin", () => {
    const low = poseLaneCorridorAtY(approximateLeftLaneCalibration, 0.82);
    const high = poseLaneCorridorAtY(approximateLeftLaneCalibration, 0.16);

    expect(high.right - high.left).toBeLessThan(low.right - low.left);
    expect((high.left + high.right) / 2).toBeGreaterThan((low.left + low.right) / 2);
    expect(0.38).toBeGreaterThan(high.left);
    expect(0.38).toBeLessThan(high.right);
    expect(0.54).toBeGreaterThan(high.right);
  });

  it("keeps tracking with one visible shoulder and hip on the distant upper wall", () => {
    const partial = poseAt(0.4, 0.2);
    partial[12] = { ...partial[12], visibility: 0.05 };
    partial[24] = { ...partial[24], visibility: 0.05 };

    const result = selectTrackedPose(
      [partial],
      startBodyZone,
      { x: 0.41, y: 0.24 },
      0.2,
      calibration,
      0.18,
    );

    expect(result.selected?.landmarks).toBe(partial);
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
    expect(region.right - region.left).toBeLessThan(0.8);
    expect(region.bottom - region.top).toBeLessThan(0.5);
    expect(region.left).toBeLessThanOrEqual(startBodyZone.x1);
    expect(region.right).toBeGreaterThanOrEqual(startBodyZone.x2);
    expect(region.bottom).toBeGreaterThanOrEqual(startBodyZone.y2);
  });

  it("follows the previously selected climber up the wall", () => {
    const low = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.8 }, 4, 0);
    const high = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.25 }, 5, 0);
    expect((high.top + high.bottom) / 2).toBeLessThan((low.top + low.bottom) / 2);
  });

  it("uses the lane trapezoid to keep the athlete larger near the top", () => {
    const low = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.8 }, 4, 0);
    const high = buildPoseSearchRegion(calibration, startBodyZone, { x: 0.5, y: 0.25 }, 5, 0);
    expect(high.right - high.left).toBeLessThan(low.right - low.left);
    expect(high.bottom - high.top).toBeLessThan(low.bottom - low.top);
    expect(high.left).toBeLessThanOrEqual(0.5);
    expect(high.right).toBeGreaterThanOrEqual(0.5);
    expect(high.top).toBeLessThanOrEqual(0.25);
    expect(high.bottom).toBeGreaterThanOrEqual(0.25);
  });

  it("keeps short missed-frame recovery around a previously tracked high athlete", () => {
    const previousCenter = { x: 0.48, y: 0.22 };
    for (const missedFrames of [2, 3]) {
      const recovery = buildPoseSearchRegion(calibration, startBodyZone, previousCenter, 40, missedFrames);
      const centerY = (recovery.top + recovery.bottom) / 2;
      expect(centerY).toBeLessThan(0.35);
      expect(previousCenter.y).toBeGreaterThanOrEqual(recovery.top);
      expect(previousCenter.y).toBeLessThanOrEqual(recovery.bottom);
    }
  });

  it("leads an active upper-wall crop upward without losing the last anchor", () => {
    const previousCenter = { x: 0.44, y: 0.42 };
    const active = buildPoseSearchRegion(calibration, startBodyZone, previousCenter, 40, 0);
    const cropCenterY = (active.top + active.bottom) / 2;

    expect(cropCenterY).toBeLessThan(previousCenter.y);
    expect(active.top).toBeLessThanOrEqual(previousCenter.y);
    expect(active.bottom).toBeGreaterThanOrEqual(previousCenter.y);
  });

  it("biases a high-wall same-frame retry above the lower neighboring athlete", () => {
    const previousCenter = { x: 0.4, y: 0.2 };
    const active = buildPoseSearchRegion(calibration, startBodyZone, previousCenter, 60, 0);
    const recovery = buildPoseRecoverySearchRegion(active, calibration, previousCenter);
    const activeCenterY = (active.top + active.bottom) / 2;
    const recoveryCenterY = (recovery.top + recovery.bottom) / 2;

    expect(recoveryCenterY).toBeLessThan(activeCenterY);
    expect(recovery.bottom - recovery.top).toBeGreaterThan(active.bottom - active.top);
    expect(recovery.bottom).toBeLessThan(0.4);
  });

  it("never resets a repeatedly missed high-wall track to the floor", () => {
    const previousCenter = { x: 0.48, y: 0.22 };
    for (let missedFrames = 4; missedFrames <= 15; missedFrames += 1) {
      const recovery = buildPoseSearchRegion(calibration, startBodyZone, previousCenter, 40, missedFrames);
      const centerY = (recovery.top + recovery.bottom) / 2;
      expect(centerY).toBeLessThan(0.45);
      expect(recovery.top).toBeLessThan(previousCenter.y + 0.08);
      expect(recovery.left).toBeGreaterThanOrEqual(0);
      expect(recovery.top).toBeGreaterThanOrEqual(0);
      expect(recovery.right).toBeLessThanOrEqual(1);
      expect(recovery.bottom).toBeLessThanOrEqual(1);
    }
  });

  it("leaves a repeatedly missed identity crop and scans up the wall", () => {
    const initial = buildPoseSearchRegion(calibration, startBodyZone, undefined, 0, 0);
    const recovery = buildPoseSearchRegion(calibration, startBodyZone, undefined, 4, 4);
    expect((recovery.top + recovery.bottom) / 2).toBeLessThan((initial.top + initial.bottom) / 2 - 0.08);
    expect(recovery.right - recovery.left).toBeGreaterThan(initial.right - initial.left);
    expect(recovery.bottom - recovery.top).toBeGreaterThan(initial.bottom - initial.top);
  });

  it("expands an empty-frame retry crop without leaving the image", () => {
    const initial = buildPoseSearchRegion(calibration, startBodyZone);
    const recovery = expandPoseSearchRegion(initial, 1.55);
    expect(recovery.right - recovery.left).toBeGreaterThan(initial.right - initial.left);
    expect(recovery.bottom - recovery.top).toBeGreaterThan(initial.bottom - initial.top);
    expect(recovery.left).toBeGreaterThanOrEqual(0);
    expect(recovery.top).toBeGreaterThanOrEqual(0);
    expect(recovery.right).toBeLessThanOrEqual(1);
    expect(recovery.bottom).toBeLessThanOrEqual(1);
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
