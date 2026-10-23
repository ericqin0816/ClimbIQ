import { afterEach, describe, expect, it, vi } from "vitest";
import { detectTopFinishSignal } from "./detectTopFinishSignal";

afterEach(() => vi.unstubAllGlobals());

describe("upper finish discovery-to-refinement pipeline", () => {
  it.each([
    { official: true, rejectRefinement: false, nativeFps: undefined, eventTime: 1.6 },
    { official: false, rejectRefinement: false, nativeFps: undefined, eventTime: 1.6 },
    { official: true, rejectRefinement: true, nativeFps: undefined, eventTime: 1.6 },
    { official: true, rejectRefinement: false, nativeFps: 30, eventTime: 49 / 30 },
    { official: true, rejectRefinement: false, nativeFps: 10, eventTime: 1.7 },
    { official: true, rejectRefinement: false, nativeFps: 30, eventTime: 49 / 30, dropNativeTiming: true },
    { official: true, rejectRefinement: false, nativeFps: undefined, eventTime: 1.6, unlocalized: true },
    { official: false, rejectRefinement: false, nativeFps: undefined, eventTime: 1.6, unlocalized: true },
  ])("checks upper evidence with official=$official, rejected refinement=$rejectRefinement, source fps=$nativeFps, native failure=$dropNativeTiming, unlocalized=$unlocalized", async ({ official, rejectRefinement, nativeFps, eventTime, dropNativeTiming, unlocalized }) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const video = Object.assign(new EventTarget(), {
      src: "blob:upper-finish", videoWidth: 20, videoHeight: 20, duration: 5, readyState: 2, seeking: false,
    }) as unknown as HTMLVideoElement;
    let cursor = 0;
    Object.defineProperty(video, "currentTime", {
      get: () => cursor,
      set: (value: number) => { cursor = value; queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); },
    });
    const sourceTime = () => nativeFps ? Math.floor((cursor + 1e-9) * nativeFps) / nativeFps : cursor;
    vi.stubGlobal("VideoFrame", nativeFps ? class {
      timestamp = Math.round(sourceTime() * 1e6);
      duration = Math.round(1e6 / nativeFps!);
      close() {}
    } : undefined);
    let refinementSamples = 0;
    let refinementCrops = 0;
    vi.stubGlobal("document", {
      createElement: () => {
        let sourceX = 0; let sourceY = 0;
        return { width: 0, height: 0, getContext: () => ({
          clearRect() {},
          drawImage: (_video: HTMLVideoElement, ...args: number[]) => {
            // Both production capture forms are exercised: full discovery
            // frames and the native-resolution crop used by temporal sampling.
            sourceX = args.length === 8 ? args[0] : 0;
            sourceY = args.length === 8 ? args[1] : 0;
            if (args.length === 8) refinementCrops += 1;
          },
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            if (sourceX > 0 && dropNativeTiming && ++refinementSamples > 2) vi.stubGlobal("VideoFrame", undefined);
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const inLight = x + sourceX >= 12 && x + sourceX <= 13 && y + sourceY >= 2 && y + sourceY <= 3;
                const sourceState = sourceTime() < eventTime || (rejectRefinement && sourceX > 0);
                const background = unlocalized ? [192, 193, 184] : [54, 55, 57];
                const color = inLight ? (sourceState ? [88, 24, 23] : unlocalized ? background : [34, 142, 48]) : background;
                data.set([...color, 255], (y * width + x) * 4);
              }
            }
            return { width, height, data };
          },
        }) };
      },
    });
    const analysis = detectTopFinishSignal({ video, startSignalRawTime: 0,
      minimumClimbSeconds: 0, expectedFinishTime: official ? eventTime : undefined });
    if (dropNativeTiming) {
      await expect(analysis).rejects.toThrow("timing became unavailable");
      return;
    }
    const outcome = await analysis;
    if (unlocalized) {
      // An agreeing entered total cannot turn a disappearing red object into
      // an electronic cue, nor may a fine crop hide the missing surroundings.
      expect(outcome.result.detected).toBe(false);
      expect(outcome.result.rawTime).toBeUndefined();
      expect(outcome.result.confidence).toBe("Low");
      expect(outcome.result.reason).toContain("official total cannot verify an unlocalized visual cue");
      expect(outcome.result.candidates?.[0].rawTime).toBe(1.6);
      expect(outcome.result.candidates?.every(candidate => candidate.confidence === "Low")).toBe(true);
      expect(outcome.result.debug.selectedCandidateTime).toBeUndefined();
      expect(refinementCrops).toBe(0);
    } else if (rejectRefinement) {
      // An entered total is a cross-check, not a substitute for the missing
      // fine visual verification. Preserve only a coarse review suggestion.
      expect(outcome.result.confidence).toBe("Medium");
      expect(outcome.result.reason).toContain("finer scan did not confirm");
      expect(outcome.result.candidates?.every(candidate => candidate.confidence !== "High")).toBe(true);
    } else if (official) {
      expect(outcome.result.debug.detectionMethod).toBe("Perspective-aware upper finish-indicator discovery and refinement");
      expect(outcome.result.detected).toBe(true);
      expect(outcome.result.rawTime).toBeCloseTo(eventTime, 3);
      expect(outcome.result.confidence).toBe("High");
      if (nativeFps) {
        expect(outcome.result.observationIntervalSeconds).toBeCloseTo(1 / nativeFps, 3);
        expect(outcome.result.debug.samples.every(sample => sample.timestampMethod === "video-frame")).toBe(true);
        expect(new Set(outcome.result.debug.samples.map(sample => sample.time)).size).toBe(outcome.result.debug.samples.length);
      } else {
        expect(outcome.result.observationIntervalSeconds).toBeUndefined();
        expect(outcome.result.debug.samples.every(sample => sample.timestampMethod === "seek-cursor")).toBe(true);
      }
    } else {
      expect(outcome.result.detected).toBe(false);
      expect(outcome.result.rawTime).toBeUndefined();
      expect(outcome.result.candidates?.[0].rawTime).toBeCloseTo(1.6, 3);
    }
  });
});
