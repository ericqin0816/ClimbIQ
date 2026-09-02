import type { NormalizedZone, RGB, StartLightCalibration, VideoMetadata, ZoneId } from "../types";

const ZONE_LABELS: Record<ZoneId, string> = {
  startLight: "Start Light Zone",
  startBody: "Start Body Zone",
  hold10: "Hold 10 Zone",
  finishLight: "Finish Light Zone",
};
const ZONE_IDS = Object.keys(ZONE_LABELS) as ZoneId[];

export function sanitizeZoneMap(value: unknown): Partial<Record<ZoneId, NormalizedZone>> {
  if (!value || typeof value !== "object") return {};
  const candidate = value as Record<string, unknown>;
  const safe: Partial<Record<ZoneId, NormalizedZone>> = {};
  for (const id of ZONE_IDS) {
    const zone = sanitizeZone(candidate[id], id);
    if (zone) safe[id] = zone;
  }
  return safe;
}

export function sanitizeStartLightCalibration(
  value: unknown,
  videoDuration?: number,
): StartLightCalibration {
  if (!value || typeof value !== "object") return {};
  const candidate = value as Partial<StartLightCalibration>;
  const beforeStartRGB = sanitizeRgb(candidate.beforeStartRGB);
  const afterStartRGB = sanitizeRgb(candidate.afterStartRGB);
  const duration = Number.isFinite(videoDuration) && videoDuration! > 0 ? videoDuration : undefined;
  const calibrationFrameBeforeTime = sanitizeVideoTime(candidate.calibrationFrameBeforeTime, duration);
  const calibrationFrameAfterTime = sanitizeVideoTime(candidate.calibrationFrameAfterTime, duration);
  return {
    beforeStartRGB,
    afterStartRGB,
    colorDelta: beforeStartRGB && afterStartRGB ? rgbDistance(beforeStartRGB, afterStartRGB) : undefined,
    calibrationFrameBeforeTime,
    calibrationFrameAfterTime,
  };
}

export function sanitizeVideoMetadata(value: unknown): VideoMetadata | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<VideoMetadata>;
  if (typeof candidate.fileName !== "string" || !candidate.fileName.trim() ||
      !isFiniteNonNegative(candidate.duration) || candidate.duration! <= 0 ||
      !isFiniteNonNegative(candidate.videoWidth) || !isFiniteNonNegative(candidate.videoHeight)) {
    return null;
  }
  return {
    fileName: candidate.fileName.trim(),
    duration: candidate.duration!,
    videoWidth: Math.round(candidate.videoWidth!),
    videoHeight: Math.round(candidate.videoHeight!),
    // A persisted record never proves that a local HTMLVideoElement is loaded.
    metadataLoaded: false,
  };
}

function sanitizeZone(value: unknown, id: ZoneId): NormalizedZone | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<NormalizedZone>;
  const coordinates = [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
  if (!coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return undefined;
  }
  const x1 = clamp(Math.min(candidate.x1!, candidate.x2!), 0, 1);
  const x2 = clamp(Math.max(candidate.x1!, candidate.x2!), 0, 1);
  const y1 = clamp(Math.min(candidate.y1!, candidate.y2!), 0, 1);
  const y2 = clamp(Math.max(candidate.y1!, candidate.y2!), 0, 1);
  if (x2 - x1 <= 0.005 || y2 - y1 <= 0.005) return undefined;
  return { id, label: ZONE_LABELS[id], x1, y1, x2, y2 };
}

function sanitizeRgb(value: unknown): RGB | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RGB>;
  if (![candidate.r, candidate.g, candidate.b].every((channel) =>
    typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 255,
  )) return undefined;
  return { r: candidate.r!, g: candidate.g!, b: candidate.b! };
}

function sanitizeVideoTime(value: unknown, duration?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (duration !== undefined && value > duration + 0.001) return undefined;
  return value;
}

function rgbDistance(left: RGB, right: RGB): number {
  return Math.round(Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b) * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
