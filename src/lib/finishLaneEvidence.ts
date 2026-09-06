import type { NormalizedZone, StartLightCalibration } from "../types";
import { deduplicateAnalysisLaneCandidates, startLaneId, type AnalysisLaneCandidate } from "./startLaneEvidence";

/** Build the same evidence pool for Quick Analyze and the manual Finish action.
 * The fused clock bounds timing; it must not overwrite a patch's observed cue.
 */
export function prepareFinishLaneCandidates(
  lightZone: NormalizedZone | undefined,
  lightCalibration: StartLightCalibration | undefined,
  acceptedStart: number,
  laneCandidates: AnalysisLaneCandidate[],
  trustedBodyZone?: NormalizedZone,
): AnalysisLaneCandidate[] {
  const existing = lightZone ? laneCandidates.find(candidate => startLaneId(candidate.zone) === startLaneId(lightZone)) : undefined;
  const primary: AnalysisLaneCandidate[] = lightZone ? [{
    ...existing, laneId: startLaneId(lightZone), zone: lightZone,
    calibration: lightCalibration ?? existing?.calibration ?? {},
    label: "selected lane light", startRawTime: existing?.startRawTime ?? acceptedStart,
    score: Number.MAX_SAFE_INTEGER,
  }] : [];
  const permitted = [...primary, ...laneCandidates].filter(candidate => {
    if (!trustedBodyZone) return true;
    const center = (candidate.zone.x1 + candidate.zone.x2) / 2;
    return center >= trustedBodyZone.x1 - 0.035 && center <= trustedBodyZone.x2 + 0.035;
  });
  return deduplicateAnalysisLaneCandidates(permitted).slice(0, 3);
}
