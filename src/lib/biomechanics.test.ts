import { describe, expect, it } from "vitest";
import type { BiomechanicsFrame, PoseLandmarkPoint } from "../types";
import {
  applyTrajectoryKinematics,
  BODY_SEGMENTS,
  computeImageCom,
  computeWallCom,
  DEFAULT_BIOMECHANICS_SETTINGS,
  REPEATED_COM_FRAME_WARNING,
  isTrajectoryFrameExcluded,
  buildMetricChunks,
} from "./biomechanics";
import { buildWallCalibration, validateWallCalibration } from "./wallCalibration";

const calibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);

describe("weighted COM", () => {
  it("defaults phone-video tracking to the benchmarked 5 fps rate", () => {
    expect(DEFAULT_BIOMECHANICS_SETTINGS.sampleFps).toBe(5);
  });

  it("uses segment masses that sum to one", () => {
    expect(BODY_SEGMENTS.reduce((sum, segment) => sum + segment.mass, 0)).toBeCloseTo(1, 12);
  });

  it("keeps a symmetric pose centered and projects joints before COM", () => {
    const pose = symmetricPose();
    const image = computeImageCom(pose);
    const matrix = validateWallCalibration(calibration).matrix!;
    const wall = computeWallCom(pose, matrix);

    expect(image.point?.x).toBeCloseTo(0.5, 10);
    expect(wall.point?.xMeters).toBeCloseTo(1.5, 10);
    expect(image.massCoverage).toBeCloseTo(1, 10);
    expect(wall.massCoverage).toBeCloseTo(1, 10);
  });

  it("refuses COM when the required trunk anchor is missing", () => {
    const pose = symmetricPose().map((landmark) =>
      landmark.index === 24 ? { ...landmark, visibility: 0 } : landmark,
    );
    const result = computeImageCom(pose);

    expect(result.point).toBeUndefined();
    expect(result.missingSegments).toContain("trunk");
    expect(result.missingSegments).toContain("rightThigh");
  });

  it("tolerates one occluded thigh when at least 80% of modeled mass remains", () => {
    const pose = symmetricPose().map((landmark) =>
      landmark.index === 26 ? { ...landmark, visibility: 0 } : landmark,
    );
    const result = computeImageCom(pose);

    expect(result.point).toBeDefined();
    expect(result.massCoverage).toBeGreaterThanOrEqual(0.8);
    expect(result.missingSegments).toContain("rightThigh");
  });
});

describe("trajectory kinematics", () => {
  it("does not erase continuous speed when native intervals straddle the requested smoothing window", () => {
    const native=[0,.173333,.38,.586667,.793333];
    const frames=native.map((time,index)=>({...frame(index*.2,1.5,1+time),decodedFrameRawTime:time,sourceFrameDurationSeconds:.035}));
    const result=applyTrajectoryKinematics(frames,DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    result.frames.forEach(sample=>expect(sample.speedMps).toBeCloseTo(1,6));
    expect(buildMetricChunks(result.frames,true)).toHaveLength(1);
  });
  it("fits actual source-frame timing without shifting the saved seek cursors", () => {
    const times = [0, .08, .19, .28, .4];
    const frames = times.map((time, index) => ({ ...frame(time + [0,.03,.01,.02,0][index], 1.5, 1 + 2*time),
      decodedFrameRawTime: time, sourceFrameDurationSeconds: .04 }));
    const result = applyTrajectoryKinematics(frames, {...DEFAULT_BIOMECHANICS_SETTINGS,smoothingWindowSeconds:.3},calibration);
    expect(result.frames.map(sample => sample.rawTime)).toEqual(frames.map(sample => Math.round(sample.rawTime * 1000) / 1000));
    result.frames.forEach(sample => expect(sample.speedMps).toBeCloseTo(2,6));
    expect(result.metrics.averageSpeedMps).toBeCloseTo(2,6);
    const cursorOnly = applyTrajectoryKinematics(frames.map(sample=>({...sample,decodedFrameRawTime:undefined})),
      {...DEFAULT_BIOMECHANICS_SETTINGS,smoothingWindowSeconds:.3},calibration);
    expect(cursorOnly.frames.some(sample=>Math.abs((sample.speedMps ?? 2)-2)>.05)).toBe(true);
  });

  it("does not turn repeated seeks into extra COM evidence or fake high-rate peak speed", () => {
    const frames = Array.from({length:9},(_,index) => {
      const source = Math.floor(index/3)*.2;
      return {...frame(index/15,1.5,1+2*source),decodedFrameRawTime:source,sourceFrameDurationSeconds:.2};
    });
    const result=applyTrajectoryKinematics(frames,{...DEFAULT_BIOMECHANICS_SETTINGS,sampleFps:15,smoothingWindowSeconds:.3},calibration);
    expect(result.frames).toHaveLength(9);
    expect(result.frames.filter(sample=>sample.warning?.includes(REPEATED_COM_FRAME_WARNING))).toHaveLength(6);
    expect(result.metrics.validFrames).toBe(3);
    expect(result.metrics.validCoverage).toBeCloseTo(1/3);
    expect(result.metrics.averageSpeedMps).toBeCloseTo(2,6);
    expect(result.metrics.peakSpeedMps).toBeUndefined();
    result.frames.filter(isTrajectoryFrameExcluded).forEach(sample=>expect(sample.speedMps).toBeUndefined());
    expect(applyTrajectoryKinematics(result.frames,{...DEFAULT_BIOMECHANICS_SETTINGS,sampleFps:15,smoothingWindowSeconds:.3},calibration).metrics).toEqual(result.metrics);
  });

  it("prefers a usable duplicate over an invalid high-mass inference", () => {
    const first={...frame(.01,1.5,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.2,valid:false,massCoverage:1};
    const second={...frame(.08,1.5,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.2,massCoverage:.8};
    const result=applyTrajectoryKinematics([first,second],DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    expect(isTrajectoryFrameExcluded(result.frames[0])).toBe(true);
    expect(isTrajectoryFrameExcluded(result.frames[1])).toBe(false);
    expect(result.metrics.validFrames).toBe(1);
  });

  it("uses source time when deciding whether a tracking gap can be bridged", () => {
    const frames=[{...frame(.03,1,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.04},
      {...frame(.27,1,1.27),decodedFrameRawTime:.27,sourceFrameDurationSeconds:.04}];
    const result=applyTrajectoryKinematics(frames,DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    expect(result.metrics.pathLengthMeters).toBeUndefined();
  });

  it("rejects non-increasing mixed source times without manufacturing infinite speed", () => {
    const frames=[frame(.10,1.5,1),{...frame(.11,1.5,1.1),decodedFrameRawTime:.09,sourceFrameDurationSeconds:.04},frame(.2,1.5,1.2)];
    const result=applyTrajectoryKinematics(frames,DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    expect(result.frames[1].warning).toContain("Non-increasing source-frame time");
    expect(result.frames[1].speedMps).toBeUndefined();
    expect(result.metrics.validFrames).toBe(2);
  });

  it("does not choose an extrapolated high-mass duplicate over an in-wall measurement", () => {
    const frames=[{...frame(.01,5,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.2},
      {...frame(.08,1.5,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.2,massCoverage:.8}];
    const result=applyTrajectoryKinematics(frames,DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    expect(result.metrics.validFrames).toBe(1);
    expect(result.frames[1].smoothedWallCom).toBeDefined();
  });

  it("falls back safely on invalid imported source metadata", () => {
    const frames=[0,.1,.2,.3].map(time=>({...frame(time,1.5,1+time),decodedFrameRawTime:time+20}));
    const result=applyTrajectoryKinematics(frames,DEFAULT_BIOMECHANICS_SETTINGS,calibration);
    expect(result.metrics.averageSpeedMps).toBeCloseTo(1,6);
  });

  it("shares source gaps and duplicate handling with path and speed charts", () => {
    const samples=[{...frame(.03,1,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.1,smoothedWallCom:{xMeters:1,yMeters:1},speedMps:1},
      {...frame(.06,1,1),decodedFrameRawTime:0,sourceFrameDurationSeconds:.1,warning:REPEATED_COM_FRAME_WARNING},
      {...frame(.27,1,1.27),decodedFrameRawTime:.27,sourceFrameDurationSeconds:.1,smoothedWallCom:{xMeters:1,yMeters:1.27},speedMps:1}];
    expect(buildMetricChunks(samples).map(chunk=>chunk.length)).toEqual([1,1]);
    expect(buildMetricChunks(samples,true).map(chunk=>chunk.length)).toEqual([1,1]);
    samples[2].decodedFrameRawTime=.2;
    expect(buildMetricChunks(samples,true).map(chunk=>chunk.length)).toEqual([2]);
  });

  it("returns zero speed for a stationary COM", () => {
    const frames = [0, 0.1, 0.2, 0.3].map((time) => frame(time, 1.5, 2));
    const result = applyTrajectoryKinematics(frames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);

    result.frames.forEach((sample) => expect(sample.speedMps ?? 0).toBeCloseTo(0, 8));
    expect(result.metrics.pathLengthMeters).toBeUndefined();
  });

  it("preserves constant velocity with irregular timestamps", () => {
    const settings = { ...DEFAULT_BIOMECHANICS_SETTINGS, smoothingWindowSeconds: 0.3 };
    const frames = [0, 0.07, 0.18, 0.31, 0.48].map((time) => frame(time, 1.5, 2 * time));
    const result = applyTrajectoryKinematics(frames, settings, calibration);

    result.frames.forEach((sample) => expect(sample.speedMps).toBeCloseTo(2, 6));
    expect(result.metrics.averageSpeedMps).toBeCloseTo(2, 6);
  });

  it("does not bridge gaps longer than a quarter second", () => {
    const settings = { ...DEFAULT_BIOMECHANICS_SETTINGS, smoothingWindowSeconds: 0.2 };
    const frames = [0, 0.1, 0.5, 0.6].map((time) => frame(time, 1.5, time));
    const result = applyTrajectoryKinematics(frames, settings, calibration);

    expect(result.metrics.pathLengthMeters).toBeCloseTo(0.2, 6);
    expect(result.metrics.averageSpeedMps).toBeCloseTo(1, 6);
  });

  it("rejects an implausible in-wall raw jump before smoothing or path metrics", () => {
    const frames = [
      frame(0, 1, 1),
      frame(0.1, 1.1, 1.1),
      frame(0.2, 2.5, 5),
      frame(0.3, 1.2, 1.2),
      frame(0.4, 1.3, 1.3),
    ];
    const result = applyTrajectoryKinematics(frames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);
    const rejected = result.frames.find((sample) => sample.rawTime === 0.2)!;

    expect(rejected.warning).toContain("Implausible raw wall-plane displacement");
    expect(rejected.smoothedWallCom).toBeUndefined();
    expect(rejected.speedMps).toBeUndefined();
    expect(result.metrics.validFrames).toBe(4);
    expect(result.metrics.pathLengthMeters).toBeCloseTo(Math.hypot(0.1, 0.1) * 2, 6);
    expect(result.metrics.averageSpeedMps).toBeCloseTo(Math.SQRT2, 6);
    expect(result.warnings.some((warning) => warning.includes("excluded before smoothing"))).toBe(true);
  });

  it("uses extrapolated frames as hard path boundaries", () => {
    const frames = [
      frame(0, 1, 1),
      frame(0.1, 1.1, 1.1),
      frame(0.2, 3.5, 5),
      frame(0.3, 1.2, 1.2),
      frame(0.4, 1.3, 1.3),
    ];
    const result = applyTrajectoryKinematics(frames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);
    const rejected = result.frames.find((sample) => sample.rawTime === 0.2)!;

    expect(rejected.extrapolated).toBe(true);
    expect(rejected.smoothedWallCom).toBeUndefined();
    expect(result.metrics.validFrames).toBe(4);
    expect(result.metrics.pathLengthMeters).toBeCloseTo(Math.hypot(0.1, 0.1) * 2, 6);
    expect(result.metrics.averageSpeedMps).toBeCloseTo(Math.SQRT2, 6);
  });

  it("separates raw person detection from safely selected climber tracking", () => {
    const frames = [0, 0.1, 0.2].map((time) => ({
      ...frame(time, 1.5, time),
      poseDetected: true,
      poseSelected: false,
      poseCandidateCount: 1,
      landmarks: [],
      imageCom: undefined,
      wallCom: undefined,
      valid: false,
    }));
    const result = applyTrajectoryKinematics(frames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);

    expect(result.metrics.detectionCoverage).toBe(1);
    expect(result.metrics.trackingCoverage).toBe(0);
    expect(result.metrics.detectedFrames).toBe(3);
    expect(result.metrics.selectedFrames).toBe(0);
  });

  it("clears stale derived kinematics before recomputing invalid frames", () => {
    const initial = [0, 0.1, 0.2].map((time) => frame(time, 1.5, 2 * time));
    const firstPass = applyTrajectoryKinematics(initial, DEFAULT_BIOMECHANICS_SETTINGS, calibration);
    const invalidated = firstPass.frames.map((sample) => ({ ...sample, valid: false }));
    const secondPass = applyTrajectoryKinematics(invalidated, DEFAULT_BIOMECHANICS_SETTINGS, calibration);

    secondPass.frames.forEach((sample) => {
      expect(sample.smoothedWallCom).toBeUndefined();
      expect(sample.velocityXMps).toBeUndefined();
      expect(sample.velocityYMps).toBeUndefined();
      expect(sample.verticalSpeedMps).toBeUndefined();
      expect(sample.speedMps).toBeUndefined();
    });
    expect(secondPass.metrics.validFrames).toBe(0);
    expect(secondPass.metrics.peakSpeedMps).toBeUndefined();
  });

  it("rebuilds derived warnings without duplicating them", () => {
    const sourceWarning = "Detector supplied this note.";
    const fastOutsideFrames = [0, 0.1, 0.2].map((time) => ({
      ...frame(time, 4, 2 + 20 * time),
      warning: sourceWarning,
    }));
    const firstPass = applyTrajectoryKinematics(fastOutsideFrames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);
    const secondPass = applyTrajectoryKinematics(firstPass.frames, DEFAULT_BIOMECHANICS_SETTINGS, calibration);

    for (const sample of secondPass.frames) {
      expect(countOccurrences(sample.warning, sourceWarning)).toBe(1);
      expect(countOccurrences(sample.warning, "COM lies outside the calibrated wall quadrilateral.")).toBe(1);
      expect(countOccurrences(sample.warning, "Implausible wall-plane speed; review pose and calibration.")).toBe(0);
      expect(sample.smoothedWallCom).toBeUndefined();
      expect(sample.speedMps).toBeUndefined();
    }
    expect(secondPass.metrics.pathLengthMeters).toBeUndefined();
    expect(secondPass.warnings.some((warning) => warning.includes("outside the calibrated wall"))).toBe(true);
  });

  it("labels automatic wall scale as approximate and caps reported quality", () => {
    const automaticCalibration = {
      ...calibration,
      source: "automatic-approximate" as const,
      confidence: "Medium" as const,
      reason: "Approximate left-lane geometry inferred from frame evidence.",
    };
    const frames = Array.from({ length: 10 }, (_, index) => frame(index / 10, 1.5, 1 + index * 0.2));
    const result = applyTrajectoryKinematics(frames, DEFAULT_BIOMECHANICS_SETTINGS, automaticCalibration);

    expect(result.metrics.quality).toBe("Medium");
    expect(result.warnings.some((warning) => warning.includes("inferred automatically") && warning.includes("approximate"))).toBe(true);
  });
});

function symmetricPose(): PoseLandmarkPoint[] {
  const points: Array<[number, number, number]> = [
    [0, 0.5, 0.1],
    [11, 0.4, 0.22], [12, 0.6, 0.22],
    [13, 0.34, 0.36], [14, 0.66, 0.36],
    [15, 0.3, 0.5], [16, 0.7, 0.5],
    [23, 0.45, 0.5], [24, 0.55, 0.5],
    [25, 0.44, 0.7], [26, 0.56, 0.7],
    [27, 0.44, 0.88], [28, 0.56, 0.88],
    [29, 0.43, 0.9], [30, 0.57, 0.9],
    [31, 0.42, 0.95], [32, 0.58, 0.95],
  ];
  return points.map(([index, x, y]) => ({ index, x, y, z: 0, visibility: 1 }));
}

function frame(rawTime: number, xMeters: number, yMeters: number): BiomechanicsFrame {
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    landmarks: [],
    imageCom: { x: xMeters / 3, y: 1 - yMeters / 15 },
    wallCom: { xMeters, yMeters },
    massCoverage: 0.95,
    meanVisibility: 0.95,
    valid: true,
  };
}

function countOccurrences(value: string | undefined, expected: string): number {
  return value?.split(expected).length ? value.split(expected).length - 1 : 0;
}
