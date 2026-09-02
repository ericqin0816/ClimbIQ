import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  Confidence,
  PoseLandmarkPoint,
  WallCalibration,
} from "../types";
import { getStandardSpeedHold } from "./standardSpeedRoute";
import { projectImagePointToWall, SPEED_WALL_HEIGHT_METERS, validateWallCalibration } from "./wallCalibration";

export interface Hold10HeightEstimate {
  detected: boolean;
  rawTime?: number;
  climbTime?: number;
  confidence: Confidence;
  hand?: "left" | "right";
  reason: string;
}

const HAND_POINTS = {
  left: [15, 17, 19, 21],
  right: [16, 18, 20, 22],
} as const;

/**
 * Review-only fallback for locating the Hold 10 portion of a climb when route
 * registration cannot identify the hold center. It requires a continuous hand
 * crossing of Hold 10's standardized height; it never claims actual contact or
 * writes an accepted marker automatically because horizontal hold identity is
 * unknown.
 */
export function estimateHold10HeightPassage(
  result: BiomechanicsResult,
  calibration: WallCalibration | undefined,
): Hold10HeightEstimate {
  const validation = validateWallCalibration(calibration);
  if (!calibration || !validation.valid || !validation.matrix) {
    return unavailable("A valid wall calibration is required for a Hold 10 height estimate.");
  }
  const targetHeight = getStandardSpeedHold(10).wall.yMeters;
  const frames = [...result.frames]
    // poseSelected was added after the first saved-session format. Undefined
    // remains compatible when usable landmarks are present; explicit false is
    // still rejected.
    .filter((frame) => frame.poseSelected !== false && frame.landmarks.length && Number.isFinite(frame.rawTime))
    .sort((left, right) => left.rawTime - right.rawTime);

  // Use the higher visible hand on each frame. At 5 fps the climber can move
  // one hand through the target height and have only the other hand visible on
  // the next sample. Athlete-level continuity is sufficient for this
  // review-only estimate; it still does not claim contact with the hold.
  const observations = frames.flatMap((frame) => {
    const left = robustHandHeight(frame, HAND_POINTS.left, validation.matrix!);
    const right = robustHandHeight(frame, HAND_POINTS.right, validation.matrix!);
    if (left === undefined && right === undefined) return [];
    const hand = right === undefined || (left !== undefined && left >= right) ? "left" as const : "right" as const;
    return [{ rawTime: frame.rawTime, height: hand === "left" ? left! : right!, hand }];
  });
  let selected: { hand: "left" | "right"; rawTime: number } | undefined;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    const gap = current.rawTime - previous.rawTime;
    if (gap <= 0 || gap > 0.25) continue;
    if (previous.height > targetHeight - 0.18 || current.height < targetHeight) continue;
    const confirmation = observations.slice(index, index + 3)
      .filter((sample) => sample.rawTime - current.rawTime <= 0.3 && sample.height >= targetHeight - 0.12);
    if (confirmation.length < 2) continue;
    const rise = current.height - previous.height;
    const amount = rise > 1e-6 ? (targetHeight - previous.height) / rise : 1;
    selected = {
      hand: current.hand,
      rawTime: roundTime(previous.rawTime + gap * clamp(amount, 0, 1)),
    };
    break;
  }
  if (!selected) {
    return unavailable("No continuous tracked hand crossing of Hold 10 height was observed. ClimbIQ will not guess across a tracking gap.");
  }
  return {
    detected: true,
    rawTime: selected.rawTime,
    climbTime: roundTime(selected.rawTime - result.startRawTime),
    confidence: "Low",
    hand: selected.hand,
    reason: `${selected.hand === "left" ? "Left" : "Right"} hand crossed the standardized Hold 10 height continuously. Review the frame to confirm contact with the actual hold.`,
  };
}

function robustHandHeight(
  frame: BiomechanicsFrame,
  indices: readonly number[],
  matrix: NonNullable<ReturnType<typeof validateWallCalibration>["matrix"]>,
): number | undefined {
  const byIndex = new Map(frame.landmarks.map((landmark) => [landmark.index, landmark]));
  const points = indices
    .map((index) => byIndex.get(index))
    .filter((landmark): landmark is PoseLandmarkPoint => Boolean(
      landmark && landmark.visibility >= 0.35 && Number.isFinite(landmark.x) && Number.isFinite(landmark.y),
    ))
    .flatMap((landmark) => {
      try {
        return [projectImagePointToWall(landmark, matrix).yMeters];
      } catch {
        return [];
      }
    })
    .filter((height) => Number.isFinite(height) && height >= -0.5 && height <= SPEED_WALL_HEIGHT_METERS + 0.5)
    .sort((left, right) => left - right);
  if (points.length < 2) return undefined;
  // The upper median represents the contacting finger cluster while resisting
  // one wildly misplaced landmark.
  return points[Math.floor(points.length * 0.65)];
}

function unavailable(reason: string): Hold10HeightEstimate {
  return { detected: false, confidence: "None", reason };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}
