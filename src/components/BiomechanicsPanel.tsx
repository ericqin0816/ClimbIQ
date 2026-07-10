import type { PointerEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BiomechanicsFrame,
  BiomechanicsResult,
  BiomechanicsSession,
  NormalizedPoint,
  NormalizedZone,
  VideoMetadata,
} from "../types";
import { analyzePoseVideo, PoseAnalysisCancelledError, type PoseAnalysisProgress } from "../lib/poseAnalysis";
import { captureFrame, clamp, roundTime } from "../lib/videoFrameSampler";
import {
  buildWallCalibration,
  validateWallCalibration,
  WALL_CORNER_TEMPLATE,
} from "../lib/wallCalibration";

interface BiomechanicsPanelProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  metadata: VideoMetadata | null;
  currentTime: number;
  startRawTime: number | null;
  finishRawTime: number | null;
  identityZone?: NormalizedZone;
  session: BiomechanicsSession;
  analysisBlocked: boolean;
  onSessionChange: (session: BiomechanicsSession) => void;
  onRunningChange: (running: boolean) => void;
  onJump: (time: number) => void;
  runVideoTask: <T>(taskName: string, work: () => Promise<T>, completeMessage: string) => Promise<T>;
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
  identityZone,
  session,
  analysisBlocked,
  onSessionChange,
  onRunningChange,
  onJump,
  runVideoTask,
}: BiomechanicsPanelProps) {
  const [calibrationFrame, setCalibrationFrame] = useState<string | null>(null);
  const [calibrationFrameTime, setCalibrationFrameTime] = useState(0);
  const [draftPoints, setDraftPoints] = useState<NormalizedPoint[]>([]);
  const [staticCameraConfirmed, setStaticCameraConfirmed] = useState(
    session.calibration?.staticCameraConfirmed ?? false,
  );
  const [rangeStart, setRangeStart] = useState(startRawTime ?? 0);
  const [rangeEnd, setRangeEnd] = useState(finishRawTime ?? metadata?.duration ?? 0);
  const [progress, setProgress] = useState<PoseAnalysisProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

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
    if (finishRawTime !== null) {
      setRangeEnd(finishRawTime);
    } else if (metadata?.duration) {
      setRangeEnd(metadata.duration);
    }
  }, [finishRawTime, metadata?.duration]);

  useEffect(() => {
    setStaticCameraConfirmed(session.calibration?.staticCameraConfirmed ?? false);
  }, [session.calibration?.staticCameraConfirmed]);

  const calibrationValidation = useMemo(
    () => validateWallCalibration(session.calibration),
    [session.calibration],
  );
  const rangeValid = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) &&
    rangeStart >= 0 && rangeEnd > rangeStart && rangeEnd <= (metadata?.duration ?? 0) + 0.001;
  const resultStale = Boolean(
    session.result &&
    (Math.abs(session.result.startRawTime - rangeStart) > 0.001 ||
      Math.abs(session.result.endRawTime - rangeEnd) > 0.001 ||
      !zonesEqual(session.result.identityZone, identityZone)),
  );

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
    abortControllerRef.current = abortController;
    setRunning(true);
    onRunningChange(true);
    setProgress({ phase: "loading", processed: 0, total: 0 });
    setStatus("Loading the on-device pose model…");
    setError("");
    try {
      const result = await runVideoTask(
        "biomechanics",
        () => analyzePoseVideo({
          video,
          startRawTime: rangeStart,
          endRawTime: rangeEnd,
          settings: session.settings,
          calibration: session.calibration!,
          identityZone,
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
        }),
        "Biomechanics analysis complete. Video restored to its previous position.",
      );
      if (cancelledRef.current || abortController.signal.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      onSessionChange({ ...session, result });
      setStatus(`Biomechanics complete: ${result.metrics.validFrames}/${result.metrics.requestedFrames} valid COM frames.`);
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
        <strong>Experimental, local pose analysis</strong>
        <span>
          Timing remains controlled by ClimbIQ’s light and motion detectors. Pose results never change accepted timestamps.
        </span>
      </div>

      <div className="biomechanics-setup-grid">
        <section className="biomechanics-step" aria-labelledby="wall-calibration-heading">
          <h3 id="wall-calibration-heading">A. Calibrate the standardized wall</h3>
          <p className="muted">
            Use a frame showing the complete lane. Click the four lane corners in order. This maps image coordinates onto a 3 m × 15 m wall plane.
          </p>
          <div className="button-row">
            <button className="primary" onClick={captureCalibrationFrame} disabled={!metadata?.metadataLoaded || running || analysisBlocked}>
              Capture current full-wall frame
            </button>
            <button onClick={() => setDraftPoints((points) => points.slice(0, -1))} disabled={!draftPoints.length || running}>
              Undo corner
            </button>
            <button
              onClick={() => {
                setDraftPoints([]);
                setStatus("Draft wall corners cleared.");
              }}
              disabled={!draftPoints.length || running}
            >
              Clear draft
            </button>
          </div>

          {calibrationFrame && (
            <div
              className="wall-calibration-stage"
              style={{ aspectRatio: `${metadata?.videoWidth || 16} / ${metadata?.videoHeight || 9}` }}
            >
              <img src={calibrationFrame} alt="Captured full-wall frame for calibration" />
              <div
                className="wall-calibration-overlay"
                onPointerDown={handleCalibrationPointer}
                aria-label="Wall calibration image. Pointer users can mark the next corner; keyboard users can use the coordinate fields below."
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

          <label className="confirmation-control">
            <input
              type="checkbox"
              checked={staticCameraConfirmed}
              onChange={(event) => setStaticCameraConfirmed(event.target.checked)}
              disabled={running}
            />
            I confirm the camera is fixed for the entire analyzed range—no pan, tilt, shake, or zoom.
          </label>
          <div className="button-row">
            <button className="primary" onClick={saveCalibration} disabled={draftPoints.length !== 4 || running}>
              Validate and save wall calibration
            </button>
            <button
              onClick={() => {
                onSessionChange({ ...session, calibration: undefined, result: undefined });
                setDraftPoints([]);
                setStatus("Saved wall calibration and biomechanics results cleared.");
              }}
              disabled={running}
            >
              Clear saved calibration
            </button>
          </div>
          <p className={calibrationValidation.valid ? "quality-good" : "guidance"}>
            {calibrationValidation.valid
              ? `Calibration ready from raw video time ${session.calibration!.frameRawTime.toFixed(3)}s.`
              : calibrationValidation.error}
          </p>
        </section>

        <section className="biomechanics-step" aria-labelledby="pose-analysis-heading">
          <h3 id="pose-analysis-heading">B. Run pose and COM analysis</h3>
          <p className="muted">
            MediaPipe runs on this device. Video frames stay local. A Start Body Zone helps ClimbIQ follow the correct athlete when two people are visible.
          </p>
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
                <option value={5}>5 fps — faster preview</option>
                <option value={10}>10 fps — recommended</option>
                <option value={15}>15 fps — finer velocity</option>
              </select>
            </label>
            <label>
              Minimum landmark visibility
              <select
                value={session.settings.minVisibility}
                onChange={(event) => updateSetting("minVisibility", Number(event.target.value))}
                disabled={running}
              >
                <option value={0.35}>35% — permissive</option>
                <option value={0.45}>45% — recommended</option>
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
                <option value={0.85}>85% — recommended</option>
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
          {!identityZone && (
            <p className="guidance">Draw a Start Body Zone first when another climber or official appears in frame.</p>
          )}
          {!rangeValid && <p className="guidance">Choose an analysis range inside the loaded video with end after start.</p>}
          {resultStale && <p className="guidance">Displayed results use a different range. Run analysis again before exporting.</p>}
          <div className="button-row">
            <button
              className="primary"
              onClick={runAnalysis}
              disabled={running || analysisBlocked || !metadata?.metadataLoaded || !calibrationValidation.valid || !rangeValid}
            >
              {running ? "Analyzing…" : "Run calibrated pose analysis"}
            </button>
            {running && <button onClick={() => {
              cancelledRef.current = true;
              abortControllerRef.current?.abort();
              setStatus("Cancelling after the current synchronous frame…");
            }}>Cancel</button>}
            <button
              onClick={() => {
                onSessionChange({ ...session, result: undefined });
                setStatus("Biomechanics result cleared. Calibration was kept.");
              }}
              disabled={running || !session.result}
            >
              Clear result
            </button>
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
      </div>

      {session.result && (
        <BiomechanicsResultView result={session.result} currentTime={currentTime} onJump={onJump} />
      )}
    </div>
  );
}

export function PoseVideoOverlay({
  result,
  currentTime,
  videoWidth,
  videoHeight,
}: {
  result?: BiomechanicsResult;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
}) {
  if (!result || !videoWidth || !videoHeight) {
    return null;
  }
  const frame = nearestFrame(result.frames, currentTime, 0.6 / result.settings.sampleFps);
  if (!frame || (!frame.landmarks.length && !frame.imageCom)) {
    return null;
  }
  const byIndex = new Map(frame.landmarks.map((landmark) => [landmark.index, landmark]));
  const pathPoints = result.frames
    .filter((sample) => sample.imageCom && sample.rawTime <= frame.rawTime)
    .map((sample) => `${sample.imageCom!.x * videoWidth},${sample.imageCom!.y * videoHeight}`)
    .join(" ");

  return (
    <svg
      className="pose-video-overlay"
      viewBox={`0 0 ${videoWidth} ${videoHeight}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {pathPoints && <polyline className="video-com-trail" points={pathPoints} />}
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
      {frame.landmarks
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
      {frame.imageCom && (
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
  return (
    <section className="biomechanics-results" aria-labelledby="biomechanics-results-heading">
      <div className="result-heading-row">
        <div>
          <p className="eyebrow">Calibrated wall-plane analysis</p>
          <h3 id="biomechanics-results-heading">Estimated 2D center of mass</h3>
        </div>
        <span className={`quality-badge quality-${metrics.quality.toLowerCase().replaceAll(" ", "-")}`}>
          {metrics.quality}
        </span>
      </div>
      <div className="biomechanics-metrics">
        <ResultMetric label="Tracking coverage" value={formatPercent(metrics.trackingCoverage)} />
        <ResultMetric label="Valid COM coverage" value={formatPercent(metrics.validCoverage)} />
        <ResultMetric label="Mean visible mass" value={formatPercent(metrics.meanMassCoverage)} />
        <ResultMetric label="Average wall speed" value={formatMetric(metrics.averageSpeedMps, "m/s")} />
        <ResultMetric label="Peak wall speed" value={formatMetric(metrics.peakSpeedMps, "m/s")} />
        <ResultMetric label="Vertical gain" value={formatMetric(metrics.verticalGainMeters, "m")} />
        <ResultMetric label="COM path length" value={formatMetric(metrics.pathLengthMeters, "m")} />
        <ResultMetric label="Path efficiency" value={formatPercent(metrics.pathEfficiency)} />
      </div>

      <div className="biomechanics-visual-grid">
        <WallTrajectory result={result} currentTime={currentTime} />
        <VelocityChart result={result} currentTime={currentTime} />
      </div>
      <div className="velocity-legend" aria-label="Velocity color legend">
        <span><i className="speed-slow" /> Slower</span>
        <span><i className="speed-mid" /> Mid-range</span>
        <span><i className="speed-fast" /> Faster</span>
      </div>

      <div className="warnings biomechanics-warnings">
        {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>

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
  const usable = result.frames.filter((frame) => frame.smoothedWallCom);
  const current = nearestFrame(usable, currentTime, 0.6 / result.settings.sampleFps);
  const peak = Math.max(1, ...usable.map((frame) => frame.speedMps ?? 0));
  const segments = usable.slice(1).flatMap((frame, index) => {
    const previous = usable[index];
    if (frame.rawTime - previous.rawTime > 0.25) {
      return [];
    }
    return [{ previous, frame }];
  });

  return (
    <figure className="wall-trajectory-figure">
      <figcaption>COM trajectory on standardized wall</figcaption>
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
  const usable = result.frames.filter((frame) => frame.speedMps !== undefined);
  const minTime = result.startRawTime;
  const duration = Math.max(0.001, result.endRawTime - minTime);
  const maxSpeed = Math.max(1, ...usable.map((frame) => frame.speedMps ?? 0));
  const chunks: BiomechanicsFrame[][] = [];
  for (const frame of usable) {
    const chunk = chunks[chunks.length - 1];
    if (!chunk || frame.rawTime - chunk[chunk.length - 1].rawTime > 0.25) {
      chunks.push([frame]);
    } else {
      chunk.push(frame);
    }
  }
  const markerX = chartX(clamp(currentTime, result.startRawTime, result.endRawTime), minTime, duration);

  return (
    <figure className="velocity-chart-figure">
      <figcaption>Wall-plane COM speed over time</figcaption>
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
