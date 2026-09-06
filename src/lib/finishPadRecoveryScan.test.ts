import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanAutomaticFinishPad } from "./finishPadRecoveryScan";

const mocks = vi.hoisted(() => ({
  targets: vi.fn(),
  approach: vi.fn(),
  continuity: vi.fn(),
  review: vi.fn(),
  seek: vi.fn(),
  model: vi.fn(),
}));
vi.mock("./finishPadRecovery", () => ({
  locateFinishTargets: mocks.targets,
  locatePadApproach: mocks.approach,
  assessPadHandApproach: vi.fn(),
}));
vi.mock("./cameraStability", () => ({
  assessSceneContinuity: mocks.continuity,
}));
vi.mock("./finishReview", () => ({ scanFinishPadReview: mocks.review }));
vi.mock("./poseAnalysis", () => ({ loadVerifiedModel: mocks.model }));
vi.mock("./videoFrameSampler", () => ({
  seekTo: mocks.seek,
  sampleFramesInRange: () => [4, 4.5, 5, 5.5, 6, 6.5, 7, 8],
}));
vi.mock("./decodedVideoFrame", () => ({
  readDecodedVideoFrameTime: (video: HTMLVideoElement) => ({
    mediaTime: video.currentTime,
  }),
}));
const target = {
  id: "finishPad" as const,
  label: "Automatic finish-target candidate",
  x1: 0.5,
  x2: 0.53,
  y1: 0.1,
  y2: 0.12,
};
const lane = { ...target, id: "startLight" as const, y1: 0.8, y2: 0.82 };
let video: HTMLVideoElement;
beforeEach(() => {
  vi.clearAllMocks();
  video = {
    src: "blob:test",
    duration: 20,
    videoWidth: 200,
    videoHeight: 200,
    currentTime: 0,
  } as HTMLVideoElement;
  mocks.seek.mockImplementation(async (v: HTMLVideoElement, time: number) => {
    v.currentTime = time;
  });
  mocks.targets.mockReturnValue([
    { zone: target, observations: 5, spanSeconds: 3, score: 5 },
  ]);
  mocks.approach.mockReturnValue(6);
  mocks.continuity.mockReturnValue({ continuous: true });
  mocks.review.mockResolvedValue({
    start: 5.5,
    end: 8,
    frames: [],
    reason: "review only",
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(200 * 200 * 4) }),
      }),
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("bounded automatic finish review", () => {
  it("returns separate, transient review evidence without loading the hand model or accepting timing", async () => {
    const result = await scanAutomaticFinishPad({
      video,
      startRawTime: 1,
      laneHintZone: lane,
    });
    expect(result.target).toEqual(target);
    expect(result.review?.start).toBe(5.5);
    expect(result.samples).toEqual([]);
    expect(result).not.toHaveProperty("accepted");
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({
        center: 6.75,
        overview: true,
        areaLabel: "automatic target",
      }),
    );
    expect(
      mocks.seek.mock.calls.every(([, time]) => time >= 4 && time < 20),
    ).toBe(true);
  });
  it("stops early if no unique target exists", async () => {
    mocks.targets.mockReturnValue([]);
    const result = await scanAutomaticFinishPad({
      video,
      startRawTime: 1,
      laneHintZone: lane,
    });
    expect(result.target).toBeUndefined();
    expect(mocks.seek).toHaveBeenCalledTimes(9);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("does not inspect a window after a scene discontinuity", async () => {
    mocks.continuity.mockReturnValue({ continuous: false });
    const result = await scanAutomaticFinishPad({
      video,
      startRawTime: 1,
      laneHintZone: lane,
    });
    expect(result.review).toBeUndefined();
    expect(result.reason).toContain("continuity");
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("does not invent a hand window without an approach", async () => {
    mocks.approach.mockReturnValue(undefined);
    expect(
      (
        await scanAutomaticFinishPad({
          video,
          startRawTime: 1,
          laneHintZone: lane,
        })
      ).review,
    ).toBeUndefined();
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it.each([NaN, -1, 19])(
    "rejects invalid or out-of-range Starts: %s",
    async (startRawTime) => {
      expect(
        (
          await scanAutomaticFinishPad({
            video,
            startRawTime,
            laneHintZone: lane,
          })
        ).target,
      ).toBeUndefined();
      expect(mocks.seek).not.toHaveBeenCalled();
    },
  );
  it("honors cancellation before seeking", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanAutomaticFinishPad({
        video,
        startRawTime: 1,
        laneHintZone: lane,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(mocks.seek).not.toHaveBeenCalled();
  });
  it("refuses to publish evidence when the source changes during a seek", async () => {
    mocks.seek.mockImplementationOnce(async () => {
      video.src = "blob:replacement";
    });
    await expect(
      scanAutomaticFinishPad({ video, startRawTime: 1, laneHintZone: lane }),
    ).rejects.toThrow("cancelled");
    expect(mocks.targets).not.toHaveBeenCalled();
  });
  it("checks cancellation after the final review scan", async () => {
    const controller = new AbortController();
    mocks.review.mockImplementationOnce(async () => {
      controller.abort();
      return {};
    });
    await expect(
      scanAutomaticFinishPad({
        video,
        startRawTime: 1,
        laneHintZone: lane,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});
