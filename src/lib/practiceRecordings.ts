import reference from "../../public/samples/reference.json" with { type: "json" };
import type { SavedAnalysisSession } from "../types";
import { INITIAL_TIMESTAMPS, createSessionId, todayDateString } from "./sessionCodec";
import { sanitizeAnalysisSessionSettings } from "./analysisSettings";

export type PracticeId = "a" | "b";
export const practiceRecordings = reference.attempts;

export function practiceIdForLineage(lineage: string | null): PracticeId | null {
  return lineage === "climbiq-practice-v1-a" ? "a" : lineage === "climbiq-practice-v1-b" ? "b" : null;
}

export function createPracticeSession(id: PracticeId, now = new Date()): SavedAnalysisSession {
  const entry = practiceRecordings.find(item => item.id === id)!;
  const savedAt = now.toISOString();
  const times = { startSignal: entry.start, hold10: entry.hold10, finishPad: entry.finish };
  return {
    id: createSessionId(), attemptLineageId: `climbiq-practice-v1-${id}`, version: 1,
    name: `Practice ${id.toUpperCase()} · synthetic`, climberName: "Synthetic climber", date: todayDateString(now),
    location: "Synthetic practice wall", attemptType: "Practice", notes: reference.referenceMethod,
    createdAt: savedAt, updatedAt: savedAt, videoFileName: entry.file,
    videoMetadata: { fileName: entry.file, duration: reference.duration, videoWidth: reference.width, videoHeight: reference.height, metadataLoaded: true },
    settings: sanitizeAnalysisSessionSettings({ startSearchEnd: reference.duration }), zones: {}, startLightCalibration: {},
    timestamps: INITIAL_TIMESTAMPS.map(marker => {
      const time = times[marker.id as keyof typeof times];
      return typeof time !== "number" ? { ...marker } : { ...marker, rawTime: time, climbTime: time - entry.start,
        source: "Manual", confidence: "High", acceptanceMode: "manual-entry", observationIntervalSeconds: 1 / reference.fps,
        note: "Authored synthetic reference. Not independently human-reviewed; inspect the animation before accepting a frame." };
    }),
  };
}
