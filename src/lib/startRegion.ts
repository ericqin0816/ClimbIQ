import type { NormalizedZone } from "../types";

/**
 * Converts a lower-wall lane-light location into a lane-local body region. This
 * keeps foreground walkers in the opposite/central lane from dominating motion
 * while still covering the climber's hands, hips, and feet at the start.
 */
export function deriveAutomaticStartBodyZone(lightZone: NormalizedZone): NormalizedZone {
  const centerX = (lightZone.x1 + lightZone.x2) / 2;
  const centerY = (lightZone.y1 + lightZone.y2) / 2;
  const rightLane = centerX >= 0.5;
  return {
    id: "startBody",
    label: "Automatic lane start-body region",
    x1: rightLane ? Math.max(0.5, centerX - 0.2) : Math.max(0, centerX - 0.23),
    x2: rightLane ? Math.min(1, centerX + 0.23) : Math.min(0.5, centerX + 0.2),
    y1: Math.max(0.42, centerY - 0.34),
    // The detected light is often a diffuse blue spill overlapping the
    // athlete's feet. Stop the body region just above that centroid so the
    // electronic light change cannot masquerade as first body movement.
    y2: Math.min(0.9, Math.max(0.74, centerY - 0.025)),
  };
}

/**
 * Keeps a user-selected body zone authoritative and derives an automatic zone
 * only from a lane-light cue that survived start-evidence fusion.
 */
export function resolveAnalysisBodyZone(
  trustedBodyZone: NormalizedZone | undefined,
  supportedLightZone: NormalizedZone | undefined,
): NormalizedZone | undefined {
  return trustedBodyZone ??
    (supportedLightZone ? deriveAutomaticStartBodyZone(supportedLightZone) : undefined);
}
