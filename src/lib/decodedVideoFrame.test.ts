import { afterEach, describe, expect, it, vi } from "vitest";
import { readDecodedVideoFrameTime, sourceFrameStepTarget } from "./decodedVideoFrame";

const video = () => ({ src: "blob:local-video", currentTime: 2.85, duration: 20, readyState: 2, seeking: false } as HTMLVideoElement);
afterEach(() => vi.unstubAllGlobals());

describe("synchronous source-frame timing", () => {
  it("steps from frame boundaries rather than adding a guessed 30-fps interval", () => {
    const frame = { mediaTime: 1, durationSeconds: 1 / 15 };
    expect(sourceFrameStepTarget(frame, 20, 1)).toBeCloseTo(1.066766667, 6);
    expect(sourceFrameStepTarget(frame, 20, -1)).toBeCloseTo(0.9999, 6);
    expect(sourceFrameStepTarget({ ...frame, durationSeconds: 1 / 30 }, 20, 1)).toBeCloseTo(1.033433333, 6);
  });
  it("bounds adjacent-frame seeks and refuses missing duration", () => {
    expect(sourceFrameStepTarget({ mediaTime: 0, durationSeconds: 1 / 30 }, 20, -1)).toBe(0);
    expect(sourceFrameStepTarget({ mediaTime: 19.98, durationSeconds: 1 / 30 }, 20, 1)).toBe(19.999);
    expect(sourceFrameStepTarget({ mediaTime: 2 }, 20, 1)).toBeUndefined();
    expect(sourceFrameStepTarget({ mediaTime: 2, durationSeconds: Infinity }, 20, 1)).toBeUndefined();
  });
  it("retains native time and duration without replacing the timestamp", () => {
    const close = vi.fn(), constructor = vi.fn();
    vi.stubGlobal("VideoFrame", class { timestamp = 2_833_333; duration = 33_333; close = close;
      constructor(...args: unknown[]) { constructor(...args); } });
    const element = video(), result = readDecodedVideoFrameTime(element);
    expect(result).toEqual({ mediaTime: 2.833333, cursorTime: 2.85, durationSeconds: 0.033333, source: element.src, method: "video-frame" });
    expect(constructor).toHaveBeenCalledExactlyOnceWith(element);
    expect(close).toHaveBeenCalledOnce();
  });
  it("closes rejected frames rather than leaking decoder resources", () => {
    for (const timestamp of [-1, NaN, Infinity, 19_000_000]) {
      const close = vi.fn();
      vi.stubGlobal("VideoFrame", class { timestamp = timestamp; duration = null; close = close; });
      expect(readDecodedVideoFrameTime(video())).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
    }
  });
  it("does not create frames while seeking or metadata is missing", () => {
    const constructor = vi.fn(); vi.stubGlobal("VideoFrame", constructor);
    for (const partial of [{ seeking: true }, { readyState: 1 }, { src: "" }, { duration: Infinity }]) {
      expect(readDecodedVideoFrameTime({ ...video(), ...partial })).toBeUndefined();
    }
    expect(constructor).not.toHaveBeenCalled();
  });
  it("retains compatibility when the API or codec is unsupported", () => {
    vi.stubGlobal("VideoFrame", undefined); expect(readDecodedVideoFrameTime(video())).toBeUndefined();
    vi.stubGlobal("VideoFrame", class { constructor() { throw new Error("Unsupported codec"); } });
    expect(readDecodedVideoFrameTime(video())).toBeUndefined();
  });
  it("does not invent a frame duration when the browser omits it", () => {
    vi.stubGlobal("VideoFrame", class { timestamp = 2_833_333; duration = null; close() {} });
    expect(readDecodedVideoFrameTime(video())?.durationSeconds).toBeUndefined();
  });
});
