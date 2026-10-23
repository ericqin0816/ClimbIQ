import type { BiomechanicsSession, NormalizedZone, StartLightCalibration, TimestampMarker } from "../types";
import { FINISH_LANE_HORIZONTAL_MARGIN, prepareFinishLaneCandidatePool } from "./finishLaneEvidence";
import { isLegacyAutomaticHold10Marker } from "./hold10MarkerPolicy";
import { startLaneId, type AnalysisLaneCandidate } from "./startLaneEvidence";
import { deriveAutomaticStartBodyZone } from "./startRegion";
import { clearMarkerTimestamp } from "./timestampIntegrity";

export const FINISH_LANE_SELECTION_REQUIRED = "Start is accepted. Start-light cues point to different climber regions, so automatic Finish, movement, and tracking are paused. In Manual lane setup, capture a Start frame and draw a Start Body Zone around your climber, then run analysis again; or review your climber's Finish manually.";
export const FINISH_LANE_CONTEXT_REQUIRED = "Start is accepted. Automatic Finish needs a new lane check after the recording, Start, or climber selection changed. Run automatic analysis again, or review your climber's Finish manually.";

interface FinishLaneIdentityOptions {
  lightZone?: NormalizedZone;
  lightCalibration?: StartLightCalibration;
  acceptedStart: number;
  laneCandidates: AnalysisLaneCandidate[];
  trustedBodyZone?: NormalizedZone;
  hasFreshLaneEvidence?: boolean;
}

/** Existing automatic body regions are compatibility bounds, not proof of
 * athlete identity. Shared clocks, scores and official totals cannot resolve
 * incompatible spatial hypotheses. User selection must actually exclude them.
 */
export function assessFinishLaneIdentity(options: FinishLaneIdentityOptions) {
  const pool = prepareFinishLaneCandidatePool(options.lightZone, options.lightCalibration,
    options.acceptedStart, options.laneCandidates, options.trustedBodyZone);
  const conflicts: Array<[string, string]> = [];
  for (let left = 0; left < pool.length; left++) for (let right = left + 1; right < pool.length; right++) {
    const a = pool[left], b = pool[right];
    const aRegion = deriveAutomaticStartBodyZone(a.zone), bRegion = deriveAutomaticStartBodyZone(b.zone);
    const aCenter = (a.zone.x1 + a.zone.x2) / 2, bCenter = (b.zone.x1 + b.zone.x2) / 2;
    const aContainsB = bCenter >= aRegion.x1 - FINISH_LANE_HORIZONTAL_MARGIN && bCenter <= aRegion.x2 + FINISH_LANE_HORIZONTAL_MARGIN;
    const bContainsA = aCenter >= bRegion.x1 - FINISH_LANE_HORIZONTAL_MARGIN && aCenter <= bRegion.x2 + FINISH_LANE_HORIZONTAL_MARGIN;
    // Pairwise and symmetric: an intermediate patch cannot bridge two lanes.
    if (!aContainsB || !bContainsA) conflicts.push([a.laneId ?? startLaneId(a.zone), b.laneId ?? startLaneId(b.zone)]);
  }
  const contextMissing = (options.lightZone?.label.startsWith("Auto-detected") || options.laneCandidates.length > 0) && options.hasFreshLaneEvidence !== true;
  const requiresAthleteSelection = Boolean(contextMissing || conflicts.length > 0);
  return { candidates: pool.slice(0, 3), pool, conflicts, requiresAthleteSelection,
    contextMissing: Boolean(contextMissing),
    reason: contextMissing ? FINISH_LANE_CONTEXT_REQUIRED : requiresAthleteSelection ? FINISH_LANE_SELECTION_REQUIRED : "" };
}

/** A successful scan can reorder actual discovery evidence; a manual sensor
 * setup does not become a discovered lane ledger merely by producing Finish.
 */
export function finishLaneEvidenceAfterScan(pool: AnalysisLaneCandidate[], selected: AnalysisLaneCandidate,
  hasFreshLaneEvidence: boolean): AnalysisLaneCandidate[] {
  return hasFreshLaneEvidence ? [selected, ...pool.filter(candidate => candidate !== selected)] : [];
}

/** A shared Start can remain valid while automatic athlete-specific markers
 * no longer have an attached lane. Keep deliberate user observations, including
 * entered manual times, without treating them as independently verified.
 */
export function clearAutomaticLaneDependentMarkers(timestamps: TimestampMarker[]): TimestampMarker[] {
  return timestamps.reduce((next, marker) => {
    if (marker.id === "startSignal") return next;
    const manual = marker.source === "Manual" && marker.acceptanceMode !== "automatic";
    const reviewed = marker.acceptanceMode === "frame-review";
    return (manual || reviewed) && !isLegacyAutomaticHold10Marker(marker)
      ? next : clearMarkerTimestamp(next, marker.id);
  }, timestamps);
}

/** Wall points drawn by the user remain editable; automatic geometry and all
 * computed athlete trajectories must be established for the selected lane.
 */
export function clearAutomaticLaneBiomechanics(current: BiomechanicsSession): BiomechanicsSession {
  return { ...current, result: undefined,
    calibration: current.calibration?.source === "automatic-approximate" ? undefined : current.calibration };
}
