import type { PointerEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  BiomechanicsSession,
  NormalizedPoint,
  NormalizedZone,
  VideoMetadata,
  WallCalibration,
} from "../types";
import { isTrajectoryFrameExcluded } from "../lib/biomechanics";
import { analyzePoseVideo, PoseAnalysisCancelledError, type PoseAnalysisProgress } from "../lib/poseAnalysis";
import { selectBiomechanicsResultCoveringRange } from "../lib/biomechanicsFreshness";
import {
  trimBiomechanicsResultAtFinish,
  type BiomechanicsFinishCutoff,
} from "../lib/biomechanicsFinish";
import { captureFrame, clamp, roundTime } from "../lib/videoFrameSampler";
import {
  buildWallCalibration,
  validateWallCalibration,
  WALL_CORNER_TEMPLATE,
} from "../lib/wallCalibration";
import {
  analyzeRouteSplits,
  type RouteSectionSplit,
  type RouteSplitAnalysis,
} from "../lib/routeSplits";
import { projectStandardSpeedRouteToImage } from "../lib/standardSpeedRoute";
import type { AlignedRouteHold, RouteAlignmentResult } from "../lib/routeAlignment";

interface BiomechanicsPanelProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  metadata: VideoMetadata | null;
  currentTime: number;
  startRawTime: number | null;
  finishRawTime: number | null;
  fallbackFinishRawTime?: number | null;
  identityZone?: NormalizedZone;
  session: BiomechanicsSession;
  displayResult?: BiomechanicsResult;
  finishCutoff?: BiomechanicsFinishCutoff;
  analysisBlocked: boolean;
  onSessionChange: (session: BiomechanicsSession) => void;
  onRunningChange: (running: boolean) => void;
  onJump: (time: number) => void;
  runVideoTask: <T>(taskName: string, work: () => Promise<T>, completeMessage: string) => Promise<T>;
  onLocateRoute?: (
    startRawTime: number,
    endRawTime: number,
    calibration: WallCalibration,
    signal?: AbortSignal,
  ) => Promise<RouteAlignmentResult>;
}

const SKELETON_CONNECTIONS: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [27, 29], [29, 31], [24, 26], [26, 28], [28, 30], [30, 32],
];

export function BiomechanicsPanel({
  videoRef,
  metadata,
  currentTime,
  startRawTime,
  finishRawTime,
  fallbackFinishRawTime,
  identityZone,
  session,
  displayResult,
  finishCutoff,
  analysisBlocked,
  onSessionChange,
  onRunningChange,
  onJump,
  runVideoTask,
  onLocateRoute,
}: BiomechanicsPanelProps) {
  const [calibrationFrame, setCalibrationFrame] = useState<string | null>(null);
  const [calibrationFrameTime, setCalibrationFrameTime] = useState(0);
  const [draftPoints, setDraftPoints] = useState<NormalizedPoint[]>([]);
  const [staticCameraConfirmed, setStaticCameraConfirmed] = useState(
    session.calibration?.staticCameraConfirmed ?? false,
  );
  const [rangeStart, setRangeStart] = useState(startRawTime ?? 0);
  const [rangeEnd, setRangeEnd] = useState(
    finishRawTime ?? fallbackFinishRawTime ?? metadata?.duration ?? 0,
  );
  const [progress, setProgress] = useState<PoseAnalysisProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [showCalibrationEditor, setShowCalibrationEditor] = useState(!session.calibration);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const identityZoneRef = useRef(identityZone);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (startRawTime !== null) {
      setRangeStart(startRawTime);
    }
  }, [startRawTime]);

  useEffect(() => {
    const inferredEnd = finishRawTime ?? fallbackFinishRawTime;
    if (inferredEnd !== null && inferredEnd !== undefined) {
      setRangeEnd(metadata?.duration ? Math.min(inferredEnd, metadata.duration) : inferredEnd);
    } else if (metadata?.duration) {
      setRangeEnd(metadata.duration);
    }
  }, [finishRawTime, fallbackFinishRawTime, metadata?.duration]);

  useEffect(() => {
    setStaticCameraConfirmed(session.calibration?.staticCameraConfirmed ?? false);
  }, [session.calibration?.staticCameraConfirmed]);

  useEffect(() => {
    identityZoneRef.current = identityZone;
  }, [identityZone]);

  const calibrationValidation = useMemo(
    () => validateWallCalibration(session.calibration),
    [session.calibration],
  );
  const rangeValid = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) &&
    rangeStart >= 0 && rangeEnd > rangeStart && rangeEnd <= (metadata?.duration ?? 0) + 0.001;
  const resultStale = Boolean(
    session.result &&
    !selectBiomechanicsResultCoveringRange(session.result, {
      startRawTime: rangeStart,
      endRawTime: rangeEnd,
      identityZone,
    }),
  );
  const locallyTrimmedResult = useMemo(
    () => session.result && session.calibration && !resultStale
      ? trimBiomechanicsResultAtFinish(session.result, session.calibration, {
          acceptedFinishRawTime: rangeEnd,
        })
      : null,
    [rangeEnd, resultStale, session.calibration, session.result],
  );
  const visibleResult = displayResult ?? locallyTrimmedResult?.result;
  const visibleFinishCutoff = finishCutoff ?? locallyTrimmedResult?.cutoff;
  const calibrationReady = calibrationValidation.valid;
  const automaticRangeReady = startRawTime !== null &&
    (finishRawTime !== null || (fallbackFinishRawTime !== null && fallbackFinishRawTime !== undefined)) &&
    rangeValid;
  const nextCorner = WALL_CORNER_TEMPLATE[draftPoints.length];

  useEffect(() => {
    setShowCalibrationEditor(!calibrationReady);
  }, [calibrationReady, session.calibration?.frameRawTime]);

  function captureCalibrationFrame() {
    const video = videoRef.current;
    if (analysisBlocked || running) {
      setError("Wait for the active video analysis to finish before capturing a calibration frame.");
      return;
    }
    if (!video || !metadata?.metadataLoaded) {
      setError("Load a video before capturing a wall-calibration frame.");
      return;
    }
    const captured = captureFrame(video);
    setCalibrationFrame(captured.dataUrl);
    setCalibrationFrameTime(roundTime(video.currentTime));
    setDraftPoints([]);
    setShowCalibrationEditor(true);
    setError("");
    setStatus("Calibration frame captured. Mark bottom-left, bottom-right, top-right, then top-left.");
  }

  function handleCalibrationPointer(event: PointerEvent<HTMLDivElement>) {
    if (draftPoints.length >= WALL_CORNER_TEMPLATE.length) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    setDraftPoints((current) => [
      ...current,
      {
        x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
      },
    ]);
    setError("");
  }

  function updateDraftCoordinate(index: number, axis: "x" | "y", percent: number) {
    if (!Number.isFinite(percent)) {
      return;
    }
    setDraftPoints((current) => {
      const next = [...current];
      const existing = next[index] ?? { x: 0.5, y: 0.5 };
      next[index] = { ...existing, [axis]: clamp(percent / 100, 0, 1) };
      return next;
    });
  }

  function saveCalibration() {
    try {
      const calibration = buildWallCalibration(draftPoints, calibrationFrameTime, staticCameraConfirmed);
      const validation = validateWallCalibration(calibration);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      onSessionChange({ ...session, calibration, result: undefined });
      setShowCalibrationEditor(false);
      setStatus("Fixed-camera 3 m × 15 m wall calibration saved. Existing biomechanics results were cleared.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wall calibration could not be saved.");
    }
  }

  function updateSetting<K extends keyof BiomechanicsSession["settings"]>(
    key: K,
    value: BiomechanicsSession["settings"][K],
  ) {
    onSessionChange({
      ...session,
      settings: { ...session.settings, [key]: value },
      result: undefined,
    });
    setStatus("Biomechanics settings changed. Run analysis again.");
  }

  async function runAnalysis() {
    const video = videoRef.current;
    if (!video || !session.calibration || !calibrationValidation.valid || !rangeValid) {
      setError(calibrationValidation.error ?? "Load a video, calibrate the wall, and choose a valid range.");
      return;
    }

    cancelledRef.current = false;
    const abortController = new AbortController();
    const analysisIdentityZone = identityZone ? { ...identityZone } : undefined;
    abortControllerRef.current = abortController;
    setRunning(true);
    onRunningChange(true);
    setProgress({ phase: "loading", processed: 0, total: 0 });
    setStatus("Loading the on-device pose model…");
    setError("");
    try {
      const result = await runVideoTask(
        "biomechanics",
        async () => {
          if (onLocateRoute) {
            setStatus("Locating the 20 visible route holds...");
            await onLocateRoute(rangeStart, rangeEnd, session.calibration!, abortController.signal);
          }
          return analyzePoseVideo({
          video,
          startRawTime: rangeStart,
          endRawTime: rangeEnd,
          settings: session.settings,
          calibration: session.calibration!,
          identityZone: analysisIdentityZone,
          onProgress: (next) => {
            setProgress(next);
            setStatus(next.phase === "analyzing"
              ? `Analyzing pose ${next.processed} of ${next.total}…`
              : next.phase === "finalizing"
                ? "Calculating calibrated COM and velocity…"
                : "Loading the on-device pose model…");
          },
          isCancelled: () => cancelledRef.current,
            signal: abortController.signal,
          });
        },
        "Biomechanics analysis complete. Video restored to its previous position.",
      );
      if (cancelledRef.current || abortController.signal.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      if (!zonesEqual(result.identityZone, identityZoneRef.current)) {
        throw new Error("The Start Body Zone changed during analysis, so the stale pose result was discarded. Run it again with the final zone.");
      }
      onSessionChange({ ...session, result });
      const selectedFrames = result.metrics.selectedFrames ?? result.metrics.detectedFrames;
      if (result.metrics.detectedFrames === 0) {
        setStatus("Pose scan finished, but no athlete was detected.");
        setError("No athlete pose was found. Check that the four wall corners surround the actual wall and that the analysis begins with the climber visible near the Start Body Zone.");
      } else if (selectedFrames === 0) {
        setStatus("People were found, but the climber could not be selected safely.");
        setError("Tighten the Start Body Zone around only the climber at the beginning of the range, then run again.");
      } else if (result.metrics.validFrames === 0) {
        setStatus(`Pose tracking worked on ${selectedFrames}/${result.metrics.requestedFrames} frames, but no COM frame passed the body-segment quality check.`);
        setError("The athlete was found, but too many required hips, knees, or shoulders were hidden. Try the 20% distant-upper-wall setting or a clearer camera angle.");
      } else {
        setStatus(`Biomechanics complete: ${result.metrics.validFrames}/${result.metrics.requestedFrames} valid COM frames.`);
      }
    } catch (caught) {
      if (caught instanceof PoseAnalysisCancelledError) {
        setStatus("Biomechanics analysis cancelled. Previous results were kept.");
      } else {
        setError(caught instanceof Error ? caught.message : "Biomechanics analysis failed.");
      }
    } finally {
      setRunning(false);
      abortControllerRef.current = null;
      onRunningChange(false);
      setProgress(null);
    }
  }

  return (
    <div className="biomechanics-panel" aria-busy={running}>
      <div className="experimental-banner">
        <strong>Automatic center of mass</strong>
        <span>Pose analysis runs only on this device and never changes the accepted start or finish.</span>
      </div>

      <div className="com-readiness" aria-label="Center of mass readiness">
        <ReadinessItem ready={Boolean(metadata?.metadataLoaded)} label="Video" detail={metadata?.metadataLoaded ? "Ready" : "Load a clip"} />
        <ReadinessItem ready={automaticRangeReady} label="Timing" detail={automaticRangeReady ? `${rangeStart.toFixed(3)}s to ${rangeEnd.toFixed(3)}s` : "Run Quick Analyze"} />
        <ReadinessItem
          ready={calibrationReady}
          label="Wall scale"
          detail={calibrationReady
            ? session.calibration?.source === "automatic-approximate" ? "Auto estimate" : "Manually calibrated"
            : "Estimated by Quick Analyze"}
        />
      </div>

      <div className="biomechanics-setup-grid">
        {calibrationReady && !showCalibrationEditor ? (
          <div className="calibration-ready-row">
            <div>
              <strong>{session.calibration?.source === "automatic-approximate" ? "Approximate wall lane ready" : "Wall calibration ready"}</strong>
              <span>
                {session.calibration?.source === "automatic-approximate"
                  ? `Estimated automatically at ${session.calibration.frameRawTime.toFixed(3)}s (${session.calibration.confidence ?? "Low"} confidence). Mark four corners when precise metre values matter.`
                  : `Saved from video time ${session.calibration!.frameRawTime.toFixed(3)}s. Reuse it while the camera stays fixed.`}
              </span>
            </div>
            <button onClick={() => setShowCalibrationEditor(true)} disabled={running || analysisBlocked}>Edit calibration</button>
          </div>
        ) : (
        <section className="biomechanics-step" aria-labelledby="wall-calibration-heading">
          <div className="step-heading-row">
            <div>
              <p className="eyebrow">One-time setup</p>
              <h3 id="wall-calibration-heading">Mark the four wall corners</h3>
            </div>
            {calibrationReady && <button onClick={() => setShowCalibrationEditor(false)}>Close</button>}
          </div>
          <p className="muted">
            Side angles are supported when the camera is fixed. Pause on a frame showing the whole selected lane, then click its actual bottom left, bottom right, top right, and top left corners. Follow the sloped wall edges you see; do not make the top or bottom artificially horizontal.
          </p>
          <div className="button-row">
            <button className="primary" onClick={captureCalibrationFrame} disabled={!metadata?.metadataLoaded || running || analysisBlocked}>
              {calibrationFrame ? "Capture a different frame" : "Capture current full-wall frame"}
            </button>
            {draftPoints.length > 0 && (
              <>
                <button onClick={() => setDraftPoints((points) => points.slice(0, -1))} disabled={running}>
                  Undo last point
                </button>
                <button
                  onClick={() => {
                    setDraftPoints([]);
                    setStatus("Draft wall corners cleared.");
                  }}
                  disabled={running}
                >
                  Start over
                </button>
              </>
            )}
          </div>

          {calibrationFrame && (
            <p className="calibration-next" aria-live="polite">
              {nextCorner ? `Next: click ${nextCorner.label.toLowerCase()} (${draftPoints.length + 1} of 4).` : "All four corners marked. Confirm the fixed camera, then save."}
            </p>
          )}

          {calibrationFrame && (
            <div
              className="wall-calibration-stage"
              style={{ aspectRatio: `${metadata?.videoWidth || 16} / ${metadata?.videoHeight || 9}` }}
            >
              <img src={calibrationFrame} alt="Captured full-wall frame for calibration" />
              <div
                className="wall-calibration-overlay"
                onPointerDown={handleCalibrationPointer}
                aria-label="Wall calibration image. Mark bottom left, bottom right, top right, then top left."
              >
                {draftPoints.map((point, index) => (
                  <span
                    key={WALL_CORNER_TEMPLATE[index].id}
                    className="wall-corner-marker"
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                  >
                    {index + 1}
                  </span>
                ))}
              </div>
            </div>
          )}

          {calibrationFrame && <details className="help-details calibration-fine-tune">
          <summary>Fine-tune corner coordinates</summary>
          <div className="corner-coordinate-grid">
            {WALL_CORNER_TEMPLATE.map((corner, index) => (
              <fieldset key={corner.id}>
                <legend>{index + 1}. {corner.label}</legend>
                <label>
                  X (% of frame)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={draftPoints[index] ? (draftPoints[index].x * 100).toFixed(1) : ""}
                    onChange={(event) => updateDraftCoordinate(index, "x", Number(event.target.value))}
                    disabled={running}
                  />
                </label>
                <label>
                  Y (% of frame)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={draftPoints[index] ? (draftPoints[index].y * 100).toFixed(1) : ""}
                    onChange={(event) => updateDraftCoordinate(index, "y", Number(event.target.value))}
                    disabled={running}
                  />
                </label>
              </fieldset>
            ))}
          </div>
          </details>}

          <label className="confirmation-control">
            <input
              type="checkbox"
              checked={staticCameraConfirmed}
              onChange={(event) => setStaticCameraConfirmed(event.target.checked)}
              disabled={running}
            />
            The camera stays fixed from the accepted start through the finish (no pan, tilt, shake, or zoom during the climb).
          </label>
          <div className="button-row">
            <button className="primary" onClick={saveCalibration} disabled={draftPoints.length !== 4 || !staticCameraConfirmed || running}>
              Save wall calibration
            </button>
            {session.calibration && (
              <button
                onClick={() => {
                  onSessionChange({ ...session, calibration: undefined, result: undefined });
                  setDraftPoints([]);
                  setStatus("Saved wall calibration and center-of-mass results cleared.");
                }}
                disabled={running}
              >
                Remove saved calibration
              </button>
            )}
          </div>
          {!calibrationReady && <p className="guidance">{calibrationValidation.error}</p>}
        </section>
        )}

        <section className="biomechanics-step" aria-labelledby="pose-analysis-heading">
          <div className="step-heading-row">
            <div>
              <p className="eyebrow">Automatic analysis</p>
              <h3 id="pose-analysis-heading">Follow the athlete and build the charts</h3>
            </div>
            {automaticRangeReady && <span className="quality-badge quality-high">Timing ready</span>}
          </div>
          <p className="muted">
            ClimbIQ uses the accepted start and finish, follows the selected athlete, and calculates the center-of-mass path and wall speed automatically.
          </p>
          {!metadata?.metadataLoaded && <p className="com-action-message">Load a video to begin.</p>}
          {metadata?.metadataLoaded && !automaticRangeReady && (
            <p className="com-action-message">Run Quick Analyze first so ClimbIQ can use the detected start and finish automatically.</p>
          )}
          {metadata?.metadataLoaded && automaticRangeReady && !calibrationReady && (
            <p className="com-action-message">Mark the four actual lane corners. This is required for an oblique view and gives COM charts a trustworthy 3 m by 15 m perspective scale.</p>
          )}
          {!identityZone && metadata?.metadataLoaded && (
            <p className="muted">ClimbIQ will choose the visible athlete automatically. Add a Start Body Zone only if it follows the wrong person.</p>
          )}
          {resultStale && <p className="guidance">The timing or athlete lane changed. Run COM analysis again to refresh these results.</p>}
          <details className="help-details com-advanced-settings">
          <summary>Advanced range and tracking settings</summary>
          <div className="form-grid biomechanics-controls">
            <label>
              Raw start time
              <input
                type="number"
                min="0"
                step="0.001"
                value={rangeStart}
                onChange={(event) => setRangeStart(Number(event.target.value))}
                disabled={running}
              />
            </label>
            <label>
              Raw end time
              <input
                type="number"
                min="0"
                step="0.001"
                value={rangeEnd}
                onChange={(event) => setRangeEnd(Number(event.target.value))}
                disabled={running}
              />
            </label>
            <label>
              Sample rate
              <select
                value={session.settings.sampleFps}
                onChange={(event) => updateSetting("sampleFps", Number(event.target.value))}
                disabled={running}
              >
                <option value={5}>5 fps — recommended for phone video</option>
                <option value={10}>10 fps — finer timing</option>
                <option value={15}>15 fps — experimental fine timing</option>
              </select>
            </label>
            <label>
              Minimum landmark visibility
              <select
                value={session.settings.minVisibility}
                onChange={(event) => updateSetting("minVisibility", Number(event.target.value))}
                disabled={running}
              >
                <option value={0.2}>20% - distant upper wall</option>
                <option value={0.25}>25% — recommended for distant climbers</option>
                <option value={0.35}>35% — stricter</option>
                <option value={0.45}>45%</option>
                <option value={0.6}>60% — strict</option>
              </select>
            </label>
            <label>
              Required visible body mass
              <select
                value={session.settings.minMassCoverage}
                onChange={(event) => updateSetting("minMassCoverage", Number(event.target.value))}
                disabled={running}
              >
                <option value={0.7}>70% - distant upper wall</option>
                <option value={0.75}>75% — recommended</option>
                <option value={0.8}>80% — stricter</option>
                <option value={0.85}>85%</option>
                <option value={0.9}>90%</option>
                <option value={0.95}>95% — strict</option>
              </select>
            </label>
            <label>
              Smoothing window
              <select
                value={session.settings.smoothingWindowSeconds}
                onChange={(event) => updateSetting("smoothingWindowSeconds", Number(event.target.value))}
                disabled={running}
              >
                <option value={0.15}>±0.15s</option>
                <option value={0.2}>±0.20s — recommended</option>
                <option value={0.25}>±0.25s</option>
              </select>
            </label>
          </div>
          <div className="model-note">
            <strong>COM model:</strong> AthleteVision’s published 12-segment adult-male reference coefficients.
            It is an estimated 2D wall projection, not a 3D or clinical measurement.
          </div>
          </details>
          {!rangeValid && <p className="guidance">Choose an analysis range inside the loaded video with end after start.</p>}
          <div className="button-row">
            {(running || (metadata?.metadataLoaded && calibrationReady && rangeValid)) && (
              <button
                className="primary"
                onClick={runAnalysis}
                disabled={running || analysisBlocked}
              >
                {running ? "Analyzing center of mass…" : automaticRangeReady ? "Analyze center of mass" : "Analyze selected range"}
              </button>
            )}
            {running && <button onClick={() => {
              cancelledRef.current = true;
              abortControllerRef.current?.abort();
              setStatus("Cancelling after the current frame…");
            }}>Cancel</button>}
            {!running && session.result && (
              <button onClick={() => {
                onSessionChange({ ...session, result: undefined });
                setStatus("Center-of-mass result cleared. Wall calibration was kept.");
              }}>
                Clear result
              </button>
            )}
          </div>
          {running && progress && (
            <div className="analysis-progress">
              <progress value={progress.processed} max={Math.max(progress.total, 1)} />
              <span>{progress.total ? `${progress.processed}/${progress.total} frames` : "Loading model"}</span>
            </div>
          )}
        </section>
      </div>

      <div aria-live="polite">
        {status && <p className="status-message">{status}</p>}
        {error && <p className="analysis-error">{error}</p>}
        {visibleFinishCutoff?.source === "top-completion" && (
          <p className="status-message">
            Climb-only COM ends at {visibleFinishCutoff.cutoffRawTime.toFixed(3)}s raw. The tracked descent after top completion is hidden and excluded from every metric.
          </p>
        )}
      </div>

      {!session.result && !running && calibrationReady && automaticRangeReady && (
        <div className="com-empty-state">
          <strong>Ready to build COM charts</strong>
          <span>Press Analyze center of mass. The pose path will also appear over the video during playback.</span>
        </div>
      )}

      {visibleResult && !resultStale && (
        <BiomechanicsResultView result={visibleResult} currentTime={currentTime} onJump={onJump} />
      )}
    </div>
  );
}

export function PoseVideoOverlay({
  result,
  calibration,
  hold10ImageOverride,
  alignedRouteHolds,
  currentTime,
  videoWidth,
  videoHeight,
}: {
  result?: BiomechanicsResult;
  calibration?: WallCalibration;
  hold10ImageOverride?: NormalizedPoint;
  alignedRouteHolds?: AlignedRouteHold[];
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
}) {
  if (!result || !videoWidth || !videoHeight) {
    return null;
  }
  const frame = nearestFrame(result.frames, currentTime, 0.6 / result.settings.sampleFps);
  let routeHolds: ReturnType<typeof projectStandardSpeedRouteToImage> = [];
  try {
    const visualById = new Map((alignedRouteHolds ?? []).map((entry) => [entry.holdId, entry.image]));
    const projected = calibration ? projectStandardSpeedRouteToImage(calibration) : [];
    routeHolds = alignedRouteHolds?.length
      ? projected.filter((entry) => visualById.has(entry.hold.id) || (entry.hold.id === 10 && hold10ImageOverride)).map((entry) => ({
          ...entry,
          image: entry.hold.id === 10 && hold10ImageOverride
            ? hold10ImageOverride
            : visualById.get(entry.hold.id)!,
        }))
      : hold10ImageOverride
        ? projected.filter((entry) => entry.hold.id === 10).map((entry) => ({ ...entry, image: hold10ImageOverride }))
        : [];
  } catch {
    routeHolds = [];
  }
  if ((!frame || (!frame.landmarks.length && !frame.imageCom)) && !routeHolds.length) {
    return null;
  }
  const byIndex = new Map((frame?.landmarks ?? []).map((landmark) => [landmark.index, landmark]));
  const pathChunks = frame
    ? buildImageComTrailChunks(result.frames, frame.rawTime, videoWidth, videoHeight)
    : [];

  return (
    <svg
      className="pose-video-overlay"
      viewBox={`0 0 ${videoWidth} ${videoHeight}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {routeHolds.map(({ hold, image }) => (
        image.x >= -0.05 && image.x <= 1.05 && image.y >= -0.05 && image.y <= 1.05 ? (
          <g key={hold.id} className={hold.id === 10 ? "video-route-hold hold-10" : "video-route-hold"}>
            <circle
              cx={image.x * videoWidth}
              cy={image.y * videoHeight}
              r={Math.max(5, videoWidth * (hold.id === 10 ? 0.009 : 0.006))}
            />
            <text
              x={image.x * videoWidth}
              y={image.y * videoHeight}
              fontSize={Math.max(12, videoWidth * (hold.id === 10 ? 0.022 : 0.017))}
            >
              {hold.id}
            </text>
          </g>
        ) : null
      ))}
      {pathChunks.map((points, index) => (
        <polyline key={index} className="video-com-trail" points={points} />
      ))}
      {SKELETON_CONNECTIONS.map(([from, to]) => {
        const left = byIndex.get(from);
        const right = byIndex.get(to);
        if (!left || !right) {
          return null;
        }
        return (
          <line
            key={`${from}-${to}`}
            x1={left.x * videoWidth}
            y1={left.y * videoHeight}
            x2={right.x * videoWidth}
            y2={right.y * videoHeight}
            className={Math.min(left.visibility, right.visibility) < result.settings.minVisibility ? "low-confidence" : ""}
          />
        );
      })}
      {(frame?.landmarks ?? [])
        .filter((landmark) => SKELETON_CONNECTIONS.some(([from, to]) => from === landmark.index || to === landmark.index))
        .map((landmark) => (
          <circle
            key={landmark.index}
            cx={landmark.x * videoWidth}
            cy={landmark.y * videoHeight}
            r={Math.max(3, videoWidth * 0.004)}
            className={landmark.visibility < result.settings.minVisibility ? "low-confidence" : ""}
          />
        ))}
      {frame?.imageCom && (
        <circle
          className="video-com-point"
          cx={frame.imageCom.x * videoWidth}
          cy={frame.imageCom.y * videoHeight}
          r={Math.max(6, videoWidth * 0.008)}
        />
      )}
    </svg>
  );
}

function buildImageComTrailChunks(
  frames: BiomechanicsFrame[],
  throughRawTime: number,
  videoWidth: number,
  videoHeight: number,
): string[] {
  const chunks: BiomechanicsFrame[][] = [];
  let current: BiomechanicsFrame[] | undefined;
  for (const sample of frames) {
    const usable = Boolean(
      sample.imageCom && sample.valid && sample.poseSelected !== false &&
      sample.rawTime <= throughRawTime && !isTrajectoryFrameExcluded(sample),
    );
    if (!usable) {
      current = undefined;
      continue;
    }
    const previous = current?.[current.length - 1];
    const discontinuity = previous && (
      sample.rawTime - previous.rawTime > 0.25 ||
      Math.hypot(
        sample.imageCom!.x - previous.imageCom!.x,
        sample.imageCom!.y - previous.imageCom!.y,
      ) > 0.16
    );
    if (!current || discontinuity) {
      current = [sample];
      chunks.push(current);
    } else {
      current.push(sample);
    }
  }
  return chunks
    .filter((chunk) => chunk.length >= 2)
    .map((chunk) => chunk.map((sample) =>
      `${sample.imageCom!.x * videoWidth},${sample.imageCom!.y * videoHeight}`,
    ).join(" "));
}

function ReadinessItem({ ready, label, detail }: { ready: boolean; label: string; detail: string }) {
  return (
    <div className={ready ? "readiness-item ready" : "readiness-item"}>
      <span className="readiness-icon" aria-hidden="true">{ready ? "✓" : "•"}</span>
      <span><strong>{label}</strong><small>{detail}</small></span>
    </div>
  );
}

function BiomechanicsResultView({
  result,
  currentTime,
  onJump,
}: {
  result: BiomechanicsResult;
  currentTime: number;
  onJump: (time: number) => void;
}) {
  const { metrics } = result;
  const hasComData = result.frames.some((frame) => Boolean(frame.smoothedWallCom));
  const routeSplits = analyzeRouteSplits(result);
  const selectedFrames = metrics.selectedFrames ?? metrics.detectedFrames;
  const resultSummary = metrics.validFrames === 0
    ? metrics.detectedFrames === 0
      ? "No athlete was detected in the selected lane."
      : selectedFrames === 0
        ? "People were visible, but ClimbIQ could not safely identify the climber."
        : "The climber was found, but too few body segments were visible for a reliable COM estimate."
    : `${metrics.validFrames} of ${metrics.requestedFrames} sampled frames produced a usable center-of-mass estimate.`;
  return (
    <section className="biomechanics-results" aria-labelledby="biomechanics-results-heading">
      <div className="result-heading-row">
        <div>
          <p className="eyebrow">Calibrated wall-plane analysis</p>
          <h3 id="biomechanics-results-heading">Center-of-mass results</h3>
        </div>
        <span className={`quality-badge quality-${metrics.quality.toLowerCase().replaceAll(" ", "-")}`}>
          {metrics.quality}
        </span>
      </div>
      <p className={metrics.validFrames ? "result-summary" : "result-summary needs-attention"}>{resultSummary}</p>
      <div className="biomechanics-metrics">
        <ResultMetric label="Person detection" value={formatPercent(metrics.detectionCoverage ?? metrics.trackingCoverage)} />
        <ResultMetric label="Tracked athlete" value={formatPercent(metrics.trackingCoverage)} />
        <ResultMetric label="Valid COM coverage" value={formatPercent(metrics.validCoverage)} />
        <ResultMetric label="Mean visible mass" value={formatPercent(metrics.meanMassCoverage)} />
        {Number.isFinite(metrics.averageSpeedMps) && <ResultMetric label="Average wall speed" value={formatMetric(metrics.averageSpeedMps, "m/s")} />}
        {Number.isFinite(metrics.peakSpeedMps) && <ResultMetric label="Peak wall speed" value={formatMetric(metrics.peakSpeedMps, "m/s")} />}
        {Number.isFinite(metrics.verticalGainMeters) && <ResultMetric label="Vertical gain" value={formatMetric(metrics.verticalGainMeters, "m")} />}
        {Number.isFinite(metrics.pathLengthMeters) && <ResultMetric label="COM path length" value={formatMetric(metrics.pathLengthMeters, "m")} />}
        {Number.isFinite(metrics.pathEfficiency) && <ResultMetric label="Path efficiency" value={formatPercent(metrics.pathEfficiency)} />}
      </div>

      {hasComData && <RouteSplitsPanel analysis={routeSplits} onJump={onJump} />}

      {hasComData ? (
        <>
          <div className="biomechanics-visual-grid">
            <WallTrajectory result={result} currentTime={currentTime} />
            <VelocityChart result={result} currentTime={currentTime} />
          </div>
          <div className="velocity-legend" aria-label="Trajectory speed color legend">
            <span><i className="speed-slow" /> Slower</span>
            <span><i className="speed-mid" /> Mid-range</span>
            <span><i className="speed-fast" /> Faster</span>
          </div>
        </>
      ) : (
        <div className="chart-empty-state" role="status">
          <strong>No COM path to chart yet</strong>
          <span>{selectedFrames === 0 ? "Check the selected athlete lane and rerun analysis." : "Try the 20% distant-upper-wall setting or use a clearer, unobstructed camera angle."}</span>
        </div>
      )}

      {result.warnings.length > 0 && (
        <details className="help-details biomechanics-warnings">
          <summary>Quality notes ({result.warnings.length})</summary>
          <div className="warnings">
            {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        </details>
      )}

      <details className="help-details">
        <summary>Frame-by-frame biomechanics data</summary>
        <div className="table-wrap biomechanics-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Raw time</th>
                <th>Climb time</th>
                <th>Wall X</th>
                <th>Wall Y</th>
                <th>Speed</th>
                <th>Visible mass</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {result.frames.map((frame) => (
                <tr key={frame.rawTime}>
                  <td>{frame.rawTime.toFixed(3)}s</td>
                  <td>{frame.climbTime.toFixed(3)}s</td>
                  <td>{frame.smoothedWallCom ? `${frame.smoothedWallCom.xMeters.toFixed(3)}m` : "—"}</td>
                  <td>{frame.smoothedWallCom ? `${frame.smoothedWallCom.yMeters.toFixed(3)}m` : "—"}</td>
                  <td>{formatMetric(frame.speedMps, "m/s")}</td>
                  <td>{formatPercent(frame.massCoverage)}</td>
                  <td>{frame.valid ? frame.warning ?? "Valid" : frame.warning ?? "Needs review"}</td>
                  <td><button onClick={() => onJump(frame.rawTime)}>Jump</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function WallTrajectory({ result, currentTime }: { result: BiomechanicsResult; currentTime: number }) {
  const usable = result.frames.filter((frame) =>
    frame.smoothedWallCom && !isTrajectoryFrameExcluded(frame),
  );
  if (usable.length < 2) {
    return (
      <figure className="wall-trajectory-figure">
        <figcaption>COM path on the wall</figcaption>
        <div className="chart-empty-state compact">
          <strong>More tracked frames needed</strong>
          <span>At least two valid COM positions are needed to draw a path.</span>
        </div>
      </figure>
    );
  }
  const current = nearestFrame(usable, currentTime, 0.6 / result.settings.sampleFps);
  const peak = Math.max(1, ...usable.map((frame) => frame.speedMps ?? 0));
  const segments = result.frames.slice(1).flatMap((frame, index) => {
    const previous = result.frames[index];
    if (!frame.smoothedWallCom || !previous.smoothedWallCom ||
        isTrajectoryFrameExcluded(frame) || isTrajectoryFrameExcluded(previous) ||
        frame.rawTime - previous.rawTime > 0.25) {
      return [];
    }
    return [{ previous, frame }];
  });

  return (
    <figure className="wall-trajectory-figure">
      <figcaption>COM path on the 3 m by 15 m wall</figcaption>
      <svg viewBox="0 0 300 600" role="img" aria-label="Center of mass path on a three by fifteen metre speed wall">
        <rect x="1" y="1" width="298" height="598" className="wall-map-background" />
        {[0, 5, 10, 15].map((height) => (
          <g key={height}>
            <line x1="0" x2="300" y1={wallY(height)} y2={wallY(height)} className="wall-section-line" />
            <text x="8" y={Math.max(14, wallY(height) - 6)}>{height}m</text>
          </g>
        ))}
        {[1, 2].map((meter) => <line key={meter} x1={meter * 100} x2={meter * 100} y1="0" y2="600" className="wall-grid-line" />)}
        {segments.map(({ previous, frame }) => (
          <line
            key={`${previous.rawTime}-${frame.rawTime}`}
            x1={wallX(previous.smoothedWallCom!.xMeters)}
            y1={wallY(previous.smoothedWallCom!.yMeters)}
            x2={wallX(frame.smoothedWallCom!.xMeters)}
            y2={wallY(frame.smoothedWallCom!.yMeters)}
            stroke={speedColor(frame.speedMps ?? 0, peak)}
            className={frame.extrapolated ? "trajectory-segment extrapolated" : "trajectory-segment"}
          />
        ))}
        {current?.smoothedWallCom && (
          <circle
            cx={wallX(current.smoothedWallCom.xMeters)}
            cy={wallY(current.smoothedWallCom.yMeters)}
            r="7"
            className="trajectory-current"
          />
        )}
      </svg>
    </figure>
  );
}

function VelocityChart({ result, currentTime }: { result: BiomechanicsResult; currentTime: number }) {
  const usable = result.frames.filter((frame) => frame.speedMps !== undefined && !isTrajectoryFrameExcluded(frame));
  if (usable.length < 2) {
    return (
      <figure className="velocity-chart-figure">
        <figcaption>COM speed over climb time</figcaption>
        <div className="chart-empty-state compact">
          <strong>Speed is not available yet</strong>
          <span>More consecutive tracked frames are needed to calculate velocity.</span>
        </div>
      </figure>
    );
  }
  const minTime = result.startRawTime;
  const duration = Math.max(0.001, result.endRawTime - minTime);
  const maxSpeed = Math.max(1, ...usable.map((frame) => frame.speedMps ?? 0));
  const chunks: BiomechanicsFrame[][] = [];
  let chunk: BiomechanicsFrame[] | undefined;
  for (const frame of result.frames) {
    if (frame.speedMps === undefined || isTrajectoryFrameExcluded(frame)) {
      chunk = undefined;
      continue;
    }
    if (!chunk || frame.rawTime - chunk[chunk.length - 1].rawTime > 0.25) {
      chunk = [frame];
      chunks.push(chunk);
    } else {
      chunk.push(frame);
    }
  }
  const markerX = chartX(clamp(currentTime, result.startRawTime, result.endRawTime), minTime, duration);

  return (
    <figure className="velocity-chart-figure">
      <figcaption>COM speed over climb time</figcaption>
      <svg viewBox="0 0 640 300" role="img" aria-label="Wall-plane center of mass speed in metres per second over climb time">
        <rect x="52" y="18" width="568" height="236" className="chart-background" />
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1="52" x2="620" y1={254 - fraction * 236} y2={254 - fraction * 236} className="chart-grid-line" />
            <text x="6" y={258 - fraction * 236}>{(maxSpeed * fraction).toFixed(1)}</text>
          </g>
        ))}
        {chunks.map((chunk) => (
          <polyline
            key={chunk[0].rawTime}
            points={chunk.map((frame) => `${chartX(frame.rawTime, minTime, duration)},${chartY(frame.speedMps ?? 0, maxSpeed)}`).join(" ")}
            className="speed-line"
          />
        ))}
        <line x1={markerX} x2={markerX} y1="18" y2="254" className="chart-current-marker" />
        <text x="52" y="282">0.00s</text>
        <text x="560" y="282">{duration.toFixed(2)}s</text>
        <text x="6" y="14">m/s</text>
      </svg>
    </figure>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return <div className="biomechanics-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function RouteSplitsPanel({
  analysis,
  onJump,
}: {
  analysis: RouteSplitAnalysis;
  onJump: (time: number) => void;
}) {
  const slowest = analysis.sections.find((section) => section.id === analysis.slowestSectionId);
  const pacingMessage = slowest?.sectionTimeSeconds !== undefined
    ? `${slowest.label} took the most time at ${slowest.sectionTimeSeconds.toFixed(3)}s. Review it first.`
    : analysis.evenPacing
      ? "Your three section times were close, so no single wall third stands out as the main slowdown."
      : "ClimbIQ needs continuous COM tracking through more section boundaries before comparing all three thirds.";

  return (
    <section className="route-splits-panel" aria-labelledby="route-splits-heading">
      <div className="route-splits-heading-row">
        <div>
          <p className="eyebrow">Automatic route splits</p>
          <h4 id="route-splits-heading">Where time went</h4>
        </div>
        <span className={`split-confidence confidence-${analysis.confidence.toLowerCase()}`}>
          {analysis.confidence === "None" ? "Not enough tracking" : `${analysis.confidence} tracking confidence`}
        </span>
      </div>
      <p className="route-pacing-summary">{pacingMessage}</p>

      <div className="halfway-split-row">
        <div>
          <strong>Halfway up the wall</strong>
          <span>
            {analysis.halfway.available && analysis.halfway.climbTime !== undefined
              ? `${analysis.halfway.climbTime.toFixed(3)}s after the accepted start`
              : analysis.halfway.reason}
          </span>
          <small>This is a wall-section split only. Hold 10 is timed separately from sustained hand contact.</small>
        </div>
        {analysis.halfway.rawTime !== undefined && (
          <button onClick={() => onJump(analysis.halfway.rawTime!)}>Review halfway</button>
        )}
      </div>

      <div className="route-section-grid">
        {analysis.sections.map((section) => (
          <RouteSectionCard
            key={section.id}
            section={section}
            slowest={section.id === analysis.slowestSectionId}
            onJump={onJump}
          />
        ))}
      </div>
    </section>
  );
}

function RouteSectionCard({
  section,
  slowest,
  onJump,
}: {
  section: RouteSectionSplit;
  slowest: boolean;
  onJump: (time: number) => void;
}) {
  return (
    <article className={`route-section-card${slowest ? " slowest" : ""}`}>
      <div className="route-section-title">
        <div>
          <strong>{section.label}</strong>
          <span>{section.rangeLabel}</span>
        </div>
        {slowest && <span className="slowest-label">Slowest</span>}
      </div>
      {section.available && section.sectionTimeSeconds !== undefined ? (
        <>
          <div className="route-section-times">
            <span><small>Section</small><strong>{section.sectionTimeSeconds.toFixed(3)}s</strong></span>
            <span><small>Cumulative</small><strong>{section.cumulativeTimeSeconds?.toFixed(3)}s</strong></span>
          </div>
          <p>
            {section.averageVerticalPaceMps !== undefined
              ? `${section.averageVerticalPaceMps.toFixed(2)} m/s observed vertical pace`
              : "Vertical pace needs more continuous tracking"}
          </p>
          {section.startRawTime !== undefined && (
            <button onClick={() => onJump(section.startRawTime!)}>Review section</button>
          )}
        </>
      ) : (
        <p className="route-section-unavailable">{section.reason}</p>
      )}
    </article>
  );
}

function nearestFrame(frames: BiomechanicsFrame[], time: number, tolerance: number): BiomechanicsFrame | undefined {
  let nearest: BiomechanicsFrame | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = Math.abs(frame.rawTime - time);
    if (distance < nearestDistance) {
      nearest = frame;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= tolerance ? nearest : undefined;
}

function wallX(xMeters: number): number {
  return clamp(xMeters / 3, -0.12, 1.12) * 300;
}

function wallY(yMeters: number): number {
  return 600 - clamp(yMeters / 15, -0.05, 1.05) * 600;
}

function chartX(time: number, start: number, duration: number): number {
  return 52 + clamp((time - start) / duration, 0, 1) * 568;
}

function chartY(speed: number, maxSpeed: number): number {
  return 254 - clamp(speed / maxSpeed, 0, 1) * 236;
}

function speedColor(speed: number, peak: number): string {
  const ratio = clamp(speed / peak, 0, 1);
  if (ratio < 0.5) {
    return interpolateColor([249, 115, 22], [250, 204, 21], ratio * 2);
  }
  return interpolateColor([250, 204, 21], [34, 211, 238], (ratio - 0.5) * 2);
}

function interpolateColor(start: number[], end: number[], amount: number): string {
  const values = start.map((value, index) => Math.round(value + (end[index] - value) * amount));
  return `rgb(${values.join(",")})`;
}

function formatMetric(value: number | undefined, unit: string): string {
  return value === undefined || !Number.isFinite(value) ? "Not available" : `${value.toFixed(3)} ${unit}`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "Not available" : `${(value * 100).toFixed(1)}%`;
}

function zonesEqual(left?: NormalizedZone, right?: NormalizedZone): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.id === right.id &&
    Math.abs(left.x1 - right.x1) < 1e-6 &&
    Math.abs(left.y1 - right.y1) < 1e-6 &&
    Math.abs(left.x2 - right.x2) < 1e-6 &&
    Math.abs(left.y2 - right.y2) < 1e-6;
}
