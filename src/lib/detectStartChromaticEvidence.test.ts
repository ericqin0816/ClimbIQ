import { describe, expect, it, vi } from "vitest";
import type { RGB, StartSignalDebug } from "../types";
import fixture from "./__fixtures__/startChromaticEvidence.json";
import { detectStartSignal, findVerifiedGreenDeparture, type RequiredCalibration } from "./detectStartSignal";
import { computeColorDistance } from "./videoFrameSampler";

const native = vi.hoisted(() => ({ samples: [] as Array<{ time: number; averageRgb: RGB; duration: number }> }));

vi.mock("./sourceFrameScan", () => ({
  scanSourceFrames: vi.fn(async ({ onFrame }: Parameters<typeof import("./sourceFrameScan").scanSourceFrames>[0]) => {
    for (const sample of native.samples) {
      await onFrame({ rawTime: sample.time, cursorTime: sample.time + .001,
        decoded: { mediaTime: sample.time, cursorTime: sample.time + .001, durationSeconds: sample.duration,
          source: "recorded-native-samples", method: "video-frame" } });
    }
    return { observations: native.samples.length, nativeFrames: native.samples.length,
      duplicateFramesSkipped: 0, usedDurationSteps: native.samples.length, isAccuracyBound: false };
  }),
}));

vi.mock("./videoFrameSampler", async importOriginal => {
  const actual = await importOriginal<typeof import("./videoFrameSampler")>();
  return { ...actual, sampleZoneOpponentColor: vi.fn(async (_video: HTMLVideoElement, time: number) => {
    const sample = native.samples.find(value => Math.abs(value.time + .001 - time) < 1e-7);
    if (!sample) throw new Error(`Unexpected recorded-sample cursor ${time}`);
    return { time, averageRgb: sample.averageRgb, pixelZone: { x: 0, y: 0, width: 1, height: 1 } };
  }) };
});

function capturedSamples(row: typeof fixture.rows[number]): StartSignalDebug["samples"] {
  return row.samples.map(([time, r, g, b, distanceToBefore, distanceToAfter, duration]) => ({
    time, averageRgb: { r, g, b }, distanceToBefore, distanceToAfter, colorDistance: distanceToBefore,
    timestampMethod: "video-frame", sourceFrameDurationSeconds: duration,
    greenScore: g - Math.max(r, b), blueScore: b - Math.max(r, g),
  }));
}

describe("native development RGB/PTS regression controls (not event labels)", () => {
  it.each(fixture.rows)("checks recorded behavior and before-state evidence for $id lane $laneIndex", row => {
    const samples = capturedSamples(row);
    const legacy = findVerifiedGreenDeparture(samples, row.calibration, 2, false, 2 / 30);
    const guarded = findVerifiedGreenDeparture(samples, row.calibration, 2, true, 2 / 30);
    if (row.id === "IMG_9076") expect(legacy).toBeUndefined();
    else expect(legacy).toMatchObject(row.legacy);
    // The fixture's guarded field preserves Cycle2 outputs, including the
    // subsequently inspected moving-shoe proposal. It is not ground truth.
    if (["IMG_9075", "IMG_9076"].includes(row.id)) expect(guarded).toBeUndefined();
    else {
      expect(guarded).toMatchObject(row.guarded);
      expect(samples[guarded!.onsetIndex].timestampMethod).toBe("video-frame");
    }
  });

  it("rejects the inspected moving-shoe proposal instead of treating distant brown frames as stable green", () => {
    const row = fixture.rows.find(value => value.id === "IMG_9075")!;
    const samples = capturedSamples(row);
    const legacy = findVerifiedGreenDeparture(samples, row.calibration, 2, false, 2 / 30)!;
    expect(samples[legacy.onsetIndex].time).toBe(8.435);
    expect(samples[legacy.confirmationIndex].time).toBe(8.735);
    expect(legacy.confirmationFrames).toBe(23);
    const brown = samples[legacy.confirmationIndex].averageRgb;
    expect(brown.b - brown.g).toBe(-23);
    expect(brown.b - brown.g).toBeLessThan(row.calibration.beforeStartRGB.b - row.calibration.beforeStartRGB.g);

    expect(samples[row.guarded.onsetIndex].time).toBe(8.835);
    for (const previous of samples.slice(row.guarded.onsetIndex - 2, row.guarded.onsetIndex)) {
      expect(previous.distanceToBefore!).toBeGreaterThan(previous.distanceToAfter!);
    }
    expect(findVerifiedGreenDeparture(samples, row.calibration, 2, true, 2 / 30)).toBeUndefined();
    // Post-prediction source inspection identifies this fixed ROI as moving
    // shoe/foot/floor, not an electronic lamp. There is no replacement proposal.
  });

  it("preserves source PTS and describes persistence as a run length rather than onset delay", async () => {
    const row = fixture.rows.find(value => value.id === "12.24" && value.laneIndex === 2)!;
    native.samples = row.samples.map(([time, r, g, b, , , duration]) => ({ time, averageRgb: { r, g, b }, duration }));
    const result = await detectStartSignal({ video: { videoWidth: 720, videoHeight: 1280 } as HTMLVideoElement,
      zone: { ...row.zone, id: "startLight" }, searchStart: row.samples[0][0] - .005, searchEnd: row.samples.at(-1)![0] + .005,
      sensitivity: "medium", profile: "calibrated", fps: 30, colorSamplingMode: "opponent",
      calibration: { beforeStartRGB: row.calibration.beforeStartRGB, afterStartRGB: row.calibration.afterStartRGB,
        colorDelta: row.calibration.colorDelta }, requireChromaticDeparture: true });
    expect(result.detected).toBe(true);
    expect(result.rawTime).toBe(9.448333);
    expect(result.debug.samples.find(sample => sample.time === result.rawTime)?.cursorTime).toBeCloseTo(9.449333, 6);
    expect(result.reason).toContain("31 consecutive blue-like frames");
    expect(result.reason).not.toContain("frames later");
    expect(result.debug.blueConfirmationRawTime).toBe(9.448333);
  });

  it("leaves the real shoe recording unverified in the dense detector, without another High candidate", async () => {
    const row = fixture.rows.find(value => value.id === "IMG_9075")!;
    native.samples = row.samples.map(([time, r, g, b, , , duration]) => ({ time, averageRgb: { r, g, b }, duration }));
    const result = await detectStartSignal({ video: { videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement,
      zone: { ...row.zone, id: "startLight" }, searchStart: row.samples[0][0] - .005, searchEnd: row.samples.at(-1)![0] + .005,
      sensitivity: "medium", profile: "calibrated", fps: 30, colorSamplingMode: "opponent",
      calibration: { beforeStartRGB: row.calibration.beforeStartRGB, afterStartRGB: row.calibration.afterStartRGB,
        colorDelta: row.calibration.colorDelta }, requireChromaticDeparture: true });
    expect(result.detected).toBe(false);
    expect(result.rawTime).toBeUndefined();
    expect(result.candidates).toEqual([]);
    expect(result.debug.failureReason).toContain("No reliable calibrated transition");
  });
});

const COLOR_PAIRS: Array<[string, RGB, RGB]> = [
  ["bright", { r: 20, g: 210, b: 24 }, { r: 20, g: 38, b: 220 }],
  ["faint", { r: 48, g: 63, b: 50 }, { r: 48, g: 50, b: 66 }],
  ["tiny", { r: 68, g: 75, b: 69 }, { r: 68, g: 69, b: 76 }],
  ["very-faint", { r: 90, g: 94, b: 91 }, { r: 90, g: 91, b: 95 }],
];
const scaled = (rgb: RGB, scale: number, gray = 0): RGB => ({
  r: Math.max(0, Math.min(255, Math.round(rgb.r * scale + gray))),
  g: Math.max(0, Math.min(255, Math.round(rgb.g * scale + gray))),
  b: Math.max(0, Math.min(255, Math.round(rgb.b * scale + gray))),
});
const interpolate = (a: RGB, b: RGB, amount: number): RGB => ({
  r: Math.round(a.r + (b.r - a.r) * amount), g: Math.round(a.g + (b.g - a.g) * amount),
  b: Math.round(a.b + (b.b - a.b) * amount),
});
function syntheticSamples(colors: RGB[], calibration: RequiredCalibration, fps = 30): StartSignalDebug["samples"] {
  return colors.map((averageRgb, index) => ({ time: index / fps, averageRgb,
    timestampMethod: "video-frame", sourceFrameDurationSeconds: 1 / fps,
    distanceToBefore: computeColorDistance(averageRgb, calibration.beforeStartRGB),
    distanceToAfter: computeColorDistance(averageRgb, calibration.afterStartRGB),
    colorDistance: computeColorDistance(averageRgb, calibration.beforeStartRGB),
    greenScore: averageRgb.g - Math.max(averageRgb.r, averageRgb.b),
    blueScore: averageRgb.b - Math.max(averageRgb.r, averageRgb.g),
  }));
}
const positives = COLOR_PAIRS.flatMap(([name, rawBefore, rawAfter]) => [.5, .75, 1, 1.2].flatMap(scale => {
  const before = scaled(rawBefore, scale), after = scaled(rawAfter, scale);
  const calibration = { beforeStartRGB: before, afterStartRGB: after, colorDelta: computeColorDistance(before, after) };
  return ["none", "additive-gray", "scaled-exposure"].flatMap(prelude => [1, 4].map(fadeFrames => ({
    name, scale, prelude, fadeFrames, calibration,
    samples: syntheticSamples(Array.from({ length: 24 }, (_, index) => index < 6 ? before : index < 9 ?
      prelude === "additive-gray" ? scaled(before, 1, 10) : prelude === "scaled-exposure" ? scaled(before, .5) : before :
      interpolate(before, after, Math.min(1, (index - 8) / fadeFrames))), calibration),
  })));
}));
const knownQuantizationLimitation = (value: typeof positives[number]) =>
  value.scale === .5 && value.prelude === "scaled-exposure" && ["faint", "tiny"].includes(value.name);
const ambiguousGrayBeforeState = (value: typeof positives[number]) =>
  value.scale === .5 && value.prelude === "additive-gray" && value.name === "very-faint";

describe("constructed exposure and faint-light controls", () => {
  it("keeps all 90 resolved positive controls timely, with two faint gray-shift cases explicitly abstained", () => {
    let oldCorrect = 0, newlyCorrect = 0;
    for (const value of positives.filter(value => !knownQuantizationLimitation(value) && !ambiguousGrayBeforeState(value))) {
      const legacy = findVerifiedGreenDeparture(value.samples, value.calibration, 2, false, 2 / 30);
      const guarded = findVerifiedGreenDeparture(value.samples, value.calibration, 2, true, 2 / 30);
      expect(guarded, JSON.stringify({ ...value, samples: undefined })).toBeDefined();
      expect(guarded!.onsetIndex).toBeGreaterThanOrEqual(9);
      expect(guarded!.onsetIndex).toBeLessThanOrEqual(9 + value.fadeFrames);
      if (legacy && legacy.onsetIndex >= 9 && legacy.onsetIndex <= 9 + value.fadeFrames) oldCorrect++;
      else newlyCorrect++;
    }
    expect(oldCorrect).toBe(32);
    expect(newlyCorrect).toBe(58);
  });

  it.each(positives.filter(ambiguousGrayBeforeState))(
    "abstains when the very faint pre-cue gray state is after-like (fade $fadeFrames)", value => {
      expect(value.samples[8].distanceToBefore!).toBeGreaterThan(value.samples[8].distanceToAfter!);
      expect(findVerifiedGreenDeparture(value.samples, value.calibration, 2, true, 2 / 30)).toBeUndefined();
    });

  // Deliberately failing desired-behavior checks retain four pre-existing misses.
  // One-count RGB quantization can satisfy both unchanged chromatic thresholds
  // during half-exposure. This patch does not establish exposure invariance.
  it.fails.each(positives.filter(knownQuantizationLimitation))(
    "known quantization limitation: $name scale $scale fade $fadeFrames", value => {
      const guarded = findVerifiedGreenDeparture(value.samples, value.calibration, 2, true, 2 / 30);
      expect(guarded?.onsetIndex).toBeGreaterThanOrEqual(9);
    });

  it("rejects all 80 no-event, red-change, exposure-only and single-frame blue controls", () => {
    let count = 0;
    for (const [, rawBefore, rawAfter] of COLOR_PAIRS) for (const scale of [.5, .75, 1, 1.2]) {
      const before = scaled(rawBefore, scale), after = scaled(rawAfter, scale);
      const calibration = { beforeStartRGB: before, afterStartRGB: after, colorDelta: computeColorDistance(before, after) };
      for (const negative of ["stays-green", "additive-gray", "scaled-exposure", "red-change", "one-blue-frame"]) {
        const colors = Array.from({ length: 24 }, (_, index) => index < 9 ? before :
          negative === "additive-gray" ? scaled(before, 1, 10) : negative === "scaled-exposure" ? scaled(before, .5) :
          negative === "red-change" ? { r: Math.max(before.r, after.b), g: before.g, b: before.b } :
          negative === "one-blue-frame" && index === 9 ? after : before);
        expect(findVerifiedGreenDeparture(syntheticSamples(colors, calibration), calibration, 2, true, 2 / 30), negative)
          .toBeUndefined();
        count++;
      }
    }
    expect(count).toBe(80);
  });

  it("preserves native elapsed blue support and an initial blue run before green arms", () => {
    const [, before, after] = COLOR_PAIRS[1];
    const calibration = { beforeStartRGB: before, afterStartRGB: after, colorDelta: computeColorDistance(before, after) };
    for (const fps of [30, 60, 120]) {
      const colors = [after, after, after, before, before, before,
        ...Array.from({ length: Math.ceil(fps * .1) }, () => after)];
      const samples = syntheticSamples(colors, calibration, fps);
      expect(findVerifiedGreenDeparture(samples, calibration, 2, true, 2 / 30)?.onsetIndex).toBe(6);
      expect(findVerifiedGreenDeparture(samples.slice(0, 7), calibration, 2, true, 2 / 30)).toBeUndefined();
    }
  });

  it("does not call a distant after-like brown state stable green before a blue replacement", () => {
    const before = { r: 46, g: 42, b: 31 }, after = { r: 113, g: 117, b: 136 }, brown = { r: 145, g: 97, b: 74 };
    const calibration = { beforeStartRGB: before, afterStartRGB: after, colorDelta: computeColorDistance(before, after) };
    const samples = syntheticSamples([before, before, before, brown, brown, brown, after, after, after, after], calibration);
    expect(findVerifiedGreenDeparture(samples, calibration, 2, true, 2 / 30)).toBeUndefined();
  });

  it.fails("known hardware-identity limitation: an entering blue object can replace a genuinely before-like background", () => {
    const before = { r: 40, g: 55, b: 42 }, object = { r: 40, g: 42, b: 75 };
    const calibration = { beforeStartRGB: before, afterStartRGB: object, colorDelta: computeColorDistance(before, object) };
    const samples = syntheticSamples([...Array.from({ length: 8 }, () => before), ...Array.from({ length: 12 }, () => object)], calibration);
    // RGB history alone cannot certify stationary emitting hardware. This
    // desired rejection remains an explicit known limitation, not a pass.
    expect(findVerifiedGreenDeparture(samples, calibration, 2, true, 2 / 30)).toBeUndefined();
  });
});
