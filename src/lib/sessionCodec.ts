import type { SavedAnalysisSession, TimestampMarker, VideoMetadata, NormalizedZone } from "../types";
import { sanitizeAttemptLineageId } from "./attemptIdentity";
import { sanitizeAnalysisSessionSettings } from "./analysisSettings";
import { sanitizeBiomechanicsSession } from "./biomechanicsSession";
import { sanitizeVideoMetadata, sanitizeZoneMap, sanitizeStartLightCalibration } from "./sessionEvidenceIntegrity";
import { sanitizeAcceptanceMode, sanitizeTimestampSequence } from "./timestampIntegrity";
import { sanitizeObservationInterval } from "./timingEvidence";
export const INITIAL_TIMESTAMPS: TimestampMarker[] = [
  marker("startSignal", "Start Signal"),
  marker("firstMovement", "Earliest Visible Motion"),
  marker("committedLaunch", "Committed Launch"),
  marker("firstHold", "First Hold"),
  marker("hold10", "Hold 10"),
  marker("finishPad", "Finish Pad"),
];
export function marker(id: TimestampMarker["id"], label: string): TimestampMarker {
  return {
    id,
    label,
    rawTime: null,
    climbTime: null,
    source: "Not set",
    confidence: "None",
  };
}

export function getTimestamp(timestamps: TimestampMarker[], id: TimestampMarker["id"]) {
  return timestamps.find((item) => item.id === id) ?? marker(id, id);
}

export function isDatasetExport(value: unknown): value is any {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.appVersion === "string" && Boolean(candidate.session) && Boolean(candidate.acceptedTimestamps);
}

export function datasetToSavedSession(dataset: any): SavedAnalysisSession {
  const session = dataset.session ?? {};
  const video = dataset.video ?? {};
  const zonesFromDataset = dataset.zones ?? {};
  const settings = dataset.settings ?? {};
  const sanitizedSettings = sanitizeAnalysisSessionSettings({
    ...settings,
    officialTotalTime: video.officialTotalTime !== null && video.officialTotalTime !== undefined
      ? String(video.officialTotalTime)
      : settings.officialTotalTime,
  });
  const timestamps = timestampsFromDataset(dataset.acceptedTimestamps ?? [], Number(video.duration) || undefined);

  return {
    id: session.sessionId || createSessionId(),
    attemptLineageId: sanitizeAttemptLineageId(session.attemptLineageId),
    version: 1,
    name: session.sessionName || "Imported ClimbIQ session",
    climberName: session.climberName || "",
    date: session.date || todayDateString(),
    location: session.location || session.gym || "",
    attemptType: session.attemptType || "Training",
    notes: session.notes || dataset.athleteNotes || "",
    createdAt: dataset.exportTimestamp || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    videoFileName: video.fileName || "",
    videoMetadata: video.fileName
      ? {
          fileName: video.fileName,
          duration: Number(video.duration) || 0,
          videoWidth: Number(video.videoWidth) || 0,
          videoHeight: Number(video.videoHeight) || 0,
          metadataLoaded: false,
        }
      : null,
    zones: sanitizeZoneMap({
      startLight: zonesFromDataset.startLightZone ?? undefined,
      startBody: zonesFromDataset.startBodyZone ?? undefined,
      hold10: zonesFromDataset.hold10Zone ?? undefined,
      finishLight: zonesFromDataset.finishLightZone ?? undefined,
      finishPad: zonesFromDataset.finishPadZone ?? undefined,
    }),
    startLightCalibration: sanitizeStartLightCalibration({
      beforeStartRGB: dataset.calibration?.beforeStartRGB ?? undefined,
      afterStartRGB: dataset.calibration?.afterStartRGB ?? undefined,
      calibrationFrameBeforeTime: dataset.calibration?.calibrationFrameBeforeTime ?? undefined,
      calibrationFrameAfterTime: dataset.calibration?.calibrationFrameAfterTime ?? undefined,
      colorDelta: dataset.calibration?.colorDelta ?? undefined,
    }, Number(video.duration) || undefined),
    settings: sanitizedSettings,
    timestamps,
    splitCalculations: dataset.splitCalculations ?? {},
    biomechanics: sanitizeBiomechanicsSession(dataset.biomechanics),
  };
}

export function timestampsFromDataset(values: any[], durationSeconds?: number): TimestampMarker[] {
  const next = INITIAL_TIMESTAMPS.map((item) => ({ ...item }));
  for (const value of values) {
    const markerId = value.markerId as TimestampMarker["id"];
    const existing = next.find((item) => item.id === markerId);
    if (!existing) {
      continue;
    }
    existing.rawTime = typeof value.acceptedRawTime === "number" ? value.acceptedRawTime : null;
    existing.climbTime = typeof value.climbTime === "number" ? value.climbTime : null;
    existing.detectedRawTime = typeof value.detectedRawTime === "number" ? value.detectedRawTime : null;
    existing.offsetApplied = typeof value.offsetApplied === "number" ? value.offsetApplied : 0;
    existing.source = value.source ?? "Not set";
    existing.confidence = value.confidence ?? "None";
    existing.note = value.note ?? "";
    existing.acceptanceMode = sanitizeAcceptanceMode(value.acceptanceMode);
    existing.observationIntervalSeconds = sanitizeObservationInterval(value.observationIntervalSeconds);
  }
  return sanitizeTimestampSequence(next, durationSeconds);
}

export function mergeTimestampDefaults(values: TimestampMarker[]) {
  return INITIAL_TIMESTAMPS.map((defaultMarker) => {
    const imported = values.find((item) => item?.id === defaultMarker.id);
    return {
      ...defaultMarker,
      ...imported,
      id: defaultMarker.id,
      label: defaultMarker.label,
    };
  });
}

export function videoMetadataMatches(actual: VideoMetadata, expected: VideoMetadata): boolean {
  if (actual.fileName !== expected.fileName) {
    return false;
  }
  const dimensionsMatch = !expected.videoWidth || !expected.videoHeight ||
    (actual.videoWidth === expected.videoWidth && actual.videoHeight === expected.videoHeight);
  const durationTolerance = Math.max(0.1, Math.abs(expected.duration) * 0.005);
  const durationMatches = !expected.duration || Math.abs(actual.duration - expected.duration) <= durationTolerance;
  return dimensionsMatch && durationMatches;
}

export function timestampsFitVideo(markers: TimestampMarker[], duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && markers.every(marker => marker.rawTime === null ||
    typeof marker.rawTime === "number" && Number.isFinite(marker.rawTime) && marker.rawTime >= 0 && marker.rawTime <= duration);
}

export function normalizedZonesEqual(left?: NormalizedZone, right?: NormalizedZone): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.id === right.id &&
    Math.abs(left.x1 - right.x1) < 1e-6 &&
    Math.abs(left.y1 - right.y1) < 1e-6 &&
    Math.abs(left.x2 - right.x2) < 1e-6 &&
    Math.abs(left.y2 - right.y2) < 1e-6;
}

export function decodeSavedSession(value: unknown): SavedAnalysisSession | null {
  return isSavedAnalysisSession(value) ? sanitizeSavedSession(value) : null;
}

export function sanitizeSavedSession(session: SavedAnalysisSession): SavedAnalysisSession {
  const videoMetadata = sanitizeVideoMetadata(session.videoMetadata);
  return {
    ...session,
    attemptLineageId: sanitizeAttemptLineageId(session.attemptLineageId),
    videoMetadata,
    zones: sanitizeZoneMap(session.zones),
    startLightCalibration: sanitizeStartLightCalibration(
      session.startLightCalibration,
      videoMetadata?.duration,
    ),
    settings: sanitizeAnalysisSessionSettings(session.settings),
    timestamps: sanitizeTimestampSequence(
      mergeTimestampDefaults(session.timestamps),
      videoMetadata?.duration,
    ),
    biomechanics: sanitizeBiomechanicsSession(session.biomechanics),
  };
}

export function isSavedAnalysisSession(value: unknown): value is SavedAnalysisSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedAnalysisSession>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Boolean(candidate.settings) &&
    Array.isArray(candidate.timestamps)
  );
}

export function createSessionId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}
