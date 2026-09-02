import type { Confidence, TimestampMarker, TimestampSource } from "../types";

export interface TimestampAcceptanceOptions {
  id: TimestampMarker["id"];
  rawTime: number;
  source: TimestampSource;
  confidence: Confidence;
  durationSeconds?: number;
  detectedRawTime?: number;
  offsetApplied?: number;
  note?: string;
}

export interface TimestampAcceptanceResult {
  accepted: boolean;
  timestamps: TimestampMarker[];
  reason?: string;
}

export function applyTimestampAcceptance(
  timestamps: TimestampMarker[],
  options: TimestampAcceptanceOptions,
): TimestampAcceptanceResult {
  if (!Number.isFinite(options.rawTime) || options.rawTime < 0) {
    return rejected(timestamps, "Timestamp must be a finite, non-negative raw-video time.");
  }
  if (Number.isFinite(options.durationSeconds) && options.rawTime > options.durationSeconds! + 0.001) {
    return rejected(timestamps, "Timestamp cannot be after the end of the loaded video.");
  }
  if (!timestamps.some((marker) => marker.id === options.id)) {
    return rejected(timestamps, `Timestamp marker ${options.id} does not exist.`);
  }

  const roundedRawTime = roundTime(options.rawTime);
  const startRawTime = getMarker(timestamps, "startSignal")?.rawTime ?? null;
  const finishRawTime = getMarker(timestamps, "finishPad")?.rawTime ?? null;
  if (options.id !== "startSignal" && startRawTime === null) {
    return rejected(timestamps, "Set Start Signal before accepting a derived timing marker.");
  }
  if (options.id !== "startSignal" && roundedRawTime < startRawTime! - 0.001) {
    return rejected(timestamps, "A climb marker cannot occur before the accepted Start Signal.");
  }
  if (options.id === "finishPad" && roundedRawTime <= startRawTime! + 0.001) {
    return rejected(timestamps, "Finish must occur after the accepted Start Signal.");
  }
  if (options.id !== "startSignal" && options.id !== "finishPad" && finishRawTime !== null &&
      roundedRawTime >= finishRawTime - 0.001) {
    return rejected(timestamps, "This marker must occur before the accepted Finish Pad time.");
  }

  let next = timestamps.map((marker) => ({ ...marker }));
  if (options.id === "startSignal") {
    // Every other marker was detected or interpreted relative to the previous
    // start/lane and must be re-established.
    next = next.map((marker) => marker.id === "startSignal" ? marker : clearMarker(marker));
  } else if (options.id === "finishPad") {
    // Correcting the finish earlier invalidates any derived marker that now
    // lies at or after the end of the climb.
    next = next.map((marker) => marker.id !== "startSignal" && marker.id !== "finishPad" &&
      marker.rawTime !== null && marker.rawTime >= roundedRawTime - 0.001
      ? clearMarker(marker)
      : marker);
  }

  next = next.map((marker) => marker.id === options.id
    ? {
        ...marker,
        rawTime: roundedRawTime,
        climbTime: options.id === "startSignal" ? 0 : marker.climbTime,
        detectedRawTime: options.detectedRawTime ?? options.rawTime,
        offsetApplied: options.offsetApplied ?? 0,
        note: options.note,
        source: options.source,
        confidence: options.confidence,
      }
    : marker);
  return { accepted: true, timestamps: recalculateTimestampClimbs(next) };
}

export function clearMarkerTimestamp(
  timestamps: TimestampMarker[],
  id: TimestampMarker["id"],
): TimestampMarker[] {
  return recalculateTimestampClimbs(timestamps.map((marker) =>
    id === "startSignal" || marker.id === id ? clearMarker(marker) : { ...marker },
  ));
}

/** Runtime guard for local/session JSON created by older versions or edited by
 * hand. Invalid ordering is cleared instead of becoming a negative split. */
export function sanitizeTimestampSequence(
  timestamps: TimestampMarker[],
  durationSeconds?: number,
): TimestampMarker[] {
  let next = timestamps.map((marker) => ({ ...marker }));
  const durationValid = Number.isFinite(durationSeconds) && durationSeconds! > 0;
  const rawIsValid = (rawTime: number | null) => rawTime === null || (
    Number.isFinite(rawTime) && rawTime >= 0 && (!durationValid || rawTime <= durationSeconds! + 0.001)
  );
  next = next.map((marker) => rawIsValid(marker.rawTime) ? sanitizeEvidenceLabels(marker) : clearMarker(marker));
  const start = getMarker(next, "startSignal");
  if (!start || start.rawTime === null) {
    return next.map(clearMarker);
  }
  const finish = getMarker(next, "finishPad");
  if (finish?.rawTime !== null && finish?.rawTime !== undefined && finish.rawTime <= start.rawTime + 0.001) {
    next = next.map((marker) => marker.id === "finishPad" ? clearMarker(marker) : marker);
  }
  const validFinish = getMarker(next, "finishPad")?.rawTime ?? null;
  next = next.map((marker) => {
    if (marker.id === "startSignal" || marker.rawTime === null) return marker;
    if (marker.rawTime < start.rawTime! - 0.001) return clearMarker(marker);
    if (marker.id !== "finishPad" && validFinish !== null && marker.rawTime >= validFinish - 0.001) {
      return clearMarker(marker);
    }
    return marker;
  });
  return recalculateTimestampClimbs(next);
}

export function recalculateTimestampClimbs(timestamps: TimestampMarker[]): TimestampMarker[] {
  const startRaw = getMarker(timestamps, "startSignal")?.rawTime ?? null;
  return timestamps.map((marker) => {
    if (marker.rawTime === null) return { ...marker, climbTime: null };
    if (marker.id === "startSignal") return { ...marker, climbTime: 0 };
    return {
      ...marker,
      climbTime: startRaw === null ? null : roundTime(marker.rawTime - startRaw),
    };
  });
}

function clearMarker(marker: TimestampMarker): TimestampMarker {
  return {
    ...marker,
    rawTime: null,
    climbTime: null,
    detectedRawTime: undefined,
    offsetApplied: undefined,
    note: undefined,
    source: "Not set",
    confidence: "None",
  };
}

function sanitizeEvidenceLabels(marker: TimestampMarker): TimestampMarker {
  const sources: TimestampSource[] = [
    "Not set", "Manual", "Start light detection", "Fused start detection", "Motion-based estimate",
    "Body motion detection", "Finish light detection", "Official total time", "COM halfway estimate",
    "Hold contact detection", "Future / experimental",
  ];
  const confidences: Confidence[] = ["High", "Medium", "Low", "None"];
  return {
    ...marker,
    source: sources.includes(marker.source) ? marker.source : marker.rawTime === null ? "Not set" : "Manual",
    confidence: confidences.includes(marker.confidence) ? marker.confidence : marker.rawTime === null ? "None" : "Low",
  };
}

function getMarker(timestamps: TimestampMarker[], id: TimestampMarker["id"]): TimestampMarker | undefined {
  return timestamps.find((marker) => marker.id === id);
}

function rejected(timestamps: TimestampMarker[], reason: string): TimestampAcceptanceResult {
  return { accepted: false, timestamps, reason };
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}
