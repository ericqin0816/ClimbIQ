import { describe, expect, it } from "vitest";
import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  PoseLandmarkPoint,
  WallPoint,
} from "../types";
import { buildWallCalibration } from "./wallCalibration";
import { detectHoldContact, getHold10ContactMarker, type ContactHand } from "./holdContact";
import { getStandardSpeedHold } from "./standardSpeedRoute";

const calibration = buildWallCalibration([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
], 0, true);
const hold10: WallPoint = { xMeters: 1.399, yMeters: 8.334 };
const farLeft: WallPoint = { xMeters: 0.25, yMeters: 6 };

describe("hold contact detection", () => {
  it("uses actual registered neighbors rather than translating the old diagram", () => {
    const result = makeResult([1, 1.1, 1.2, 1.3].map(time => frame(time, farLeft, offset(hold10, 0.23, 0))));
    const observedRouteHolds = [
      { id: 9 as const, wall: offset(hold10, -0.5, -0.5) },
      { id: 10 as const, wall: hold10 },
      { id: 11 as const, wall: offset(hold10, 0.25, 0) },
    ];
    expect(detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" }).detected).toBe(true);
    const corrected = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10", observedRouteHolds });
    expect(corrected.detected).toBe(false);
    expect(corrected.candidates?.[0].competingHoldId).toBe(11);
    const onTarget = makeResult([1, 1.1, 1.2, 1.3].map(time => frame(time, farLeft, hold10)));
    expect(detectHoldContact(onTarget, calibration, hold10, { holdLabel: "Hold 10", observedRouteHolds }).reason).toContain("nearest registered hold");
  });

  it("refuses an explicitly supplied inconsistent registered neighborhood", () => {
    const result = makeResult([1, 1.1, 1.2, 1.3].map(time => frame(time, farLeft, hold10)));
    for (const observedRouteHolds of [
      [{ id: 10 as const, wall: hold10 }],
      [{ id: 10 as const, wall: hold10 }, { id: 10 as const, wall: hold10 }, { id: 11 as const, wall: hold10 }],
      [{ id: 9 as const, wall: hold10 }, { id: 10 as const, wall: offset(hold10, 0.3, 0) }, { id: 11 as const, wall: hold10 }],
    ]) {
      expect(detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10", observedRouteHolds })).toMatchObject({
        detected: false, confidence: "None", reason: expect.stringContaining("registered hold neighborhood"),
      });
    }
  });

  it("detects the first sustained wrist dwell and reports its hand and review window", () => {
    const result = makeResult([
      frame(0.9, farLeft, offset(hold10, -0.7, 0)),
      frame(1, farLeft, offset(hold10, -0.35, 0)),
      frame(1.1, farLeft, offset(hold10, -0.29, 0)),
      frame(1.2, farLeft, offset(hold10, -0.27, 0)),
      frame(1.3, farLeft, offset(hold10, -0.26, 0)),
      frame(1.4, farLeft, offset(hold10, 0.8, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact).toMatchObject({
      detected: true,
      confidence: "High",
      hand: "right",
    });
    expect(contact.rawTime).toBeCloseTo(0.997, 3);
    expect(contact.climbTime).toBeCloseTo(0.997, 3);
    expect(contact.distanceMeters).toBeCloseTo(0.26, 6);
    expect(contact.reviewWindow).toEqual({ startRawTime: 0.597, endRawTime: 1.597 });
    expect(contact.reason).toContain("sustained right-hand contact");
    expect(contact.evidence).toMatchObject({
      observedSamples: 4,
      requiredSamples: 3,
      confirmationSamples: 4,
      targetNearestFraction: 1,
      fingerDerivedFraction: 0,
      meanHandLandmarkCount: 1,
    });
    expect(contact.evidence!.contactScore).toBeGreaterThan(75);
    expect(contact.candidates).toHaveLength(1);
    expect(getHold10ContactMarker(result, calibration, hold10)).toMatchObject({
      id: "hold10",
      label: "Hold 10 hand contact",
      rawTime: 0.997,
      climbTime: 0.997,
    });
  });

  it("rejects a fast fly-by even when the wrist crosses directly over the hold", () => {
    const result = makeResult([
      frame(1, farLeft, offset(hold10, -0.8, 0)),
      frame(1.1, farLeft, offset(hold10, -0.35, 0)),
      frame(1.2, farLeft, offset(hold10, 0.05, 0)),
      frame(1.3, farLeft, offset(hold10, 0.45, 0)),
      frame(1.4, farLeft, offset(hold10, 0.8, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(false);
    expect(contact.reason).toContain("fast fly-by");
    expect(contact.distanceMeters).toBeCloseTo(0.05, 6);
    expect(contact.candidates?.[0]).toMatchObject({ accepted: false, hand: "right" });
    expect(contact.candidates?.[0].score).toBeGreaterThanOrEqual(0);
    expect(getHold10ContactMarker(result, calibration, hold10)).toBeNull();
  });

  it("ignores an earlier wrong-hand fly-by and selects the hand that actually dwells", () => {
    const result = makeResult([
      frame(0.7, offset(hold10, -0.8, 0), farLeft),
      frame(0.8, offset(hold10, -0.3, 0), farLeft),
      frame(0.9, offset(hold10, 0.1, 0), farLeft),
      frame(1, offset(hold10, 0.5, 0), farLeft),
      frame(1.4, farLeft, offset(hold10, 0.3, 0)),
      frame(1.5, farLeft, offset(hold10, 0.27, 0)),
      frame(1.6, farLeft, offset(hold10, 0.25, 0)),
      frame(1.7, farLeft, offset(hold10, 0.24, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.hand).toBe("right");
    expect(contact.rawTime).toBe(1.4);
  });

  it("tolerates one missing pose frame but refuses to join contact across a long gap", () => {
    const shortGap = makeResult([
      frame(1, farLeft, offset(hold10, 0.3, 0)),
      frame(1.1, farLeft, offset(hold10, 0.28, 0)),
      frame(1.2, farLeft, undefined),
      frame(1.3, farLeft, offset(hold10, 0.26, 0)),
    ]);
    const longGap = makeResult([
      frame(1, farLeft, offset(hold10, 0.3, 0)),
      frame(1.1, farLeft, offset(hold10, 0.28, 0)),
      frame(1.2, farLeft, undefined),
      frame(1.3, farLeft, undefined),
      frame(1.4, farLeft, offset(hold10, 0.26, 0)),
    ]);

    expect(detectHoldContact(shortGap, calibration, hold10).detected).toBe(true);
    const rejected = detectHoldContact(longGap, calibration, hold10);
    expect(rejected.detected).toBe(false);
    expect(rejected.reason).toContain("not sustained");
  });

  it("returns no marker without usable wrists even when COM crosses halfway", () => {
    const result = makeResult([
      frame(0, undefined, undefined, { xMeters: 1.5, yMeters: 6 }),
      frame(1, undefined, undefined, { xMeters: 1.5, yMeters: 8 }),
      frame(2, undefined, undefined, { xMeters: 1.5, yMeters: 10 }),
    ]);

    const contact = detectHoldContact(result, calibration, hold10);

    expect(contact.detected).toBe(false);
    expect(contact.reason).toContain("No usable hand tracking");
    expect(getHold10ContactMarker(result, calibration, hold10)).toBeNull();
  });

  it.each([5, 10, 15])("uses dwell time rather than a fixed frame count at %d fps", (fps) => {
    const result = makeResult(contactFrames(fps), fps);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(Math.abs(contact.rawTime! - 0.97)).toBeLessThan(0.015);
    expect(contact.evidence?.requiredSamples).toBe(Math.max(2, Math.ceil(0.14 * fps) + 1));
    expect(contact.evidence!.observedDurationSeconds).toBeGreaterThanOrEqual(0.14);
  });

  it.each([5, 10, 15])("bridges one missing wrist sample without joining a long loss at %d fps", (fps) => {
    const samples = contactFrames(fps).filter((sample) =>
      Math.abs(sample.rawTime - (1 + 1 / fps)) > 0.002,
    );
    const result = makeResult(samples, fps);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.evidence!.observationCoverage).toBeGreaterThanOrEqual(0.55);
  });

  it("uses median filtering so one bad wrist landmark cannot break a real dwell", () => {
    const result = makeResult([
      frame(0.9, farLeft, offset(hold10, 0.7, 0)),
      frame(1, farLeft, offset(hold10, 0.25, 0)),
      frame(1.1, farLeft, offset(hold10, 0.26, 0)),
      frame(1.2, farLeft, offset(hold10, 0.53, 0)),
      frame(1.3, farLeft, offset(hold10, 0.25, 0)),
      frame(1.4, farLeft, offset(hold10, 0.24, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.hand).toBe("right");
    expect(contact.evidence!.medianWristSpeedMps).toBeLessThan(0.3);
  });

  it.each(["left", "right"] as const)(
    "uses robust %s-hand fingertip landmarks when the wrist stays outside the contact area",
    (hand) => {
      const result = makeResult([
        handFrame(0.9, hand, offset(hold10, 0.62, 0), [
          offset(hold10, 0.68, 0), offset(hold10, 0.70, 0), offset(hold10, 0.72, 0),
        ]),
        handFrame(1, hand, offset(hold10, 0.62, 0), [
          offset(hold10, 0.18, 0), offset(hold10, 0.20, 0), offset(hold10, 0.22, 0),
        ]),
        handFrame(1.1, hand, offset(hold10, 0.61, 0), [
          offset(hold10, 0.17, 0), offset(hold10, 0.19, 0), offset(hold10, 0.21, 0),
        ]),
        handFrame(1.2, hand, offset(hold10, 0.60, 0), [
          offset(hold10, 0.18, 0), offset(hold10, 0.20, 0), offset(hold10, 0.22, 0),
        ]),
        handFrame(1.3, hand, offset(hold10, 0.61, 0), [
          offset(hold10, 0.17, 0), offset(hold10, 0.19, 0), offset(hold10, 0.21, 0),
        ]),
      ]);

      const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

      expect(contact).toMatchObject({ detected: true, hand });
      expect(contact.evidence).toMatchObject({
        fingerDerivedFraction: 1,
        meanHandLandmarkCount: 3,
      });
      expect(contact.distanceMeters).toBeLessThan(0.21);
    },
  );

  it("rejects one wildly misplaced fingertip while keeping the two-landmark hand cluster", () => {
    const hold9 = getStandardSpeedHold(9).wall;
    const result = makeResult([
      handFrame(1, "right", offset(hold10, 0.60, 0), [
        offset(hold10, 0.18, 0), offset(hold10, 0.20, 0), hold9,
      ]),
      handFrame(1.1, "right", offset(hold10, 0.60, 0), [
        offset(hold10, 0.17, 0), offset(hold10, 0.19, 0), hold9,
      ]),
      handFrame(1.2, "right", offset(hold10, 0.60, 0), [
        offset(hold10, 0.18, 0), offset(hold10, 0.20, 0), hold9,
      ]),
      handFrame(1.3, "right", offset(hold10, 0.60, 0), [
        offset(hold10, 0.17, 0), offset(hold10, 0.19, 0), hold9,
      ]),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.evidence).toMatchObject({
      fingerDerivedFraction: 1,
      meanHandLandmarkCount: 2,
      targetNearestFraction: 1,
    });
  });

  it("rejects a sustained wrist dwell that is actually closer to nearby Hold 9", () => {
    const hold9 = getStandardSpeedHold(9).wall;
    const distance = Math.hypot(hold9.xMeters - hold10.xMeters, hold9.yMeters - hold10.yMeters);
    const nearHold9 = {
      xMeters: hold10.xMeters + (hold9.xMeters - hold10.xMeters) * (0.37 / distance),
      yMeters: hold10.yMeters + (hold9.yMeters - hold10.yMeters) * (0.37 / distance),
    };
    const result = makeResult([
      frame(1, farLeft, nearHold9),
      frame(1.1, farLeft, nearHold9),
      frame(1.2, farLeft, nearHold9),
      frame(1.3, farLeft, nearHold9),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(false);
    expect(contact.reason).toContain("closer to Hold 9");
    expect(contact.evidence).toMatchObject({ competingHoldId: 9 });
    expect(contact.candidates?.[0]).toMatchObject({
      accepted: false,
      competingHoldId: 9,
      targetNearestFraction: 0,
      targetPlausibleFraction: 1,
    });
  });

  it("does not mistake a single-frame wrist landmark jump for contact", () => {
    const result = makeResult([
      frame(0.9, farLeft, offset(hold10, 0.8, 0)),
      frame(1, farLeft, offset(hold10, 0.18, 0)),
      frame(1.1, farLeft, offset(hold10, 0.82, 0)),
      frame(1.2, farLeft, offset(hold10, 0.8, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(false);
    expect(contact.reason).toContain("not sustained long enough");
    expect(contact.candidates?.[0]).toMatchObject({
      observedSamples: 1,
      accepted: false,
    });
  });

  it.each([5, 10, 15])("does not bridge a multi-frame tracking loss at %d fps", (fps) => {
    const episodeSamples = Math.max(1, Math.ceil(0.14 * fps));
    const firstEpisode = Array.from({ length: episodeSamples }, (_, index) =>
      frame(1 + index / fps, farLeft, offset(hold10, 0.25 - index * 0.005, 0)),
    );
    const secondStart = 1 + (episodeSamples - 1) / fps + 3 / fps;
    const secondEpisode = Array.from({ length: episodeSamples }, (_, index) =>
      frame(secondStart + index / fps, farLeft, offset(hold10, 0.24 - index * 0.005, 0)),
    );
    const result = makeResult([...firstEpisode, ...secondEpisode], fps);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(false);
    expect(contact.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it("translates nearby-hold matching with a manually corrected Hold 10 target", () => {
    const corrected = offset(hold10, 0.14, -0.08);
    const result = makeResult([
      frame(1, farLeft, offset(corrected, 0.25, 0)),
      frame(1.1, farLeft, offset(corrected, 0.24, 0)),
      frame(1.2, farLeft, offset(corrected, 0.23, 0)),
      frame(1.3, farLeft, offset(corrected, 0.22, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, corrected, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.evidence?.targetNearestFraction).toBe(1);
  });

  it("uses a wider confirmation tolerance for approximate calibration but caps confidence", () => {
    const approximate = {
      ...calibration,
      source: "automatic-approximate" as const,
      confidence: "Medium" as const,
    };
    const result = makeResult([
      frame(1, farLeft, offset(hold10, 0.41, 0)),
      frame(1.1, farLeft, offset(hold10, 0.40, 0)),
      frame(1.2, farLeft, offset(hold10, 0.39, 0)),
      frame(1.3, farLeft, offset(hold10, 0.38, 0)),
    ]);

    expect(detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" }).detected).toBe(false);
    const contact = detectHoldContact(result, approximate, hold10, { holdLabel: "Hold 10" });
    expect(contact).toMatchObject({ detected: true, confidence: "Medium" });
  });

  it("ranks overlapping left/right contact deterministically by evidence quality", () => {
    const result = makeResult([
      frame(1, offset(hold10, 0.22, 0), offset(hold10, 0.34, 0)),
      frame(1.1, offset(hold10, 0.21, 0), offset(hold10, 0.35, 0)),
      frame(1.2, offset(hold10, 0.20, 0), offset(hold10, 0.34, 0)),
      frame(1.3, offset(hold10, 0.19, 0), offset(hold10, 0.35, 0)),
    ]);

    const first = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });
    const second = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(first).toMatchObject({ detected: true, hand: "left" });
    expect(second.hand).toBe(first.hand);
    expect(second.rawTime).toBe(first.rawTime);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates!.find((candidate) => candidate.hand === "left")!.score)
      .toBeGreaterThan(first.candidates!.find((candidate) => candidate.hand === "right")!.score);
  });

  it("refines contact onset between frames instead of returning broad proximity entry", () => {
    const result = makeResult([
      frame(0.8, farLeft, offset(hold10, 0.8, 0)),
      frame(0.9, farLeft, offset(hold10, 0.52, 0)),
      frame(1, farLeft, offset(hold10, 0.32, 0)),
      frame(1.1, farLeft, offset(hold10, 0.25, 0)),
      frame(1.2, farLeft, offset(hold10, 0.24, 0)),
      frame(1.3, farLeft, offset(hold10, 0.24, 0)),
    ]);

    const contact = detectHoldContact(result, calibration, hold10, { holdLabel: "Hold 10" });

    expect(contact.detected).toBe(true);
    expect(contact.rawTime).toBeCloseTo(0.995, 3);
    expect(contact.rawTime).toBeGreaterThan(0.9);
    expect(contact.rawTime).toBeLessThan(1);
    expect(contact.evidence!.onsetRefinementSeconds).toBeCloseTo(0.005, 3);
  });
});

function frame(
  rawTime: number,
  left?: WallPoint,
  right?: WallPoint,
  com?: WallPoint,
): BiomechanicsFrame {
  const landmarks: PoseLandmarkPoint[] = [];
  if (left) landmarks.push(landmark(15, left));
  if (right) landmarks.push(landmark(16, right));
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: landmarks.length > 0,
    poseSelected: landmarks.length > 0,
    poseCandidateCount: landmarks.length ? 1 : 0,
    landmarks,
    wallCom: com,
    smoothedWallCom: com,
    massCoverage: landmarks.length ? 0.9 : 0,
    meanVisibility: landmarks.length ? 0.95 : 0,
    valid: landmarks.length > 0,
  };
}

function handFrame(
  rawTime: number,
  hand: ContactHand,
  wrist: WallPoint,
  fingers: [WallPoint, WallPoint, WallPoint],
): BiomechanicsFrame {
  const handIndices = hand === "left"
    ? { wrist: 15, fingers: [17, 19, 21] }
    : { wrist: 16, fingers: [18, 20, 22] };
  const otherWrist = hand === "left" ? 16 : 15;
  const landmarks = [
    landmark(otherWrist, farLeft),
    landmark(handIndices.wrist, wrist),
    ...fingers.map((point, index) => landmark(handIndices.fingers[index], point)),
  ];
  return {
    rawTime,
    climbTime: rawTime,
    poseDetected: true,
    poseSelected: true,
    poseCandidateCount: 1,
    landmarks,
    massCoverage: 0.9,
    meanVisibility: 0.95,
    valid: true,
  };
}

function landmark(index: number, wall: WallPoint): PoseLandmarkPoint {
  return {
    index,
    x: wall.xMeters / 3,
    y: 1 - wall.yMeters / 15,
    z: 0,
    visibility: 0.95,
  };
}

function offset(point: WallPoint, xMeters: number, yMeters: number): WallPoint {
  return { xMeters: point.xMeters + xMeters, yMeters: point.yMeters + yMeters };
}

function contactFrames(fps: number): BiomechanicsFrame[] {
  const samples: BiomechanicsFrame[] = [];
  const interval = 1 / fps;
  for (let time = 0.6; time <= 1.6 + 1e-9; time += interval) {
    const rawTime = Math.round(time * 1_000_000) / 1_000_000;
    const distance = rawTime < 0.8
      ? 0.8
      : rawTime < 1
        ? 0.38 + (1 - rawTime) * 1.4
        : 0.24;
    samples.push(frame(rawTime, farLeft, offset(hold10, distance, 0)));
  }
  return samples;
}

function makeResult(frames: BiomechanicsFrame[], sampleFps = 10): BiomechanicsResult {
  const endRawTime = Math.max(2, ...frames.map((sample) => sample.rawTime));
  return {
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime: 0,
    endRawTime,
    settings: {
      sampleFps,
      minVisibility: 0.35,
      minMassCoverage: 0.8,
      smoothingWindowSeconds: 0.2,
      anthropometricModel: "athletevision-published-male-reference",
    },
    frames,
    metrics: {
      requestedFrames: frames.length,
      detectedFrames: frames.filter((sample) => sample.poseDetected).length,
      selectedFrames: frames.filter((sample) => sample.poseSelected).length,
      validFrames: frames.filter((sample) => sample.valid).length,
      detectionCoverage: 1,
      trackingCoverage: 1,
      validCoverage: 1,
      meanMassCoverage: 0.9,
      quality: "High",
    },
    warnings: [],
  };
}
