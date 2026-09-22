import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Capacitor } from "@capacitor/core";
import { POSE_TRACKER_OPTIONS } from "./poseWorkerProtocol";
import { createPoseWorkerClient } from "./poseWorkerClient";

export type PoseExecutionMode = "main-thread" | "worker" | "auto";
/** Build-time experiment/escape hatch, never a remote runtime configuration. */
export function configuredPoseExecutionMode(setting: string | undefined, native = Capacitor.isNativePlatform()): PoseExecutionMode {
  if (setting === "worker" || setting === "auto" || setting === "main-thread") return setting;
  // Keep the native runtime on its existing path until real iPhone verification.
  // Unknown explicit settings fail conservatively instead of enabling a worker.
  if (setting) return "main-thread";
  return native ? "main-thread" : "auto";
}
export interface PoseInferenceBackend {
  backend: "main-thread" | "worker";
  fallbackReason?: string;
  detect(canvas: HTMLCanvasElement, timestamp: number): Promise<NormalizedLandmark[][]>;
  close(): void;
}

export async function createPoseInference(model: Uint8Array, wasmBase: string, signal?: AbortSignal, mode: PoseExecutionMode = "main-thread"): Promise<PoseInferenceBackend> {
  if (signal?.aborted) throw new DOMException("Pose inference cancelled.", "AbortError");
  let fallbackReason: string | undefined;
  if (mode !== "main-thread") {
    if (typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
      let client: ReturnType<typeof createPoseWorkerClient> | undefined;
      try {
        const worker = new Worker(new URL("./poseInference.worker.ts", import.meta.url), { type: "module" });
        client = createPoseWorkerClient(worker, signal);
        const readyClient = client;
        const copy = model.slice();
        const ready = await client.request({ kind: "initialize", model: copy, wasmBase }, [copy.buffer]);
        if (ready.kind !== "ready") throw new Error("Pose worker returned an unexpected initialization response.");
        return {
          backend: "worker",
          async detect(canvas, timestamp) {
            const image = await createImageBitmap(canvas);
            try {
              const result = await readyClient.request({ kind: "detect", image, timestamp }, [image]);
              if (result.kind !== "landmarks") throw new Error("Pose worker returned an unexpected frame response.");
              return result.landmarks;
            } finally { image.close(); }
          },
          close: () => readyClient.close(),
        };
      } catch (error) {
        client?.close();
        if (signal?.aborted || mode === "worker") throw error;
        fallbackReason = error instanceof Error ? error.message : String(error);
      }
    } else {
      if (mode === "worker") throw new Error("Background pose inference is not supported by this browser.");
      fallbackReason = "Worker, OffscreenCanvas or ImageBitmap is unavailable.";
    }
  }
  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(wasmBase);
  if (signal?.aborted) throw new DOMException("Pose inference cancelled.", "AbortError");
  const landmarker = await PoseLandmarker.createFromOptions(vision, { ...POSE_TRACKER_OPTIONS, baseOptions: { modelAssetBuffer: model, delegate: "CPU" } });
  if (signal?.aborted) {
    landmarker.close();
    throw new DOMException("Pose inference cancelled.", "AbortError");
  }
  return { backend: "main-thread", fallbackReason, detect: async (canvas, timestamp) => landmarker.detectForVideo(canvas, timestamp).landmarks, close: () => landmarker.close() };
}
