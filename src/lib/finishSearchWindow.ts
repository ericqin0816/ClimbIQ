export interface FinishSearchWindow {
  start: number;
  end: number;
}

/** Bounds automatic finish work to the current attempt instead of allowing a
 * later race or timing-system reset in a long recording to become evidence. */
export function resolveFinishSearchWindow(
  startSignalRawTime: number,
  videoDurationSeconds: number,
  minimumClimbSeconds = 3,
  maximumClimbSeconds = 30,
): FinishSearchWindow {
  const startSignal = Number.isFinite(startSignalRawTime) ? Math.max(0, startSignalRawTime) : 0;
  const duration = Number.isFinite(videoDurationSeconds) ? Math.max(0, videoDurationSeconds) : 0;
  const minimum = Number.isFinite(minimumClimbSeconds) ? Math.max(0, minimumClimbSeconds) : 3;
  const maximum = Number.isFinite(maximumClimbSeconds) && maximumClimbSeconds >= minimum
    ? maximumClimbSeconds
    : Math.max(minimum, 30);
  const start = startSignal + minimum;
  return {
    start,
    end: Math.max(start, Math.min(Math.max(0, duration - 0.04), startSignal + maximum)),
  };
}
