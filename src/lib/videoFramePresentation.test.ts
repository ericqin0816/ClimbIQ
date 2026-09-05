import { afterEach, describe, expect, it, vi } from "vitest";
import { observeVideoFramePresentation, resolvePresentedFrameTime, type FramePresentation } from "./videoFramePresentation";

class FakeVideo extends EventTarget {
  src = "blob:test-video";
  currentTime = 2.85;
  duration = 20;
  seeking = false;
  callback?: VideoFrameRequestCallback;
  nextId = 0;
  cancelled: number[] = [];
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.callback = callback; return ++this.nextId; }
  cancelVideoFrameCallback(id: number) { this.cancelled.push(id); }
  present(mediaTime = 2.833333, presentationTime = performance.now()) {
    this.callback?.(performance.now(), { mediaTime, presentationTime } as VideoFrameCallbackMetadata);
  }
  element() { return this as unknown as HTMLVideoElement; }
}

afterEach(() => vi.useRealTimers());

describe("presented video frame timestamps", () => {
  it("retains the decoded frame timestamp separately from the seek cursor", () => {
    const video = new FakeVideo(); const updates: FramePresentation[] = [];
    const stop = observeVideoFramePresentation(video.element(), value => updates.push(value));
    video.present();
    expect(updates.at(-1)).toEqual({ status: "available", mediaTime: 2.833333, cursorTime: 2.85, source: video.src });
    expect(resolvePresentedFrameTime(video, updates.at(-1)!)).toBe(2.833333);
    stop();
  });
  it("invalidates old frames when seeking and rejects a delayed old presentation", () => {
    vi.useFakeTimers(); const video = new FakeVideo(); const updates: FramePresentation[] = [];
    const stop = observeVideoFramePresentation(video.element(), value => updates.push(value));
    const oldTime = performance.now(); video.present();
    vi.advanceTimersByTime(10); video.currentTime = 3; video.dispatchEvent(new Event("seeking"));
    video.present(2.833333, oldTime);
    expect(updates.at(-1)?.status).toBe("pending");
    video.present(3); expect(updates.at(-1)?.status).toBe("available"); stop();
  });
  it("does not publish frames while the decoder is seeking or after source replacement", () => {
    const video = new FakeVideo(); const updates: FramePresentation[] = [];
    const stop = observeVideoFramePresentation(video.element(), value => updates.push(value));
    video.seeking = true; video.present(); expect(updates.at(-1)?.status).toBe("pending");
    video.seeking = false; video.src = "blob:another-video"; video.present();
    expect(updates.at(-1)?.status).toBe("pending"); stop();
  });
  it("retains a new presentation delivered before the seeked event", () => {
    const video = new FakeVideo(); const updates: FramePresentation[] = [];
    const stop = observeVideoFramePresentation(video.element(), value => updates.push(value));
    video.seeking = true; video.present(); expect(updates.at(-1)?.status).toBe("pending");
    video.seeking = false; video.dispatchEvent(new Event("seeked"));
    expect(updates.at(-1)).toMatchObject({ status: "available", mediaTime: 2.833333 }); stop();
  });
  it("provides an explicit fallback when paused-frame callbacks are unavailable", () => {
    vi.useFakeTimers(); const video = new FakeVideo(); const updates: FramePresentation[] = [];
    const stop = observeVideoFramePresentation(video.element(), value => updates.push(value), 100);
    vi.advanceTimersByTime(100); expect(updates.at(-1)?.status).toBe("unavailable"); stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels callbacks and listeners on cleanup", () => {
    vi.useFakeTimers(); const video = new FakeVideo(); const update = vi.fn();
    const stop = observeVideoFramePresentation(video.element(), update); stop(); const count = update.mock.calls.length;
    video.present(); video.dispatchEvent(new Event("seeking")); vi.advanceTimersByTime(1000);
    expect(update).toHaveBeenCalledTimes(count); expect(video.cancelled).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reuse a timestamp after a different cursor or source is selected", () => {
    const video = new FakeVideo();
    const presentation: FramePresentation = { status: "available", mediaTime: 2.833333, cursorTime: 2.85, source: video.src };
    video.currentTime = 3; expect(resolvePresentedFrameTime(video, presentation)).toBeUndefined();
    video.currentTime = 2.85; video.src = "blob:other"; expect(resolvePresentedFrameTime(video, presentation)).toBeUndefined();
  });
  it("rejects nonfinite or implausibly distant frame metadata", () => {
    const video = new FakeVideo(); const update = vi.fn(); const stop = observeVideoFramePresentation(video.element(), update);
    for (const value of [NaN, Infinity, -1, 19]) video.present(value);
    expect(update).toHaveBeenCalledTimes(1); stop();
  });
  it("does not require the frame callback API in older browsers", () => {
    const update = vi.fn(); observeVideoFramePresentation({} as HTMLVideoElement, update)();
    expect(update).toHaveBeenCalledWith({ status: "unsupported" });
  });
});
