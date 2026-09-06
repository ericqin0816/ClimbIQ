import type { NormalizedZone, PoseLandmarkPoint } from "../types";
import type { TopFinishFrame } from "./detectTopFinishSignal";

export interface FinishTargetCandidate {
  zone: NormalizedZone;
  observations: number;
  spanSeconds: number;
  score: number;
}
export interface PadHandSample {
  rawTime: number;
  nativeTimed: boolean;
  landmarks: PoseLandmarkPoint[];
}
export interface PadHandEvidence {
  found: boolean;
  rawTime?: number;
  hand?: "left" | "right";
  observationIntervalSeconds?: number;
  supportFrames: number;
  reason: string;
}

/** Finds persistent compact green/blue upper-wall targets, not verified pads.
 * Red displays, white lamps, moving objects and isolated pixels cannot qualify.
 * Geometry and later hand approach still need inspection in the source video.
 */
export function locateFinishTargets(
  frames: TopFinishFrame[],
  laneHintX?: number,
): FinishTargetCandidate[] {
  if (
    frames.length < 3 ||
    !validFrames(frames) ||
    laneHintX === undefined ||
    !Number.isFinite(laneHintX) ||
    laneHintX < 0 ||
    laneHintX > 1
  )
    return [];
  const { width, height } = frames[0];
  const tracks: Array<{ boxes: NormalizedZone[]; times: number[] }> = [];
  for (const frame of frames) {
    const mask = new Uint8Array(width * height);
    for (let y = Math.ceil(height * 0.015); y < height * 0.35; y++)
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4,
          r = frame.data[i],
          g = frame.data[i + 1],
          b = frame.data[i + 2];
        const peak = Math.max(g, b);
        if (
          peak >= 55 &&
          peak - Math.max(r, Math.min(g, b)) >= 16 &&
          (peak - Math.min(r, g, b)) / Math.max(peak, 1) >= 0.22
        )
          mask[y * width + x] = 1;
      }
    for (const component of components(mask, width, height)) {
      const w = component.x2 - component.x1 + 1,
        h = component.y2 - component.y1 + 1;
      if (
        component.count < 3 ||
        w < 2 ||
        h < 1 ||
        w / h < 1.1 ||
        w / h > 8 ||
        w / width < 0.006 ||
        w / width > 0.075 ||
        h / height > 0.035 ||
        component.count / (w * h) < 0.35
      )
        continue;
      const zone: NormalizedZone = {
        id: "finishPad",
        label: "Automatic finish-target candidate",
        x1: component.x1 / width,
        y1: component.y1 / height,
        x2: (component.x2 + 1) / width,
        y2: (component.y2 + 1) / height,
      };
      const cx = (zone.x1 + zone.x2) / 2,
        cy = (zone.y1 + zone.y2) / 2;
      const track = tracks.find((t) => {
        // Anchor to the first observation so slowly moving objects cannot
        // accumulate support by hopping between neighboring positions.
        const last = t.boxes[0];
        return (
          Math.hypot(
            cx - (last.x1 + last.x2) / 2,
            cy - (last.y1 + last.y2) / 2,
          ) < 0.012
        );
      });
      if (track && !track.times.includes(frame.time)) {
        track.boxes.push(zone);
        track.times.push(frame.time);
      } else if (!track) tracks.push({ boxes: [zone], times: [frame.time] });
    }
  }
  let candidates = tracks
    .filter(
      (t) =>
        t.times.length >= 3 &&
        Math.max(...t.times) - Math.min(...t.times) >= 0.4,
    )
    .map((t) => ({
      zone: {
        ...t.boxes[0],
        x1: median(t.boxes.map((z) => z.x1)),
        x2: median(t.boxes.map((z) => z.x2)),
        y1: median(t.boxes.map((z) => z.y1)),
        y2: median(t.boxes.map((z) => z.y2)),
      },
      observations: t.times.length,
      spanSeconds: Math.max(...t.times) - Math.min(...t.times),
      score: t.times.length,
    }));
  // Select a side only when two separated targets provide an ordering cue.
  // Four-lane broadcasts and ambiguous target groups stay outside this fallback.
  candidates = candidates
    .sort((a, b) => b.score - a.score)
    .filter(
      (candidate, index, all) =>
        !all
          .slice(0, index)
          .some(
            (other) =>
              Math.hypot(
                centerX(candidate.zone) - centerX(other.zone),
                centerY(candidate.zone) - centerY(other.zone),
              ) < 0.035,
          ),
    );
  if (candidates.length > 2) return [];
  if (candidates.length === 2 && laneHintX !== undefined) {
    candidates.sort((a, b) => centerX(a.zone) - centerX(b.zone));
    if (centerX(candidates[1].zone) - centerX(candidates[0].zone) < 0.12)
      return [];
    return [candidates[laneHintX >= 0.5 ? 1 : 0]];
  }
  return candidates.filter(
    (candidate) =>
      laneHintX !== undefined &&
      Math.abs(centerX(candidate.zone) - laneHintX) <= 0.3,
  );
}

/** Earliest upward foreground approach to the target, not the highest later
 * belay position. Only proposes a short window for hand inspection. */
export function locatePadApproach(
  frames: TopFinishFrame[],
  pad: NormalizedZone,
): number | undefined {
  if (frames.length < 7 || !validFrames(frames) || !validTarget(pad))
    return undefined;
  frames = frames
    .filter(
      (frame, index, all) =>
        all.findIndex((other) => other.time === frame.time) === index,
    )
    .sort((a, b) => a.time - b.time);
  const { width, height } = frames[0],
    cx = centerX(pad),
    cy = centerY(pad);
  const x1 = Math.max(0, Math.floor((cx - 0.14) * width)),
    x2 = Math.min(width - 1, Math.ceil((cx + 0.14) * width));
  const y1 = Math.max(0, Math.floor((cy - 0.015) * height)),
    y2 = Math.min(height - 1, Math.ceil((cy + 0.25) * height));
  const reference = new Uint8Array(width * height * 3);
  const references = frames
    .filter((_, i) => i % Math.max(1, Math.floor(frames.length / 9)) === 0)
    .slice(0, 9);
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      for (let c = 0; c < 3; c++) {
        const p = y * width + x;
        reference[p * 3 + c] = median(references.map((f) => f.data[p * 4 + c]));
      }
  const observations: Array<{
    time: number;
    top: number;
    x: number;
    area: number;
  }> = [];
  for (const frame of frames) {
    const mask = new Uint8Array(width * height);
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) {
        const p = y * width + x;
        if (
          x / width >= pad.x1 - 0.015 &&
          x / width <= pad.x2 + 0.015 &&
          y / height <= pad.y2 + 0.015
        )
          continue;
        const change =
          (Math.abs(frame.data[p * 4] - reference[p * 3]) +
            Math.abs(frame.data[p * 4 + 1] - reference[p * 3 + 1]) +
            Math.abs(frame.data[p * 4 + 2] - reference[p * 3 + 2])) /
          3;
        if (change >= 28) mask[p] = 1;
      }
    const area = (x2 - x1 + 1) * (y2 - y1 + 1);
    for (const c of components(mask, width, height)) {
      if (
        c.count < 8 ||
        c.count / area > 0.32 ||
        c.x2 - c.x1 < 2 ||
        c.y2 - c.y1 < 3
      )
        continue;
      observations.push({
        time: frame.time,
        top: c.y1 / height,
        x: (c.x1 + c.x2) / 2 / width,
        area: c.count,
      });
    }
  }
  for (const point of observations) {
    if (point.top > cy + 0.035 || Math.abs(point.x - cx) > 0.1) continue;
    const before = observations.filter(
      (p) =>
        p.time < point.time &&
        p.time >= point.time - 1.8 &&
        Math.abs(p.x - point.x) < 0.07 &&
        p.area >= point.area * 0.3 &&
        p.area <= point.area * 3,
    );
    if (
      new Set(before.map((p) => p.time)).size >= 3 &&
      point.time - before[0].time >= 0.4 &&
      before.some((p) => p.top > point.top + 0.04)
    )
      return point.time;
  }
  return undefined;
}

/** Hand proximity is review evidence, never proof of a press or an automatic clock. */
export function assessPadHandApproach(
  samples: PadHandSample[],
  pad: NormalizedZone,
): PadHandEvidence {
  if (!validTarget(pad))
    return {
      found: false,
      supportFrames: 0,
      reason: "Invalid finish-target geometry.",
    };
  const unique = samples
    .filter(
      (sample, index, all) =>
        Number.isFinite(sample.rawTime) &&
        sample.rawTime >= 0 &&
        !all
          .slice(0, index)
          .some((previous) => previous.rawTime === sample.rawTime),
    )
    .sort((a, b) => a.rawTime - b.rawTime);
  const cx = centerX(pad),
    cy = centerY(pad),
    rx = Math.max(0.014, (pad.x2 - pad.x1) / 2 + 0.008),
    ry = Math.max(0.012, (pad.y2 - pad.y1) / 2 + 0.008);
  for (const hand of ["left", "right"] as const) {
    const indexes = hand === "left" ? [15, 17, 19, 21] : [16, 18, 20, 22];
    const points = unique.map((sample) => {
      const torso = [11, 12, 23, 24]
        .map((i) => sample.landmarks.find((p) => p.index === i))
        .filter(usable);
      const fingers = indexes
        .slice(1)
        .map((i) => sample.landmarks.find((p) => p.index === i))
        .filter(usable);
      const wrist = sample.landmarks.find((p) => p.index === indexes[0]);
      const hs = fingers.length >= 2 ? fingers : usable(wrist) ? [wrist] : [];
      if (torso.length < 3 || !hs.length) return undefined;
      const tx = median(torso.map((p) => p.x)),
        ty = median(torso.map((p) => p.y));
      const span =
        Math.max(...torso.map((p) => p.y)) - Math.min(...torso.map((p) => p.y));
      if (
        Math.abs(tx - cx) > 0.1 ||
        ty < cy - 0.01 ||
        ty > cy + 0.2 ||
        span < 0.008 ||
        span > 0.16
      )
        return undefined;
      const x = median(hs.map((p) => p.x)),
        y = median(hs.map((p) => p.y));
      return {
        sample,
        x,
        y,
        tx,
        ty,
        distance: Math.hypot((x - cx) / rx, (y - cy) / ry),
      };
    });
    for (let i = 1; i < points.length; i++) {
      const p = points[i],
        next = points[i + 1];
      if (
        !p ||
        !next ||
        p.distance > 1.15 ||
        next.distance > 1.4 ||
        next.sample.rawTime - p.sample.rawTime > 0.15
      )
        continue;
      const before = points
        .slice(0, i)
        .filter((q): q is NonNullable<typeof q> =>
          Boolean(q && p.sample.rawTime - q.sample.rawTime <= 0.8),
        );
      const sequence = [...before, p, next];
      if (
        before.length < 3 ||
        p.sample.rawTime - before[0].sample.rawTime < 0.18 ||
        !before.some((q) => q.distance >= 2 && q.y > p.y + 0.018)
      )
        continue;
      if (
        sequence
          .slice(1)
          .some(
            (q, j) =>
              q.sample.rawTime - sequence[j].sample.rawTime > 0.2 ||
              Math.hypot(q.tx - sequence[j].tx, q.ty - sequence[j].ty) >
                0.055 ||
              Math.hypot(q.x - sequence[j].x, q.y - sequence[j].y) > 0.08,
          )
      )
        continue;
      return {
        found: true,
        rawTime: p.sample.rawTime,
        hand,
        observationIntervalSeconds: Math.max(
          ...sequence
            .slice(1)
            .map((q, j) => q.sample.rawTime - sequence[j].sample.rawTime),
        ),
        supportFrames: sequence.length,
        reason:
          "A tracked hand approached the automatic target from below and remained nearby on successive frames. Review visible contact; proximity does not verify a pad press.",
      };
    }
  }
  return {
    found: false,
    supportFrames: 0,
    reason:
      "The target did not have a continuous, reliable hand approach. No contact time was established.",
  };
}

function usable(
  point: PoseLandmarkPoint | undefined,
): point is PoseLandmarkPoint {
  return Boolean(
    point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1 &&
      (point.visibility ?? 0) >= 0.35,
  );
}
function validFrames(frames: TopFinishFrame[]) {
  const { width, height } = frames[0];
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 24 &&
    height >= 24 &&
    frames.every(
      (f) =>
        f.width === width &&
        f.height === height &&
        Number.isFinite(f.time) &&
        f.time >= 0 &&
        f.data.length === width * height * 4,
    )
  );
}
function validTarget(z: NormalizedZone) {
  return (
    [z.x1, z.x2, z.y1, z.y2].every(Number.isFinite) &&
    z.x1 >= 0 &&
    z.y1 >= 0 &&
    z.x2 <= 1 &&
    z.y2 <= 1 &&
    z.x2 > z.x1 &&
    z.y2 > z.y1
  );
}
function centerX(z: NormalizedZone) {
  return (z.x1 + z.x2) / 2;
}
function centerY(z: NormalizedZone) {
  return (z.y1 + z.y2) / 2;
}
function median(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? 0;
}
function components(mask: Uint8Array, width: number, height: number) {
  const found: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    count: number;
  }> = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    mask[start] = 0;
    const queue = [start];
    let x1 = width,
      y1 = height,
      x2 = 0,
      y2 = 0;
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i],
        x = p % width,
        y = Math.floor(p / width);
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ])
        if (
          nx >= 0 &&
          nx < width &&
          ny >= 0 &&
          ny < height &&
          mask[ny * width + nx]
        ) {
          mask[ny * width + nx] = 0;
          queue.push(ny * width + nx);
        }
    }
    found.push({ x1, y1, x2, y2, count: queue.length });
  }
  return found;
}
