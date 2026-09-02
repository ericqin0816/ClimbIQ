import { describe, expect, it } from "vitest";
import { sanitizeStartLightCalibration, sanitizeVideoMetadata, sanitizeZoneMap } from "./sessionEvidenceIntegrity";

describe("saved session evidence integrity", () => {
  it("normalizes reversed zone corners, clamps them, and restores the canonical id and label", () => {
    expect(sanitizeZoneMap({
      startLight: { id: "hold10", label: "untrusted", x1: 1.2, y1: 0.8, x2: 0.7, y2: -0.2 },
    }).startLight).toEqual({
      id: "startLight",
      label: "Start Light Zone",
      x1: 0.7,
      y1: 0,
      x2: 1,
      y2: 0.8,
    });
  });

  it("drops malformed and zero-area zones while ignoring unknown keys", () => {
    expect(sanitizeZoneMap({
      startBody: { x1: 0.2, y1: 0.2, x2: Number.NaN, y2: 0.5 },
      hold10: { x1: 0.4, y1: 0.4, x2: 0.4, y2: 0.8 },
      attacker: { x1: 0, y1: 0, x2: 1, y2: 1 },
    })).toEqual({});
  });

  it("recomputes color distance instead of trusting imported calibration metadata", () => {
    expect(sanitizeStartLightCalibration({
      beforeStartRGB: { r: 10, g: 80, b: 10 },
      afterStartRGB: { r: 10, g: 10, b: 80 },
      colorDelta: 99999,
      calibrationFrameBeforeTime: 2,
      calibrationFrameAfterTime: 4,
    }, 10)).toEqual({
      beforeStartRGB: { r: 10, g: 80, b: 10 },
      afterStartRGB: { r: 10, g: 10, b: 80 },
      colorDelta: 98.995,
      calibrationFrameBeforeTime: 2,
      calibrationFrameAfterTime: 4,
    });
  });

  it("drops invalid colors and calibration times outside the video", () => {
    expect(sanitizeStartLightCalibration({
      beforeStartRGB: { r: -1, g: 80, b: 10 },
      afterStartRGB: { r: 10, g: 10, b: 300 },
      colorDelta: 40,
      calibrationFrameBeforeTime: -1,
      calibrationFrameAfterTime: 12,
    }, 10)).toEqual({
      beforeStartRGB: undefined,
      afterStartRGB: undefined,
      colorDelta: undefined,
      calibrationFrameBeforeTime: undefined,
      calibrationFrameAfterTime: undefined,
    });
  });

  it("restores valid video metadata without trusting a persisted loaded flag", () => {
    expect(sanitizeVideoMetadata({
      fileName: " climb.mov ",
      duration: 20.5,
      videoWidth: 1080.2,
      videoHeight: 1920,
      metadataLoaded: true,
    })).toEqual({
      fileName: "climb.mov",
      duration: 20.5,
      videoWidth: 1080,
      videoHeight: 1920,
      metadataLoaded: false,
    });
  });

  it("drops malformed video metadata", () => {
    expect(sanitizeVideoMetadata({ fileName: "bad.mov", duration: Number.NaN, videoWidth: 1080, videoHeight: 1920 })).toBeNull();
    expect(sanitizeVideoMetadata({ fileName: "", duration: 20, videoWidth: 1080, videoHeight: 1920 })).toBeNull();
  });
});
