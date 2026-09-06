import { afterEach, describe, expect, it, vi } from "vitest";
import { scanSourceFrames } from "./sourceFrameScan";

afterEach(() => vi.unstubAllGlobals());
function fakeVideo(boundaries: number[], duration = 2, native = true) {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const video = Object.assign(new EventTarget(), {
    src: "blob:scan",
    duration,
    videoWidth: 100,
    videoHeight: 100,
    readyState: 2,
    seeking: false,
  }) as unknown as HTMLVideoElement;
  let cursor = 0;
  Object.defineProperty(video, "currentTime", {
    get: () => cursor,
    set: (value: number) => {
      cursor = value;
      queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
    },
  });
  vi.stubGlobal(
    "VideoFrame",
    native
      ? class {
          index = boundaries.reduce(
            (last, b, i) => (b <= cursor + 1e-9 ? i : last),
            0,
          );
          timestamp = Math.round(boundaries[this.index] * 1e6);
          duration = Math.round(
            ((boundaries[this.index + 1] ?? duration) -
              boundaries[this.index]) *
              1e6,
          );
          close() {}
        }
      : undefined,
  );
  return video;
}
describe("bounded native-frame refinement", () => {
  it("visits every 30 fps frame once despite millisecond-rounded grid boundaries", async () => {
    const points = Array.from({ length: 60 }, (_, i) => i / 30);
    const video = fakeVideo(points),
      frames: number[] = [];
    const summary = await scanSourceFrames({
      video,
      start: 0.2,
      end: 0.6,
      onFrame: (f) => {
        frames.push(f.rawTime);
      },
    });
    expect(frames).toEqual(
      points
        .filter((t) => t >= 0.2 && t < 0.6)
        .map((t) => Math.round(t * 1e6) / 1e6),
    );
    expect(summary.nativeFrames).toBe(frames.length);
    expect(new Set(frames).size).toBe(frames.length);
  });
  it("follows variable frame durations instead of a guessed frame rate", async () => {
    const video = fakeVideo([0, 0.1, 0.13, 0.2, 0.23, 0.4, 0.45, 0.8, 1]),
      frames: number[] = [];
    await scanSourceFrames({
      video,
      start: 0.101,
      end: 0.79,
      onFrame: (f) => {
        frames.push(f.rawTime);
      },
    });
    expect(frames).toEqual([0.1, 0.13, 0.2, 0.23, 0.4, 0.45]);
  });
  it("does not count a low-frame-rate source multiple times", async () => {
    const video = fakeVideo([0, 0.2, 0.4, 0.6, 0.8, 1]),
      frames: number[] = [];
    await scanSourceFrames({
      video,
      start: 0.01,
      end: 0.79,
      onFrame: (f) => {
        frames.push(f.rawTime);
      },
    });
    expect(frames).toEqual([0, 0.2, 0.4, 0.6]);
  });
  it("seeks across a frame boundary even when less than four milliseconds away", async () => {
    const video = fakeVideo([0, 0.1, 0.2, 0.3, 0.4]),
      frames: number[] = [];
    await scanSourceFrames({
      video,
      start: 0.099,
      end: 0.25,
      onFrame: (f) => {
        frames.push(f.rawTime);
      },
    });
    expect(frames).toEqual([0, 0.1, 0.2]);
  });
  it("keeps cursor fallback explicit when native timing is unavailable", async () => {
    const video = fakeVideo([0], 2, false),
      frames: number[] = [];
    const result = await scanSourceFrames({
      video,
      start: 0.1,
      end: 0.21,
      fallbackFps: 30,
      onFrame: (f) => {
        frames.push(f.rawTime);
        expect(f.decoded).toBeUndefined();
      },
    });
    expect(frames).toHaveLength(4);
    expect(result.nativeFrames).toBe(0);
    expect(result.isAccuracyBound).toBe(false);
  });
  it("deduplicates native timestamps even when the browser omits frame duration", async () => {
    const video = fakeVideo([
        0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
      ]),
      frames: number[] = [];
    vi.stubGlobal(
      "VideoFrame",
      class {
        timestamp = (Math.floor((video.currentTime + 1e-9) * 10) / 10) * 1e6;
        duration = null;
        close() {}
      },
    );
    const summary = await scanSourceFrames({
      video,
      start: 0.01,
      end: 0.79,
      onFrame: (f) => {
        frames.push(f.rawTime);
      },
    });
    expect(frames).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(summary.duplicateFramesSkipped).toBeGreaterThan(0);
    expect(summary.usedDurationSteps).toBe(0);
  });
  it("refuses mixed native/cursor evidence after native timing disappears", async () => {
    const video = fakeVideo([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    await expect(
      scanSourceFrames({
        video,
        start: 0.01,
        end: 0.4,
        onFrame: () => {
          vi.stubGlobal("VideoFrame", undefined);
        },
      }),
    ).rejects.toThrow("became unavailable");
  });
  it("does not silently switch a cursor fallback to native timing mid-scan", async () => {
    const video = fakeVideo([0], 2, false);
    const result = await scanSourceFrames({
      video,
      start: 0.01,
      end: 0.2,
      onFrame: (frame) => {
        expect(frame.decoded).toBeUndefined();
        vi.stubGlobal(
          "VideoFrame",
          class {
            timestamp = video.currentTime * 1e6;
            duration = 33333;
            close() {}
          },
        );
      },
    });
    expect(result.nativeFrames).toBe(0);
  });
  it("fails closed on budget exhaustion, invalid ranges, cancellation and replacement", async () => {
    const video = fakeVideo(Array.from({ length: 60 }, (_, i) => i / 30));
    await expect(
      scanSourceFrames({
        video,
        start: 0,
        end: 1,
        maxFrames: 2,
        onFrame: () => {},
      }),
    ).rejects.toThrow("budget");
    await expect(
      scanSourceFrames({ video, start: -1, end: 1, onFrame: () => {} }),
    ).rejects.toThrow("Invalid");
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanSourceFrames({
        video,
        start: 0,
        end: 1,
        signal: controller.signal,
        onFrame: () => {},
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      scanSourceFrames({
        video,
        start: 0,
        end: 1,
        onFrame: () => {
          video.src = "blob:new";
        },
      }),
    ).rejects.toThrow("cancelled");
  });
});
