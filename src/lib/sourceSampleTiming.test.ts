import { describe, expect, it } from "vitest";
import { sanitizeSourceSampleTiming, summarizeSourceSampleTiming, uniqueSourceFrameSamples } from "./sourceSampleTiming";

describe("sampled-frame identity provenance", () => {
  it("keeps the sampling cursor and native PTS separate", () => {
    expect(sanitizeSourceSampleTiming(7.13, { decodedFrameRawTime: 7.101667, sourceFrameDurationSeconds: 0.033333 }))
      .toEqual({ decodedFrameRawTime: 7.101667, sourceFrameDurationSeconds: 0.033333 });
  });
  it("does not accept null, string, future, or distant PTS values", () => {
    for (const time of [null, "7.1", NaN, Infinity, -1, 8, 6]) {
      expect(sanitizeSourceSampleTiming(7.13, { decodedFrameRawTime: time as number })).toEqual({});
    }
  });
  it("rejects an interval that does not contain the sampling cursor", () => {
    expect(sanitizeSourceSampleTiming(7.2, { decodedFrameRawTime: 7.1, sourceFrameDurationSeconds: 0.033333 })).toEqual({});
  });
  it("does not fabricate duration when metadata is unavailable or invalid", () => {
    for (const duration of [undefined, null, -1, Infinity, "0.03"]) {
      expect(sanitizeSourceSampleTiming(7.13, { decodedFrameRawTime: 7.1, sourceFrameDurationSeconds: duration as number }))
        .toEqual({ decodedFrameRawTime: 7.1, sourceFrameDurationSeconds: undefined });
    }
  });
  it("does not count a source frame twice at two nearby cursor positions", () => {
    const frames = [0.15, 0.18, 0.21].map((rawTime, index) => ({ rawTime, decodedFrameRawTime: index < 2 ? 0.133333 : 0.2, sourceFrameDurationSeconds: 1 / 15 }));
    expect(uniqueSourceFrameSamples(frames).map(frame => frame.rawTime)).toEqual([0.15, 0.21]);
    expect(summarizeSourceSampleTiming(frames)).toMatchObject({ sampledFrames: 3, nativeTimingFrames: 3, uniqueNativeFrames: 2, repeatedNativeFrames: 1, isEventAccuracyBound: false });
  });
  it("preserves distinct legacy samples without inventing native identity", () => {
    const frames = [{ rawTime: 1 }, { rawTime: 1.1 }];
    expect(uniqueSourceFrameSamples(frames)).toEqual(frames);
    expect(summarizeSourceSampleTiming(frames)).toMatchObject({ nativeTimingFrames: 0, maximumCursorOffsetSeconds: null });
  });
  it("deduplicates identical legacy cursor records too", () => {
    expect(uniqueSourceFrameSamples([{ rawTime: 1 }, { rawTime: 1 }])).toHaveLength(1);
  });
});
