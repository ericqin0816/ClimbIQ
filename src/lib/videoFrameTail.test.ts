import { afterEach, describe, expect, it, vi } from "vitest";
import { seekTo, seekToFrameObservation } from "./videoFrameSampler";
import { scanSourceFrames } from "./sourceFrameScan";
import { detectFinishSignal } from "./detectFinishSignal";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function tailVideo(options: { containerDuration?: number; frameTime?: number; frameDuration?: number;
  onSeek?: (time: number, video: HTMLVideoElement) => void;
  native?: () => { timestamp: number; duration: number | null } } = {}) {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  // Make readiness deadlines deterministic without changing source clocks.
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now += 250);
  const video = Object.assign(new EventTarget(), { src: "blob:tail", duration: options.containerDuration ?? 13.328254,
    readyState: 4, seeking: false, videoWidth: 100, videoHeight: 100 }) as unknown as HTMLVideoElement;
  let cursor = 0;
  const seeks: number[] = [];
  Object.defineProperty(video, "currentTime", { get: () => cursor, set: (time: number) => {
    cursor = time; seeks.push(time); options.onSeek?.(time, video);
    queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
  } });
  vi.stubGlobal("VideoFrame", class {
    timestamp = options.native?.().timestamp ?? Math.round((options.frameTime ?? 13.2) * 1e6);
    duration = options.native ? options.native().duration : Math.round((options.frameDuration ?? 1 / 30) * 1e6);
    close() {}
  });
  return { video, seeks };
}

describe("explicitly partial native tail observations", () => {
  it("keeps ordinary seeks strict at the audio/container tail", async () => {
    const { video, seeks } = tailVideo();
    await expect(seekTo(video, 13.27)).rejects.toThrow("did not catch up");
    expect(seeks).toEqual([13.27]);
  });

  it("re-seeks inside the native interval and never relabels its pixels as the requested tail", async () => {
    const { video, seeks } = tailVideo();
    const result = await seekToFrameObservation(video, 13.27, { allowUnobservedTail: true });
    expect(seeks).toEqual([13.27, 13.2 + .033333 / 2]);
    expect(result.requestedTime).toBe(13.27);
    expect(result.cursorTime).toBeCloseTo(13.2166665, 7);
    expect(result.decoded).toMatchObject({ mediaTime: 13.2, durationSeconds: .033333 });
    expect(result.partialSourceObservation).toMatchObject({ requestedTime: 13.27,
      lastFrameRawTime: 13.2, lastFrameDurationSeconds: .033333,
      observedThroughTime: 13.233333, containerDuration: 13.328254, isEventAccuracyBound: false });
    expect(result.partialSourceObservation?.reason).toContain("boundary is unknown");
  });

  it.each([
    { containerDuration: 20, frameTime: 13.2, cursor: 13.27, label: "interior stale frame" },
    { frameTime: 12.8, cursor: 13.27, label: "large missing tail" },
    { frameTime: 13.2, frameDuration: .00001, cursor: 13.27, label: "invalid tiny duration" },
    { frameTime: 13.2, cursor: 14, label: "outside container" },
  ])("refuses $label", async ({ cursor, ...options }) => {
    const { video, seeks } = tailVideo(options);
    await expect(seekToFrameObservation(video, cursor, { allowUnobservedTail: true })).rejects.toThrow("did not catch up");
    expect(seeks).toHaveLength(1);
  });

  it.each(["timestamp", "duration", "missing duration", "missing timing"])("refuses changed %s during independent re-seek", async kind => {
    let changed = false;
    const { video } = tailVideo({ onSeek: time => { if (time < 13.25) changed = true; }, native: () => ({
      timestamp: (changed && kind === "timestamp" ? 13.21 : 13.2) * 1e6,
      duration: changed && kind === "missing duration" ? null : changed && kind === "duration" ? 40000 : 33333,
    }) });
    if (kind === "missing timing") {
      video.addEventListener("seeked", () => { if (changed) vi.stubGlobal("VideoFrame", undefined); });
    }
    await expect(seekToFrameObservation(video, 13.27, { allowUnobservedTail: true })).rejects.toThrow("independently re-seeked");
  });

  it.each(["source", "cancel"])("retains %s ownership through the recovery seek", async kind => {
    const controller = new AbortController();
    const { video } = tailVideo({ onSeek: (time, node) => {
      if (time < 13.25) {
        if (kind === "source") node.src = "blob:replacement";
        else controller.abort();
      }
    } });
    await expect(seekToFrameObservation(video, 13.27, { allowUnobservedTail: true, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns partial summary without duplicating the last native frame during a duration walk", async () => {
    const { video } = tailVideo();
    const observations: Array<{ rawTime: number; cursorTime: number }> = [];
    const summary = await scanSourceFrames({ video, start: 13.21, end: 13.28, allowUnobservedTail: true,
      onFrame: frame => { observations.push(frame); } });
    expect(observations).toHaveLength(1);
    expect(observations[0].rawTime).toBe(13.2);
    expect(summary.observations).toBe(1);
    expect(summary.duplicateFramesSkipped).toBeGreaterThan(0);
    expect(summary.partialSourceObservation?.lastFrameRawTime).toBe(13.2);
  });

  it("does not make partial dense verification the default", async () => {
    const { video } = tailVideo();
    await expect(scanSourceFrames({ video, start: 13.21, end: 13.28, onFrame: () => {} }))
      .rejects.toThrow("did not catch up");
  });

  it("keeps an otherwise confirmed lower-lamp Finish review-only with an agreeing entered total", async () => {
    let node: HTMLVideoElement;
    const { video } = tailVideo({ native: () => ({
      timestamp: Math.round(Math.min(13.2, Math.floor((node.currentTime + 1e-9) * 30) / 30) * 1e6), duration: 33333,
    }) });
    node = video;
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({
      clearRect() {}, drawImage() {}, getImageData: () => ({ width: 2, height: 2,
        data: new Uint8ClampedArray(Array.from({ length: 4 }, () => video.currentTime < 8.2
          ? [70, 62, 105, 255] : [70, 92, 58, 255]).flat()) }),
    }) }) });
    const result = await detectFinishSignal({ video, startSignalRawTime: 2.07, expectedFinishTime: 8.2,
      zone: { id: "finishLight", label: "Test light", x1: 0, y1: 0, x2: .02, y2: .02 },
      calibration: { beforeStartRGB: { r: 70, g: 92, b: 58 }, afterStartRGB: { r: 70, g: 62, b: 105 }, colorDelta: 55 } });
    expect(result.detected).toBe(false);
    expect(result.rawTime).toBeUndefined();
    expect(result.confidence).toBe("Low");
    expect(result.candidates?.[0].rawTime).toBeCloseTo(8.2, 3);
    expect(result.candidates?.every(candidate => candidate.confidence === "Low")).toBe(true);
    expect(result.debug.partialSourceObservation?.requestedTime).toBe(13.27);
    expect(result.debug.partialSourceObservation?.lastFrameRawTime).toBe(13.2);
    expect(result.debug.samples.every(sample => sample.time !== 13.27)).toBe(true);
    expect(result.reason).toContain("final video-track boundary is unknown");
  });
});
