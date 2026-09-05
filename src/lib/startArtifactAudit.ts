import type { NormalizedZone } from "../types";
import { assessSceneContinuity, type CameraStabilityFrame } from "./cameraStability";

/** Screen graphics and a camera cut are not independent start-light votes. */
export function assessStartLightArtifacts(before: CameraStabilityFrame, after: CameraStabilityFrame,
  zone: NormalizedZone | undefined, automatic = true) {
  const scene = assessSceneContinuity(before, after);
  const edgeContextMissing = Boolean(automatic && zone && before.width > before.height && (zone.y1 + zone.y2) / 2 >= 0.94);
  const possibleOverlay = Boolean(edgeContextMissing && zone &&
    darkHorizontalSupport(before, (zone.y1 + zone.y2) / 2) >= 0.55 &&
    darkHorizontalSupport(after, (zone.y1 + zone.y2) / 2) >= 0.55);
  const reason = !scene.assessable || !scene.continuous ? scene.reason
    : possibleOverlay ? "This automatic patch sits in a broad dark band at the lower screen edge, which may be broadcast graphics. It cannot supply a strong start-light vote."
      : edgeContextMissing ? "This automatic patch is in the bottom 6% of a landscape frame, with too little context to distinguish a sensor from clothing or graphics. It requires review and cannot establish the start clock."
      : "The start-light patch passed camera-cut and lower-screen overlay checks.";
  return { usableForAutomaticVote: scene.assessable && scene.continuous && !edgeContextMissing, possibleOverlay, edgeContextMissing, scene, reason };
}

function darkHorizontalSupport(frame: CameraStabilityFrame, centerY: number): number {
  if (!Number.isFinite(centerY) || centerY < 0 || centerY > 1 || frame.width < 32 || frame.height < 24 ||
      frame.data.length < frame.width * frame.height * 4) return 0;
  let dark = 0, count = 0;
  for (let row = -2; row <= 2; row++) {
    const y = Math.max(0, Math.min(frame.height - 1, Math.round((centerY + row * 0.003) * (frame.height - 1))));
    for (let column = 0; column < 96; column++) {
      const x = Math.round((column + 0.5) / 96 * (frame.width - 1));
      const offset = (y * frame.width + x) * 4;
      const luminance = frame.data[offset] * 0.2126 + frame.data[offset + 1] * 0.7152 + frame.data[offset + 2] * 0.0722;
      if (luminance < 80) dark++;
      count++;
    }
  }
  return dark / count;
}
