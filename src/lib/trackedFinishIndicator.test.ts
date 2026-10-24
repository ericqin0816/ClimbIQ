import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedZone } from "../types";
import {
  bindTrackedFinishIndicatorAnchor, buildIndicatorContextModel,
  captureTrackedFinishIndicatorFrame, isTrackedFinishIndicatorAnchorCurrent,
  scanTrackedFinishIndicatorReview, trackIndicatorContext,
  type IndicatorTrackingFrame, type TrackedFinishIndicatorAnchor,
} from "./trackedFinishIndicator";

const { seek } = vi.hoisted(() => ({ seek: vi.fn() }));
vi.mock("./videoFrameSampler", async importOriginal => ({
  ...await importOriginal<typeof import("./videoFrameSampler")>(), seekToFrameObservation: seek,
}));
const zone: NormalizedZone = { id: "finishIndicator", label: "Explicit sensor", x1: .65, y1: .4, x2: .72, y2: .48 };

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("tracked manual indicator context", () => {
  it.each([[15, 15], [14, 15], [15, 14], [14, 14]])("rejects an equally good context copy at offset %s,%s", (dx, dy) => {
    const first = separatedContextPatches();
    const sensor: NormalizedZone = { id: "finishIndicator", label: "Manual sensor", x1: .45, y1: .45, x2: .55, y2: .55 };
    const model = buildIndicatorContextModel(first, sensor).model;
    expect(model).toBeDefined();
    const duplicate = { ...first, data: first.data.slice() };
    for (const [cx, cy] of contextPatchCenters) for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) {
      const source = (y * first.width + x) * 4;
      duplicate.data.set(first.data.subarray(source, source + 4), ((y + dy) * first.width + x + dx) * 4);
    }

    // Both the original and a spatially consistent duplicate fit the anchor.
    // A distant peak on an odd pixel must not disappear from the runner-up test.
    expect(trackIndicatorContext(model!, duplicate).tracked).toBe(false);
  });
  it("keeps original surrounding context when the excluded light flips color and the camera translates", () => {
    const first = texture(), model = buildIndicatorContextModel(first, zone).model;
    expect(model).toBeDefined();
    const after = translate(first, 5, -3);
    paint(after, 109, 45, 11, 10, [190, 50, 45]);

    const tracked = trackIndicatorContext(model!, after);

    expect(tracked.tracked, JSON.stringify(tracked)).toBe(true);
    expect(tracked.dx).toBe(5);
    expect(tracked.dy).toBe(-3);
    expect(tracked.supportingQuadrants).toBeGreaterThanOrEqual(3);
    expect(tracked.region!.x1).toBeCloseTo(zone.x1 + 5 / first.width);
  });

  it("does not include the selected sensor pixels in its context descriptors", () => {
    const first = texture(), after = clone(first);
    paint(after, 104, 48, 12, 10, [255, 0, 255]);
    const a = buildIndicatorContextModel(first, zone).model!, b = buildIndicatorContextModel(after, zone).model!;

    expect(a.features).toEqual(b.features);
  });

  it("ignores a separate lane's light change instead of moving the selected indicator", () => {
    const first = texture(), model = buildIndicatorContextModel(first, zone).model!;
    const after = clone(first); paint(after, 15, 45, 15, 12, [250, 40, 30]);

    const tracked = trackIndicatorContext(model, after);
    expect(tracked, JSON.stringify(tracked)).toMatchObject({ tracked: true, dx: 0, dy: 0 });
  });

  it("rejects an abrupt jump outside the adjacent search rather than reacquiring another lane", () => {
    const first = texture(), model = buildIndicatorContextModel(first, zone).model!;

    expect(trackIndicatorContext(model, translate(first, -48, 0)).tracked).toBe(false);
  });

  it("refuses a different scene and a broadly occluded context", () => {
    const first = texture(), model = buildIndicatorContextModel(first, zone).model!;
    expect(trackIndicatorContext(model, texture(9182)).tracked).toBe(false);
    const occluded = clone(first); paint(occluded, 60, 10, 100, 100, [80, 80, 80]);
    expect(trackIndicatorContext(model, occluded).tracked).toBe(false);
  });

  it("rejects blank and repeatedly ambiguous image context", () => {
    const blank = texture(); paint(blank, 0, 0, blank.width, blank.height, [90, 90, 90]);
    expect(buildIndicatorContextModel(blank, zone).model).toBeUndefined();
    const repeated = texture();
    for (let y = 0; y < repeated.height; y++) for (let x = 0; x < repeated.width; x++) {
      const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 190 : 45;
      paint(repeated, x, y, 1, 1, [value, value, value]);
    }
    const model = buildIndicatorContextModel(repeated, zone).model;
    expect(model).toBeUndefined();
  });

  it("does not turn one coherent moving quadrant into a valid context track", () => {
    const first = texture(), model = buildIndicatorContextModel(first, zone).model!;
    const after = texture(9911);
    for (let y = 5; y < 45; y++) for (let x = 70; x < 103; x++) {
      const index = (y * first.width + x) * 4; after.data.set(first.data.slice(index, index + 4), index);
    }
    expect(trackIndicatorContext(model, after).tracked).toBe(false);
  });

  it("refuses mismatched dimensions and incomplete frame pixels", () => {
    const model = buildIndicatorContextModel(texture(), zone).model!;
    expect(trackIndicatorContext(model, { width: 80, height: 120, data: new Uint8ClampedArray(80 * 120 * 4) }).tracked).toBe(false);
    expect(trackIndicatorContext(model, { width: 160, height: 120, data: new Uint8ClampedArray(12) }).tracked).toBe(false);
  });
});

describe("marking-frame ownership", () => {
  it("binds the drawn region to the Mark snapshot even when the live cursor moves before Apply", () => {
    const video = fakeVideo(); setupCapture();
    const token = captureTrackedFinishIndicatorFrame(video);
    video.currentTime = 8.1; video.decodedRawTime = 8.1;

    const anchor = bindTrackedFinishIndicatorAnchor(token, zone);

    expect(anchor.rawTime).toBe(7);
    expect(anchor.cursorTime).toBe(7.01);
    expect(anchor.region).toEqual(zone);
    expect(isTrackedFinishIndicatorAnchorCurrent(video, anchor)).toBe(true);
    expect(Object.isFrozen(anchor.region)).toBe(true);
  });

  it("rejects a changed recording at Apply", () => {
    const video = fakeVideo(); setupCapture();
    const token = captureTrackedFinishIndicatorFrame(video); video.src = "blob:replacement";

    expect(() => bindTrackedFinishIndicatorAnchor(token, zone)).toThrow("changed recordings");
  });

  it("rejects a persisted bounding box masquerading as a temporal anchor", async () => {
    const video = fakeVideo();
    await expect(scanTrackedFinishIndicatorReview({ video, anchor: {
      rawTime: 7, cursorTime: 7.01, sourceFrameDurationSeconds: 1 / 30,
      sourceWidth: 160, sourceHeight: 120, region: zone,
    } })).rejects.toThrow("saved area has no tracking anchor");
    expect(seek).not.toHaveBeenCalled();
  });

  it("rejects a different decoder even when its URL matches", async () => {
    const video = fakeVideo(); setupCapture();
    const anchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);
    await expect(scanTrackedFinishIndicatorReview({ video: fakeVideo(), anchor })).rejects.toMatchObject({ name: "AbortError" });
    expect(seek).not.toHaveBeenCalled();
  });

  it("requires a paused native marking frame", () => {
    const video = fakeVideo(); setupCapture(); video.paused = false;
    expect(() => captureTrackedFinishIndicatorFrame(video)).toThrow("Pause");
    video.paused = true; vi.stubGlobal("VideoFrame", undefined);
    expect(() => captureTrackedFinishIndicatorFrame(video)).toThrow("Native frame timing");
  });

  it("never publishes a late result after source replacement during a seek", async () => {
    const video = fakeVideo(); setupCapture();
    const anchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);
    seek.mockImplementation(async () => { video.src = "blob:replacement"; return observation(video, 6.966667); });

    await expect(scanTrackedFinishIndicatorReview({ video, anchor })).rejects.toMatchObject({ name: "AbortError" });
    expect(seek).toHaveBeenCalledTimes(1);
  });

  it("checks abort and caller generation before reading another source frame", async () => {
    const video = fakeVideo(); setupCapture();
    const anchor: TrackedFinishIndicatorAnchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);
    const controller = new AbortController(); controller.abort();
    await expect(scanTrackedFinishIndicatorReview({ video, anchor, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(scanTrackedFinishIndicatorReview({ video, anchor, isCurrent: () => false })).rejects.toMatchObject({ name: "AbortError" });
    expect(seek).not.toHaveBeenCalled();
  });

  it("keeps a source-timed tracked transition navigation-only and excludes a lower-bound straddling frame", async () => {
    const video = fakeVideo(); video.duration = 7.6;
    setupCapture(source => sensorFrame(source.decodedRawTime)); setupSequentialSeeks();
    const anchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);

    const review = await scanTrackedFinishIndicatorReview({ video, anchor, startSignal: 2.4 });

    expect(review.status).toBe("complete");
    expect(review.suggestedRawTime).toBe(7);
    expect(review.result.detected).toBe(false);
    expect(review.confidence).toBe("Low");
    expect(review.automaticAcceptanceAllowed).toBe(false);
    expect(review.createsLaneIdentity).toBe(false);
    expect(review.result.candidates?.every(candidate => candidate.confidence === "Low")).toBe(true);
    expect(review.observations.every(sample => sample.rawTime >= review.requestedWindow.start && sample.rawTime <= review.requestedWindow.end)).toBe(true);
    expect(review.boundaryNotes).toHaveLength(1);
  }, 10_000);

  it("keeps only the contiguous anchored span when later surrounding context disappears", async () => {
    const video = fakeVideo(); video.duration = 7.6;
    setupCapture(source => source.decodedRawTime >= 7.1 ? texture(9911) : sensorFrame(source.decodedRawTime));
    setupSequentialSeeks();
    const anchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);

    const review = await scanTrackedFinishIndicatorReview({ video, anchor, startSignal: 2.4 });

    expect(review.status).toBe("partial");
    expect(review.stops.some(stop => stop.direction === 1)).toBe(true);
    expect(review.observations.every(sample => sample.rawTime < 7.1)).toBe(true);
    expect(review.result.detected).toBe(false);
    expect(review.result.candidates?.every(candidate => candidate.confidence === "Low")).toBe(true);
  }, 10_000);

  it("does not call skipped native intervals a contiguous track", async () => {
    const video = fakeVideo(); setupCapture();
    const anchor = bindTrackedFinishIndicatorAnchor(captureTrackedFinishIndicatorFrame(video), zone);
    seek.mockImplementation(async (_video, requested) => observation(video, requested < 7 ? 6.9 : 7.1));

    const review = await scanTrackedFinishIndicatorReview({ video, anchor });

    expect(review.status).toBe("failed");
    expect(review.observations).toHaveLength(1);
    expect(review.stops).toHaveLength(2);
    expect(review.stops.every(stop => stop.reason.includes("interval was skipped"))).toBe(true);
  });
});

function texture(seed = 173): IndicatorTrackingFrame {
  const width = 160, height = 120, data = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = 35 + state % 185; paint({ width, height, data }, x, y, 4, 4, [value, value, value]);
  }
  paint({ width, height, data }, 104, 48, 12, 10, [40, 180, 80]);
  return { width, height, data };
}
function paint(frame: IndicatorTrackingFrame, x: number, y: number, w: number, h: number, color: number[]) {
  for (let py = Math.max(0, y); py < Math.min(frame.height, y + h); py++) for (let px = Math.max(0, x); px < Math.min(frame.width, x + w); px++)
    frame.data.set([...color, 255], (py * frame.width + px) * 4);
}
function clone(frame: IndicatorTrackingFrame): IndicatorTrackingFrame { return { ...frame, data: frame.data.slice() }; }
function translate(frame: IndicatorTrackingFrame, dx: number, dy: number): IndicatorTrackingFrame {
  const moved = { ...frame, data: new Uint8ClampedArray(frame.data.length) };
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const tx = x + dx, ty = y + dy;
    if (tx >= 0 && tx < frame.width && ty >= 0 && ty < frame.height)
      moved.data.set(frame.data.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4), (ty * frame.width + tx) * 4);
  }
  return moved;
}
function fakeVideo() {
  return { src: "blob:original", currentTime: 7.01, decodedRawTime: 7, duration: 10,
    videoWidth: 160, videoHeight: 120, readyState: 2, paused: true, seeking: false } as unknown as HTMLVideoElement & { decodedRawTime: number; paused: boolean; duration: number };
}

const contextPatchCenters = [[80, 60], [160, 60], [240, 60], [80, 120], [240, 120], [80, 180], [160, 180], [240, 180]];
function separatedContextPatches(): IndicatorTrackingFrame {
  const width = 320, height = 240, data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set([80, 80, 80, 255], index);
  let state = 173;
  for (const [cx, cy] of contextPatchCenters) for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = 20 + state % 216;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
function observation(video: HTMLVideoElement, time: number) {
  return { requestedTime: time, cursorTime: time, decoded: { mediaTime: time, cursorTime: time,
    durationSeconds: 1 / 30, source: video.src, method: "video-frame" as const } };
}
function sensorFrame(time: number): IndicatorTrackingFrame {
  const frame = texture(); if (time >= 7) paint(frame, 104, 48, 12, 10, [190, 50, 45]); return frame;
}
function setupSequentialSeeks() {
  seek.mockImplementation(async (source: ReturnType<typeof fakeVideo>, requested: number) => {
    source.currentTime = requested; source.decodedRawTime = Math.round(Math.floor((requested + 1e-8) * 30) / 30 * 1e6) / 1e6;
    return { ...observation(source, source.decodedRawTime), requestedTime: requested, cursorTime: requested };
  });
}
function setupCapture(frameProvider?: (video: ReturnType<typeof fakeVideo>) => IndicatorTrackingFrame) {
  vi.stubGlobal("VideoFrame", class {
    timestamp: number; duration = Math.round(1e6 / 30);
    constructor(video: ReturnType<typeof fakeVideo>) { this.timestamp = Math.round(video.decodedRawTime * 1e6); }
    close() {}
  });
  vi.stubGlobal("document", { createElement: () => {
    let source: ReturnType<typeof fakeVideo>;
    return { width: 0, height: 0, getContext: () => ({ drawImage(video: ReturnType<typeof fakeVideo>) { source = video; },
      getImageData: () => ({ data: frameProvider ? frameProvider(source).data : texture().data }) }) };
  } });
}
