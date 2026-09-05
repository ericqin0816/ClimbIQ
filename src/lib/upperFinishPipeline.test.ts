import { afterEach, describe, expect, it, vi } from "vitest";
import { detectTopFinishSignal } from "./detectTopFinishSignal";

afterEach(() => vi.unstubAllGlobals());

describe("upper finish discovery-to-refinement pipeline", () => {
  it.each([true, false])("retains the tiny light through capture with official cross-check=%s", async (official) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const video = Object.assign(new EventTarget(), {
      videoWidth: 20, videoHeight: 20, duration: 5, readyState: 2, seeking: false,
    }) as unknown as HTMLVideoElement;
    let cursor = 0;
    Object.defineProperty(video, "currentTime", {
      get: () => cursor,
      set: (value: number) => { cursor = value; queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); },
    });
    vi.stubGlobal("document", {
      createElement: () => {
        let sourceX = 0; let sourceY = 0;
        return { width: 0, height: 0, getContext: () => ({
          drawImage: (_video: HTMLVideoElement, ...args: number[]) => {
            // Both production capture forms are exercised: full discovery
            // frames and the native-resolution crop used by temporal sampling.
            sourceX = args.length === 8 ? args[0] : 0;
            sourceY = args.length === 8 ? args[1] : 0;
          },
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const inLight = x + sourceX >= 12 && x + sourceX <= 13 && y + sourceY >= 2 && y + sourceY <= 3;
                const color = inLight ? (cursor < 1.6 ? [88, 24, 23] : [34, 142, 48]) : [54, 55, 57];
                data.set([...color, 255], (y * width + x) * 4);
              }
            }
            return { width, height, data };
          },
        }) };
      },
    });
    const outcome = await detectTopFinishSignal({ video, startSignalRawTime: 0,
      minimumClimbSeconds: 0, expectedFinishTime: official ? 1.6 : undefined });
    expect(outcome.result.debug.detectionMethod).toBe("Perspective-aware upper finish-indicator discovery and refinement");
    if (official) {
      expect(outcome.result.detected).toBe(true);
      expect(outcome.result.rawTime).toBeCloseTo(1.6, 3);
      expect(outcome.result.confidence).toBe("High");
    } else {
      expect(outcome.result.detected).toBe(false);
      expect(outcome.result.rawTime).toBeUndefined();
      expect(outcome.result.candidates?.[0].rawTime).toBeCloseTo(1.6, 3);
    }
  });
});
