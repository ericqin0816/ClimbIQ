export function adaptiveMotionThreshold(values: number[], fixedThreshold: number, dynamicAdd: number): number {
  if (!values.length) {
    return fixedThreshold;
  }
  const baseline = median(values);
  const deviation = median(values.map((value) => Math.abs(value - baseline)));
  return Math.max(fixedThreshold, baseline + dynamicAdd + deviation * 3);
}

export function causalSmoothMotion<T extends { motionScore: number; smoothedMotionScore: number }>(samples: T[]): void {
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.motionScore ?? samples[index].motionScore;
    const current = samples[index].motionScore;
    samples[index].smoothedMotionScore = roundMetric((previous + current * 2) / 3);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
