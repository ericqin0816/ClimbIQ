import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectFirstMovement } from "./detectFirstMovement";
import { detectMotionBasedStartEstimate } from "./detectMotionBasedStartEstimate";

const mocks = vi.hoisted(() => ({ seek: vi.fn(), capture: vi.fn() }));
vi.mock("./videoFrameSampler", async importOriginal => {
  const actual = await importOriginal<typeof import("./videoFrameSampler")>();
  return { ...actual, seekTo: mocks.seek, captureZoneImageData: mocks.capture };
});

describe("motion-based start cancellation", () => {
  function startOptions(signal?: AbortSignal) {
    return { ...options(signal), searchStart: 0, searchEnd: 12, reactionOffset: 0.2 };
  }

  it("does not scan a full search window after cancellation", async () => {
    const controller = new AbortController();
    mocks.seek.mockImplementationOnce(async () => { controller.abort(); });
    await expect(detectMotionBasedStartEstimate(startOptions(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.seek).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("propagates decoder aborts", async () => {
    const error = new Error("Video changed during decoded-frame readiness check.");
    error.name = "AbortError";
    mocks.seek.mockRejectedValueOnce(error);
    await expect(detectMotionBasedStartEstimate(startOptions())).rejects.toBe(error);
  });

  it("does not sample a replacement recording", async () => {
    mocks.seek.mockImplementationOnce(async (video: HTMLVideoElement) => { video.src = "blob:replacement"; });
    await expect(detectMotionBasedStartEstimate(startOptions())).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  mocks.seek.mockReset();
  mocks.capture.mockReset();
  mocks.seek.mockImplementation(async (video: HTMLVideoElement, time: number) => { video.currentTime = time; });
  mocks.capture.mockReturnValue({
    imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
    pixelZone: { x: 0, y: 0, width: 4, height: 4 },
  });
});

function options(signal?: AbortSignal) {
  return {
    video: { src: "blob:athlete", duration: 8, currentTime: 0, videoWidth: 100, videoHeight: 200 } as HTMLVideoElement,
    zone: { id: "startBody" as const, label: "Athlete", x1: 0.2, x2: 0.8, y1: 0.5, y2: 0.9 },
    startSignalRawTime: 2,
    sensitivity: "medium" as const,
    signal,
  };
}

describe("first-movement cancellation", () => {
  it("does not start seeking when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(detectFirstMovement(options(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("stops before capturing a frame if cancelled during the seek", async () => {
    const controller = new AbortController();
    mocks.seek.mockImplementationOnce(async () => { controller.abort(); });
    await expect(detectFirstMovement(options(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.seek).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not continue the remaining motion window after cancellation", async () => {
    const controller = new AbortController();
    mocks.capture.mockImplementationOnce(() => {
      controller.abort();
      return { imageData: { data: new Uint8ClampedArray(64) }, pixelZone: { x: 0, y: 0, width: 4, height: 4 } };
    });
    await expect(detectFirstMovement(options(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.seek).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("propagates an aborted decoder rather than presenting it as missing motion", async () => {
    const error = new Error("Video changed during decoded-frame readiness check.");
    error.name = "AbortError";
    mocks.seek.mockRejectedValueOnce(error);
    await expect(detectFirstMovement(options())).rejects.toBe(error);
  });

  it("refuses to publish motion from a replacement recording", async () => {
    mocks.seek.mockImplementationOnce(async (video: HTMLVideoElement) => { video.src = "blob:replacement"; });
    await expect(detectFirstMovement(options())).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("retains a diagnostic result for a genuine decode error", async () => {
    mocks.seek.mockRejectedValueOnce(new Error("Video seek timed out"));
    const result = await detectFirstMovement(options());
    expect(result.detected).toBe(false);
    expect(result.debug.failureReason).toContain("Video seek timed out");
  });
});
