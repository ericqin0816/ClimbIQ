import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { POSE_TRACKER_OPTIONS, type PoseWorkerRequest, type PoseWorkerResponse } from "./poseWorkerProtocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerResponse): void;
};
let landmarker: PoseLandmarker | undefined;

scope.onmessage = async ({ data }) => {
  try {
    if (data.kind === "initialize") {
      if (landmarker) throw new Error("Pose worker has already been initialized.");
      // The module loader avoids importScripts, which cannot run in ESM workers.
      const vision = await FilesetResolver.forVisionTasks(data.wasmBase, true);
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        ...POSE_TRACKER_OPTIONS,
        canvas: new OffscreenCanvas(1, 1),
        baseOptions: { modelAssetBuffer: data.model, delegate: "CPU" },
      });
      scope.postMessage({ id: data.id, kind: "ready" });
    } else {
      try {
        if (!landmarker) throw new Error("Pose worker is not ready.");
        const landmarks = landmarker.detectForVideo(data.image, data.timestamp).landmarks;
        scope.postMessage({ id: data.id, kind: "landmarks", landmarks });
      } finally {
        data.image.close();
      }
    }
  } catch (error) {
    scope.postMessage({ id: data.id, kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
