import type { NormalizedZone, StartSignalDetectionResult } from "../types";
import { finishReviewWindow } from "./finishReview";

/** A manually selected sensor is distinct from a pad and an automatic region. */
export function normalizeFinishIndicatorZone(value: Pick<NormalizedZone, "x1" | "y1" | "x2" | "y2">): NormalizedZone | undefined {
  const coordinates = [value.x1, value.y1, value.x2, value.y2];
  if (coordinates.some(number => !Number.isFinite(number) || number < 0 || number > 1)) return undefined;
  const x1 = Math.min(value.x1, value.x2), x2 = Math.max(value.x1, value.x2);
  const y1 = Math.min(value.y1, value.y2), y2 = Math.max(value.y1, value.y2);
  if (x2 - x1 <= .005 || y2 - y1 <= .005 || (x2 - x1) * (y2 - y1) > .25) return undefined;
  return { id: "finishIndicator", label: "Finish Indicator Review Area", x1, y1, x2, y2 };
}

export function guidedIndicatorSearchWindow(center: number, duration: number, start: number) {
  const window = finishReviewWindow(center, duration, start);
  if (!window || center <= start || window.end - window.start < .8) return undefined;
  return { ...window, minimumClimbSeconds: window.start - start, maximumClimbSeconds: window.end - start };
}

/** Navigation evidence only. Callers must never auto-accept this guided result. */
export async function scanGuidedFinishIndicator(options: {
  video: HTMLVideoElement; zone: NormalizedZone; center: number; start: number;
  signal?: AbortSignal; onProgress?: (message: string) => void;
}): Promise<StartSignalDetectionResult> {
  const { video, signal } = options;
  const zone = normalizeFinishIndicatorZone(options.zone);
  const window = guidedIndicatorSearchWindow(options.center, video.duration, options.start);
  if (options.zone.id !== "finishIndicator" || !zone || !window) {
    throw new Error("Mark the finish indicator and choose a nearby review frame after Start.");
  }
  const source = video.src;
  const check = () => {
    if (signal?.aborted || video.src !== source) throw new Error("Finish indicator scan cancelled. Accepted timing was kept.");
  };
  check();
  const { detectTopFinishSignal, asMarkedFinishIndicatorReview } = await import("./detectTopFinishSignal");
  check();
  const outcome = await detectTopFinishSignal({ video, startSignalRawTime: options.start,
    indicatorZone: zone, minimumClimbSeconds: window.minimumClimbSeconds,
    maximumClimbSeconds: window.maximumClimbSeconds, signal,
    onProgress: (phase, processed, total) => options.onProgress?.(
      `${phase === "coarse" ? "Inspecting marked indicator" : "Refining indicator change"}: ${processed}/${total} frames…`),
  });
  check();
  return asMarkedFinishIndicatorReview(outcome).result;
}
