import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedZone } from "../types";
import { scanGuidedFinishIndicator } from "./guidedFinishIndicator";

const { detect } = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("./detectTopFinishSignal", async importOriginal => ({
  ...await importOriginal<typeof import("./detectTopFinishSignal")>(), detectTopFinishSignal: detect,
}));
const zone: NormalizedZone = { id: "finishIndicator", label: "Finish Indicator Review Area", x1: .7, y1: .48, x2: .82, y2: .62 };
const outcome = () => ({ result: { detected: true, rawTime: 7, confidence: "High", reason: "Persistent authored transition", threshold: .16,
  candidates: [], debug: { zoneExists: true, framesSampled: 20, maxColorDistance: 100, threshold: .16, detectedCrossings: [], samples: [] } }, zone });
const video = () => ({ src: "blob:attempt-a", duration: 10 }) as HTMLVideoElement;
const options = (media: HTMLVideoElement, signal?: AbortSignal) => ({ video: media, zone, center: 7, start: 2.4, signal });
beforeEach(() => detect.mockReset());

describe("guided Finish scan lifecycle", () => {
  it("does no detector work after an already-cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(scanGuidedFinishIndicator(options(video(), controller.signal))).rejects.toThrow("cancelled");
    expect(detect).not.toHaveBeenCalled();
  });

  it("rejects a late completion after cancellation, then permits a fresh request", async () => {
    let release!: (value: ReturnType<typeof outcome>) => void;
    detect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const media = video(), controller = new AbortController();
    const pending = scanGuidedFinishIndicator(options(media, controller.signal));
    await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
    controller.abort(); release(outcome());
    await expect(pending).rejects.toThrow("cancelled");
    detect.mockResolvedValueOnce(outcome());
    const retry = await scanGuidedFinishIndicator(options(media));
    expect(retry.rawTime).toBeUndefined();
    expect(retry).toMatchObject({ detected: false, confidence: "Low" });
    expect(retry.candidates?.[0].rawTime).toBe(7);
    expect(retry.reason).toContain("Manually selected indicator; frame review required");
  });

  it("rejects a result owned by a replaced source", async () => {
    let release!: (value: ReturnType<typeof outcome>) => void;
    detect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const media = video();
    const pending = scanGuidedFinishIndicator(options(media));
    await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
    media.src = "blob:attempt-b"; release(outcome());
    await expect(pending).rejects.toThrow("cancelled");
    detect.mockResolvedValueOnce(outcome());
    await expect(scanGuidedFinishIndicator(options(media))).resolves.toMatchObject({ detected: false, confidence: "Low", candidates: [{ rawTime: 7 }] });
  });

  it("does not reinterpret a marked physical pad as an indicator", async () => {
    await expect(scanGuidedFinishIndicator({ ...options(video()), zone: { ...zone, id: "finishPad" } })).rejects.toThrow("Mark the finish indicator");
    expect(detect).not.toHaveBeenCalled();
  });
});
