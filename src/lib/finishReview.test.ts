import { afterEach, describe, expect, it, vi } from "vitest";
import { finishPadChange, finishReviewCrop, finishReviewWindow, normalizeFinishPadZone, scanFinishPadReview } from "./finishReview";
import { sanitizeZoneMap } from "./sessionEvidenceIntegrity";

afterEach(() => vi.unstubAllGlobals());
const zone = normalizeFinishPadZone({ x1: 0.4, y1: 0.1, x2: 0.6, y2: 0.2 })!;
describe("guided finish review", () => {
  it("normalizes user corners without claiming automatic pad detection", () => {
    expect(normalizeFinishPadZone({ x1: 0.6, y1: 0.2, x2: 0.4, y2: 0.1 })).toEqual(zone);
    expect(sanitizeZoneMap({ finishPad: { ...zone, label: "Auto verified" } }).finishPad).toEqual(zone);
  });
  it("rejects empty, nonfinite and excessively broad pad areas", () => {
    expect(normalizeFinishPadZone({ ...zone, x2: zone.x1 })).toBeUndefined();
    expect(normalizeFinishPadZone({ ...zone, y1: NaN })).toBeUndefined();
    expect(normalizeFinishPadZone({ x1: 0, y1: 0, x2: 1, y2: 1 })).toBeUndefined();
  });
  it("bounds a short rescan by the accepted start and media duration", () => {
    expect(finishReviewWindow(5, 20, 1)).toEqual({ start: 3.75, end: 6.25 });
    expect(finishReviewWindow(1, 20, 1)).toEqual({ start: 1, end: 2.25 });
    expect(finishReviewWindow(19.8, 20)).toEqual({ start: 18.55, end: 19.999 });
    for (const args of [[NaN, 20], [5, Infinity], [20, 20], [-1, 20], [5, 20, 8]]) expect(finishReviewWindow(...args as [number, number, number?])).toBeUndefined();
  });
  it("keeps contextual crops within the image and uses an explicit unverified overview", () => {
    expect(finishReviewCrop().label).toBe("Upper-wall overview");
    const edge = finishReviewCrop({ ...zone, x1: 0, y1: 0, x2: 0.03, y2: 0.03 });
    expect(edge.x1).toBe(0); expect(edge.y1).toBe(0); expect(edge.x2).toBeGreaterThan(0.03);
  });
  it("ignores uniform exposure shifts while surfacing localized visual changes", () => {
    const before = new Uint8ClampedArray(Array.from({ length: 100 }, () => [60, 60, 60, 255]).flat());
    const after = new Uint8ClampedArray(Array.from({ length: 100 }, () => [90, 90, 90, 255]).flat());
    expect(finishPadChange(before, after)).toBe(0);
    after.fill(180, 0, 40);
    expect(finishPadChange(before, after)).toBeGreaterThan(4);
    expect(finishPadChange(before, after.slice(4))).toBe(0);
  });
  it.each([false, true])("returns review frames without accepting timing; native frames=%s", async native => {
    const video = fakeVideo(native);
    const result = await scanFinishPadReview({ video, zone, center: 2, startSignal: 0.5 });
    expect(result.frames.length).toBeGreaterThanOrEqual(3);
    expect(result.frames.length).toBeLessThanOrEqual(5);
    expect(result.reason).toContain("no finish was accepted");
    expect(result).not.toHaveProperty("accepted");
    if (native) {
      expect(result.nativeTimedFrames).toBe(result.comparedFrames);
      expect(result.comparedFrames).toBeLessThan(result.sampledFrames);
      expect(new Set(result.frames.map(frame => frame.rawTime)).size).toBe(result.frames.length);
    } else expect(result.nativeTimedFrames).toBe(0);
  });
  it("honors cancellation without publishing a completed scan", async () => {
    const video = fakeVideo(false);
    const controller = new AbortController();
    await expect(scanFinishPadReview({ video, zone, center: 2, signal: controller.signal,
      onProgress: () => controller.abort() })).rejects.toThrow("cancelled");
  });
});

function fakeVideo(native: boolean) {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const video = Object.assign(new EventTarget(), { src: "blob:test", videoWidth: 100, videoHeight: 100, duration: 5, readyState: 2, seeking: false }) as unknown as HTMLVideoElement;
  let cursor = 0;
  Object.defineProperty(video, "currentTime", { get: () => cursor, set: value => { cursor = value; queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); } });
  vi.stubGlobal("VideoFrame", native ? class { timestamp = Math.floor(cursor * 5) / 5 * 1e6; duration = 200000; close() {} } : undefined);
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0,
    toDataURL: () => "data:image/jpeg;base64,test", getContext: () => ({ drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: 48 * 48 }, (_, i) =>
        cursor >= 2 && i < 500 ? [170, 150, 120, 255] : [60, 60, 60, 255]).flat()) }),
    }) }) });
  return video;
}
