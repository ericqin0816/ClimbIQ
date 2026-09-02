export interface OfficialFinishOptions {
  startRawTime: number;
  videoDuration: number;
  officialTotalSeconds?: number | null;
}

/** Returns an in-file finish boundary only when every official-time input is valid. */
export function resolveOfficialFinishRawTime({
  startRawTime,
  videoDuration,
  officialTotalSeconds,
}: OfficialFinishOptions): number | undefined {
  if (!Number.isFinite(startRawTime) || startRawTime < 0 ||
      !Number.isFinite(videoDuration) || videoDuration <= startRawTime ||
      !Number.isFinite(officialTotalSeconds) || officialTotalSeconds! <= 0) {
    return undefined;
  }
  const proposed = startRawTime + officialTotalSeconds!;
  if (proposed <= startRawTime + 0.001 || proposed > videoDuration + 0.001) {
    return undefined;
  }
  return Math.min(videoDuration, proposed);
}
