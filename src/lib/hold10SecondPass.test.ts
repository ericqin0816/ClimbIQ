import { describe, expect, it } from "vitest";
import type { BiomechanicsResult } from "../types";
import { buildWallCalibration } from "./wallCalibration";
import { resolveHold10Target } from "./holdTarget";
import { getStandardSpeedHold } from "./standardSpeedRoute";
import { planHold10SecondPass, assessHold10SecondPass } from "./hold10SecondPass";
import { validatePoseTrackingSeed } from "./poseAnalysis";
import { DEFAULT_BIOMECHANICS_SETTINGS } from "./biomechanics";

const calibration = buildWallCalibration([{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }], 0, true);
const target = resolveHold10Target({ calibration });
const height = getStandardSpeedHold(10).wall.yMeters;

describe("Hold 10 second-pass planning and evidence", () => {
  it("uses the same seed before and after compact storage removes hips", () => {
    const full = trajectory(5);
    for (const frame of full.frames) frame.landmarks.filter(l => l.index >= 23).forEach(l => { l.x = 0.57; l.y = 0.65; });
    const compact = { ...full, frames: full.frames.map(f => ({ ...f, landmarks: f.landmarks.filter(l => l.index < 23) })) };
    expect(planHold10SecondPass(full, calibration, target, 8)).toEqual(planHold10SecondPass(compact, calibration, target, 8));
  });
  it("uses a nearby selected athlete and confines the scan to a small window", () => {
    const broad = trajectory(5);
    const plan = planHold10SecondPass(broad, calibration, target, 8)!;
    expect(plan).toBeDefined();
    expect(plan.coarseRawTime).toBeCloseTo(5, 2);
    expect(plan.startRawTime).toBeGreaterThanOrEqual(broad.startRawTime);
    expect(plan.endRawTime).toBeLessThanOrEqual(broad.endRawTime);
    expect(plan.endRawTime - plan.startRawTime).toBeLessThanOrEqual(2.2);
    expect(plan.seed.rawTime).toBe(plan.startRawTime);
  });

  it("does not seed a second pass from an untracked gap", () => {
    const broad = trajectory(5);
    broad.frames = broad.frames.filter(f => f.rawTime < 3.8 || f.rawTime > 4.5);
    expect(planHold10SecondPass(broad, calibration, target, 8)).toBeUndefined();
  });

  it("finds a gradual crossing at high sample rates without inventing contact", () => {
    const broad = trajectory(5);
    const plan = planHold10SecondPass(broad, calibration, target, 8)!;
    const dense = trajectory(15, 5.06, plan.startRawTime, plan.endRawTime);
    const evidence = assessHold10SecondPass(plan, dense, calibration, target);
    expect(evidence.refined).toBe(true);
    expect(evidence.kind).toBe("height-passage");
    expect(evidence.candidateRawTime).toBeCloseTo(5.06, 2);
    expect(evidence.sampleBracket!.endRawTime - evidence.sampleBracket!.startRawTime).toBeLessThanOrEqual(0.068);
    expect(evidence.requiresReview).toBe(true);
  });

  it("retains the original cursor when the denser scan disagrees substantially", () => {
    const plan = planHold10SecondPass(trajectory(5), calibration, target, 8)!;
    const evidence = assessHold10SecondPass(plan, trajectory(15, 5.6, plan.startRawTime, plan.endRawTime), calibration, target);
    expect(evidence.refined).toBe(false);
    expect(evidence.kind).toBe("inconclusive");
    expect(evidence.candidateRawTime).toBe(plan.coarseRawTime);
    expect(evidence.reason).toContain("disagreed with the broad cursor");
  });

  it("does not interpolate through missing detailed hand observations", () => {
    const plan = planHold10SecondPass(trajectory(5), calibration, target, 8)!;
    const dense = trajectory(15, 5, plan.startRawTime, plan.endRawTime);
    dense.frames = dense.frames.filter(f => f.rawTime < 4.8 || f.rawTime > 5.2);
    expect(assessHold10SecondPass(plan, dense, calibration, target).kind).toBe("inconclusive");
  });

  it("distinguishes sustained proximity to a known hold from a height crossing", () => {
    const knownTarget = resolveHold10Target({ calibration, manualZone: { x1: 0.49, x2: 0.51, y1: 1-height/15-0.01, y2: 1-height/15+0.01 } });
    const plan = planHold10SecondPass(trajectory(5), calibration, target, 8)!;
    const dense = trajectory(15, 5, plan.startRawTime, plan.endRawTime);
    for (const frame of dense.frames) {
      if (frame.rawTime >= 4.95 && frame.rawTime <= 5.4) {
        frame.landmarks.filter(l => [16,18,20,22].includes(l.index)).forEach(l => { l.y = 1-height/15; });
      }
    }
    const evidence = assessHold10SecondPass(plan, dense, calibration, knownTarget);
    expect(evidence.kind).toBe("contact-candidate");
    expect(evidence.requiresReview).toBe(true);
  });

  it("rejects stale, future, and off-frame tracking seeds", () => {
    for (const seed of [
      {rawTime: 3,center:{x:0.5,y:0.5}},
      {rawTime: 5,center:{x:0.5,y:0.5}},
      {rawTime: 4,center:{x:-1,y:0.5}},
    ]) expect(validatePoseTrackingSeed(seed, 4, calibration)).toBeUndefined();
    expect(validatePoseTrackingSeed({ rawTime: 3.9, center: {x:0.5,y:0.5} }, 4, calibration)).toBeDefined();
  });
});

function trajectory(fps: number, crossing = 5, start = 2, end = 8): BiomechanicsResult {
  const frames = Array.from({ length: Math.floor((end-start)*fps)+1 }, (_, i) => {
    const rawTime = start + i/fps;
    const handY = 1 - (height + (rawTime-crossing)*2) / 15;
    return { rawTime, climbTime: rawTime-start, poseDetected: true, poseSelected: true,
      landmarks: [16,18,20,22,23,24].map(index => ({index,x:0.5,y:index>=23 ? 0.6 : handY,z:0,visibility:0.95})),
      imageCom: {x:0.5,y:0.6}, massCoverage: 1, meanVisibility: 0.95, valid: true };
  });
  return { version:1,createdAt:"2026-09-05",method:"MediaPipe Pose Landmarker",model:"Pose Landmarker Full",modelVersion:"float16/1",
    coordinateSystem:"calibrated-wall-plane",startRawTime:start,endRawTime:end,settings:{...DEFAULT_BIOMECHANICS_SETTINGS,sampleFps:fps},frames,
    metrics:{requestedFrames:frames.length,detectedFrames:frames.length,validFrames:frames.length,trackingCoverage:1,validCoverage:1,meanMassCoverage:1,quality:"High"},warnings:[] };
}
