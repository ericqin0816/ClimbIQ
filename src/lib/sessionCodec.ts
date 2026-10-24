import type { SavedAnalysisSession, TimestampMarker, VideoMetadata, NormalizedZone } from "../types";
import { sanitizeAttemptLineageId } from "./attemptIdentity";
import { sanitizeAnalysisSessionSettings } from "./analysisSettings";
import { sanitizeBiomechanicsSession } from "./biomechanicsSession";
import { sanitizeVideoMetadata, sanitizeZoneMap, sanitizeStartLightCalibration } from "./sessionEvidenceIntegrity";
import { sanitizeAcceptanceMode, sanitizeTimestampSequence } from "./timestampIntegrity";
import { sanitizeObservationInterval } from "./timingEvidence";
import { sanitizeAppBuildIdentity } from "./buildIdentity";

/** Legacy text fields may be absent, but recognized fields must have safe scalar types. */
interface SavedSessionInput {
  id: string;
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  climberName?: string | null;
  date?: string | null;
  location?: string | null;
  attemptType?: string | null;
  notes?: string | null;
  videoFileName?: string | null;
  attemptLineageId?: unknown;
  analysisBuild?: unknown;
  videoMetadata?: unknown;
  zones?: unknown;
  startLightCalibration?: unknown;
  settings: unknown;
  timestamps: unknown[];
  splitCalculations?: unknown;
  biomechanics?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function importedText(value: unknown, field: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`The imported ${field} must be text.`);
  return value;
}
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

export function isDatasetExport(value: unknown): value is Record<string, unknown> & { session: Record<string, unknown>; acceptedTimestamps: unknown[] } {
  return isRecord(value) && typeof value.appVersion === "string" && isRecord(value.session) && Array.isArray(value.acceptedTimestamps);
}

export function datasetToSavedSession(dataset: unknown): SavedAnalysisSession {
  if (!isDatasetExport(dataset)) throw new Error("This file is not a ClimbIQ dataset export.");
  const session = dataset.session;
  const video = isRecord(dataset.video) ? dataset.video : {};
  const zonesFromDataset = isRecord(dataset.zones) ? dataset.zones : {};
  const settings = isRecord(dataset.settings) ? dataset.settings : {};
  const calibration = isRecord(dataset.calibration) ? dataset.calibration : {};
  // Validate even fallback aliases: malformed text must never reach editable state.
  const sessionId = importedText(session.sessionId, "session ID");
  const name = importedText(session.sessionName, "session name");
  const climberName = importedText(session.climberName, "climber name");
  const date = importedText(session.date, "recording date");
  const location = importedText(session.location, "location");
  const gym = importedText(session.gym, "gym");
  const attemptType = importedText(session.attemptType, "attempt type");
  const notes = importedText(session.notes, "notes");
  const athleteNotes = importedText(dataset.athleteNotes, "athlete notes");
  const fileName = importedText(video.fileName, "video filename");
  const exportedAt = importedText(dataset.exportTimestamp, "export timestamp");
  const sanitizedSettings = sanitizeAnalysisSessionSettings({
    ...settings,
    officialTotalTime: video.officialTotalTime !== null && video.officialTotalTime !== undefined
      ? String(video.officialTotalTime)
      : settings.officialTotalTime,
  });
  const timestamps = timestampsFromDataset(dataset.acceptedTimestamps ?? [], Number(video.duration) || undefined);

  return {
    id: sessionId || createSessionId(),
    attemptLineageId: sanitizeAttemptLineageId(session.attemptLineageId),
    analysisBuild: sanitizeAppBuildIdentity(dataset.analysisBuild),
    version: 1,
    name: name || "Imported ClimbIQ session",
    climberName,
    date: date || todayDateString(),
    location: location || gym,
    attemptType: attemptType || "Training",
    notes: notes || athleteNotes,
    createdAt: exportedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    videoFileName: fileName,
    videoMetadata: fileName
      ? {
          fileName,
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
      finishIndicator: zonesFromDataset.finishIndicatorZone ?? undefined,
    }),
    startLightCalibration: sanitizeStartLightCalibration({
      beforeStartRGB: calibration.beforeStartRGB,
      afterStartRGB: calibration.afterStartRGB,
      calibrationFrameBeforeTime: calibration.calibrationFrameBeforeTime,
      calibrationFrameAfterTime: calibration.calibrationFrameAfterTime,
      colorDelta: calibration.colorDelta,
    }, Number(video.duration) || undefined),
    settings: sanitizedSettings,
    timestamps,
    splitCalculations: sanitizeSplitCalculations(dataset.splitCalculations),
    biomechanics: sanitizeBiomechanicsSession(dataset.biomechanics),
  };
}

export function timestampsFromDataset(values: unknown[], durationSeconds?: number): TimestampMarker[] {
  const next = INITIAL_TIMESTAMPS.map((item) => ({ ...item }));
  for (const value of values) {
    if (!isRecord(value)) continue;
    const markerId = value.markerId;
    const existing = next.find((item) => item.id === markerId);
    if (!existing) {
      continue;
    }
    existing.rawTime = typeof value.acceptedRawTime === "number" ? value.acceptedRawTime : null;
    existing.climbTime = typeof value.climbTime === "number" ? value.climbTime : null;
    existing.detectedRawTime = typeof value.detectedRawTime === "number" ? value.detectedRawTime : null;
    existing.offsetApplied = typeof value.offsetApplied === "number" ? value.offsetApplied : 0;
    // The sequence sanitizer validates detector labels, confidence, and notes.
    const evidence = mergeTimestampDefaults([{ ...value, id: markerId,
      source: value.source ?? "Not set", confidence: value.confidence ?? "None" }]).find(item => item.id === markerId)!;
    existing.source = evidence.source;
    existing.confidence = evidence.confidence;
    existing.note = typeof value.note === "string" ? value.note : "";
    existing.acceptanceMode = sanitizeAcceptanceMode(value.acceptanceMode);
    existing.observationIntervalSeconds = sanitizeObservationInterval(value.observationIntervalSeconds);
  }
  return sanitizeTimestampSequence(next, durationSeconds);
}

export function mergeTimestampDefaults(values: unknown[]) {
  return INITIAL_TIMESTAMPS.map((defaultMarker) => {
    const imported = values.find((item) => isRecord(item) && item.id === defaultMarker.id);
    return {
      ...defaultMarker,
      ...(isRecord(imported) ? imported : {}),
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

export function sanitizeSavedSession(session: SavedSessionInput): SavedAnalysisSession {
  if (!isSavedAnalysisSession(session)) throw new Error("This file contains malformed ClimbIQ session fields.");
  const videoMetadata = sanitizeVideoMetadata(session.videoMetadata);
  return {
    id: session.id,
    version: 1,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    climberName: session.climberName ?? "",
    date: session.date || todayDateString(),
    location: session.location ?? "",
    attemptType: session.attemptType ?? "Training",
    notes: session.notes ?? "",
    videoFileName: session.videoFileName ?? videoMetadata?.fileName,
    attemptLineageId: sanitizeAttemptLineageId(session.attemptLineageId),
    analysisBuild: sanitizeAppBuildIdentity(session.analysisBuild),
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
    splitCalculations: sanitizeSplitCalculations(session.splitCalculations),
  };
}

export function isSavedAnalysisSession(value: unknown): value is SavedSessionInput {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    ["climberName", "date", "location", "attemptType", "notes", "videoFileName"].every(field =>
      candidate[field] === undefined || candidate[field] === null || typeof candidate[field] === "string") &&
    Boolean(candidate.settings) &&
    Array.isArray(candidate.timestamps)
  );
}

function sanitizeSplitCalculations(value: unknown): Record<string, number | null> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Array<[string, number | null]> = [];
  for (const [key, seconds] of Object.entries(value)) {
    if (seconds === null || typeof seconds === "number" && Number.isFinite(seconds)) entries.push([key, seconds]);
  }
  return Object.fromEntries(entries);
}

export function createSessionId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function todayDateString(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
