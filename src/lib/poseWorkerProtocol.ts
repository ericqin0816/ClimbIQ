import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export const POSE_TRACKER_OPTIONS = {
  runningMode: "VIDEO" as const,
  numPoses: 2,
  minPoseDetectionConfidence: 0.2,
  minPosePresenceConfidence: 0.2,
  minTrackingConfidence: 0.25,
  outputSegmentationMasks: false,
};

export type PoseWorkerRequest =
  | { id: number; kind: "initialize"; model: Uint8Array; wasmBase: string }
  | { id: number; kind: "detect"; image: ImageBitmap; timestamp: number };

export type PoseWorkerResponse =
  | { id: number; kind: "ready" }
  | { id: number; kind: "landmarks"; landmarks: NormalizedLandmark[][] }
  | { id: number; kind: "error"; message: string };
