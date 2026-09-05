export interface SourceSampleTiming {
  decodedFrameRawTime?: number;
  sourceFrameDurationSeconds?: number;
}

/** Preserve source-frame metadata only when it can contain this sampling cursor.
 * A valid interval is provenance, not independent evidence of event accuracy. */
export function sanitizeSourceSampleTiming(rawTime: number, value: SourceSampleTiming): SourceSampleTiming {
  const time = value.decodedFrameRawTime, duration = value.sourceFrameDurationSeconds;
  if (!Number.isFinite(rawTime) || typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > rawTime + 0.005 || rawTime - time > 0.5) return {};
  const validDuration = typeof duration === "number" && Number.isFinite(duration) && duration >= 0.0001 && duration <= 1 ? duration : undefined;
  if (validDuration !== undefined && rawTime - time > validDuration + 0.005) return {};
  return { decodedFrameRawTime: time, sourceFrameDurationSeconds: validDuration };
}

/** Repeated seeks into one decoded frame do not create independent hand samples. */
export function uniqueSourceFrameSamples<T extends SourceSampleTiming & { rawTime: number }>(frames: readonly T[]): T[] {
  const seen = new Set<string>();
  return frames.filter(frame => {
    const source = sanitizeSourceSampleTiming(frame.rawTime, frame).decodedFrameRawTime;
    const key = source === undefined ? `cursor:${frame.rawTime}` : `source:${source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarizeSourceSampleTiming(frames: readonly (SourceSampleTiming & { rawTime: number })[]) {
  const available = frames.map(frame => ({ rawTime: frame.rawTime, ...sanitizeSourceSampleTiming(frame.rawTime, frame) }))
    .filter(frame => frame.decodedFrameRawTime !== undefined);
  const durations = available.flatMap(frame => frame.sourceFrameDurationSeconds === undefined ? [] : [frame.sourceFrameDurationSeconds]);
  const unique = new Set(available.map(frame => frame.decodedFrameRawTime));
  return {
    sampledFrames: frames.length, nativeTimingFrames: available.length,
    uniqueNativeFrames: unique.size, repeatedNativeFrames: available.length - unique.size,
    maximumCursorOffsetSeconds: available.length ? Math.max(...available.map(frame => frame.rawTime - frame.decodedFrameRawTime!)) : null,
    minimumSourceFrameDurationSeconds: durations.length ? Math.min(...durations) : null,
    maximumSourceFrameDurationSeconds: durations.length ? Math.max(...durations) : null,
    isEventAccuracyBound: false as const,
  };
}
