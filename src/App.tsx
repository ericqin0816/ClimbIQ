import { ChangeEvent, CSSProperties, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { BiomechanicsPanel, PoseVideoOverlay } from "./components/BiomechanicsPanel";
import { applyTrajectoryKinematics, DEFAULT_BIOMECHANICS_SETTINGS } from "./lib/biomechanics";
import { detectFirstMovement } from "./lib/detectFirstMovement";
import { detectAutomaticStartLight } from "./lib/detectAutomaticStartLight";
import { detectAudioStartSignal, type AudioStartResult } from "./lib/detectAudioStartSignal";
import { detectMotionBasedStartEstimate } from "./lib/detectMotionBasedStartEstimate";
import { detectStartSignal } from "./lib/detectStartSignal";
import { analyzePoseVideo, PoseAnalysisCancelledError } from "./lib/poseAnalysis";
import { fuseStartEvidence, type StartEvidence } from "./lib/startSignalFusion";
import { captureFrame, clamp, roundTime, sampleFrameAt, sampleZoneAverageColor, seekTo } from "./lib/videoFrameSampler";
import { validateWallCalibration } from "./lib/wallCalibration";
import type {
  Confidence,
  BiomechanicsFrame,
  BiomechanicsResult,
  BiomechanicsSession,
  DetectionCandidate,
  DetectionDebugReport,
  FirstMovementDetectionResult,
  FrameSamplingDebug,
  FirstMovementDefinition,
  NormalizedZone,
  RGB,
  SavedAnalysisSession,
  Sensitivity,
  StartDetectionProfile,
  StartLightCalibration,
  StartSignalDetectionResult,
  TimestampMarker,
  TimestampSource,
  VideoMetadata,
  WallCalibration,
  ZoneId,
} from "./types";

const ZONES: Array<{ id: ZoneId; label: string; tone: string }> = [
  { id: "startLight", label: "Start Light Zone", tone: "#7dd3fc" },
  { id: "startBody", label: "Start Body Zone", tone: "#f0abfc" },
  { id: "hold10", label: "Hold 10 Zone", tone: "#facc15" },
  { id: "finishLight", label: "Finish Light Zone", tone: "#86efac" },
];

const INITIAL_TIMESTAMPS: TimestampMarker[] = [
  marker("startSignal", "Start Signal"),
  marker("firstMovement", "Earliest Visible Motion"),
  marker("committedLaunch", "Committed Launch"),
  marker("firstHold", "First Hold"),
  marker("hold10", "Hold 10"),
  marker("finishPad", "Finish Pad"),
];

const APP_VERSION = "0.4.0";
const SESSION_STORAGE_KEY = "climbiq.analysisSessions.v1";

type ZoneDisplayMode = "fit" | "scroll";

interface PointerDebugInfo {
  rawX: number;
  rawY: number;
  normalizedX: number | null;
  normalizedY: number | null;
  insideImage: boolean;
  scrollTop: number;
  scrollLeft: number;
}

interface CandidatePreviewFrames {
  before?: string;
  exact?: string;
  after?: string;
  error?: string;
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const zoneFrameWrapRef = useRef<HTMLDivElement | null>(null);
  const zoneStageRef = useRef<HTMLDivElement | null>(null);
  const previousObjectUrl = useRef<string | null>(null);
  const videoFileRef = useRef<File | null>(null);
  const obsidianDirectoryHandle = useRef<any>(null);
  const videoTaskQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSessionVideoMetadataRef = useRef<VideoMetadata | null>(null);
  const pendingVideoFileNameRef = useRef<string | null>(null);
  const autoAnalysisAbortRef = useRef<AbortController | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [jumpInput, setJumpInput] = useState("");
  const [capturedFrame, setCapturedFrame] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<ZoneId>("startLight");
  const [zoneDisplayMode, setZoneDisplayMode] = useState<ZoneDisplayMode>("fit");
  const [showImageBounds, setShowImageBounds] = useState(false);
  const [pointerDebug, setPointerDebug] = useState<PointerDebugInfo | null>(null);
  const [zones, setZones] = useState<Partial<Record<ZoneId, NormalizedZone>>>({});
  const [draftZone, setDraftZone] = useState<NormalizedZone | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const [frameDebug, setFrameDebug] = useState<FrameSamplingDebug | null>(null);
  const [frameTestRunning, setFrameTestRunning] = useState(false);
  const [videoRestoreStatus, setVideoRestoreStatus] = useState("");

  const [startSearchStart, setStartSearchStart] = useState(0);
  const [startSearchEnd, setStartSearchEnd] = useState(8);
  const [startSensitivity, setStartSensitivity] = useState<Sensitivity>("medium");
  const [startLightVisibility, setStartLightVisibility] = useState<"clear" | "blocked">("clear");
  const [startDetectionProfile, setStartDetectionProfile] = useState<StartDetectionProfile>("auto");
  const [startLightCalibration, setStartLightCalibration] = useState<StartLightCalibration>({});
  const [calibrationStatus, setCalibrationStatus] = useState("");
  const [reactionTimeOffset, setReactionTimeOffset] = useState(0.2);
  const [startSignalOffset, setStartSignalOffset] = useState(0);
  const [startResult, setStartResult] = useState<StartSignalDetectionResult | null>(null);
  const [suggestedStartRawTime, setSuggestedStartRawTime] = useState<number | null>(null);
  const [startRunning, setStartRunning] = useState(false);

  const [movementSensitivity, setMovementSensitivity] = useState<Sensitivity>("medium");
  const [firstMovementDefinition, setFirstMovementDefinition] = useState<FirstMovementDefinition>("earliest");
  const [committedLaunchMinDelay, setCommittedLaunchMinDelay] = useState(0.1);
  const [firstMovementOffset, setFirstMovementOffset] = useState(0);
  const [movementResult, setMovementResult] = useState<FirstMovementDetectionResult | null>(null);
  const [movementRunning, setMovementRunning] = useState(false);
  const [movementPreviewFrames, setMovementPreviewFrames] = useState<Record<string, CandidatePreviewFrames>>({});
  const [movementPreviewRunning, setMovementPreviewRunning] = useState(false);

  const [officialTotalTime, setOfficialTotalTime] = useState("");
  const [timestamps, setTimestamps] = useState<TimestampMarker[]>(INITIAL_TIMESTAMPS);
  const [copyStatus, setCopyStatus] = useState("");
  const [sessionName, setSessionName] = useState("Untitled climb analysis");
  const [climberName, setClimberName] = useState("");
  const [attemptDate, setAttemptDate] = useState(todayDateString());
  const [attemptLocation, setAttemptLocation] = useState("");
  const [attemptType, setAttemptType] = useState("Training");
  const [sessionNotes, setSessionNotes] = useState("");
  const [savedSessions, setSavedSessions] = useState<SavedAnalysisSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [obsidianFolderName, setObsidianFolderName] = useState("");
  const [biomechanics, setBiomechanics] = useState<BiomechanicsSession>(createDefaultBiomechanicsSession());
  const [biomechanicsRunning, setBiomechanicsRunning] = useState(false);
  const [autoAnalysisRunning, setAutoAnalysisRunning] = useState(false);
  const [autoAnalysisStatus, setAutoAnalysisStatus] = useState("");
  const [startEvidenceStatus, setStartEvidenceStatus] = useState("");

  useEffect(() => {
    setSavedSessions(readSavedSessions());
    return () => autoAnalysisAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setBiomechanics((current) => {
      if (!current.result || normalizedZonesEqual(current.result.identityZone, zones.startBody)) {
        return current;
      }
      return { ...current, result: undefined };
    });
  }, [zones.startBody]);

  useEffect(() => {
    const video = videoRef.current;
    const candidates = movementResult?.candidates ?? [];
    if (!video || !metadata?.metadataLoaded || candidates.length === 0) {
      setMovementPreviewFrames({});
      setMovementPreviewRunning(false);
      return;
    }

    let cancelled = false;
    setMovementPreviewFrames({});
    setMovementPreviewRunning(true);

    runWithVideoRestore(
      video,
      async () => {
        const previews: Record<string, CandidatePreviewFrames> = {};
        for (const candidate of candidates.slice(0, 6)) {
          if (cancelled) {
            return;
          }
          previews[movementCandidateKey(candidate)] = await captureCandidatePreviewFrames(video, candidate.rawTime);
          if (!cancelled) {
            setMovementPreviewFrames({ ...previews });
          }
        }
      },
      "Movement candidate previews ready. Video restored to previous position.",
    )
      .catch((error) => {
        if (!cancelled) {
          setVideoRestoreStatus(error instanceof Error ? `Preview frames failed: ${error.message}` : "Preview frames failed.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMovementPreviewRunning(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [metadata?.metadataLoaded, movementResult]);

  const startSignalRaw = useMemo(() => {
    return getTimestamp(timestamps, "startSignal").rawTime;
  }, [timestamps]);

  const finishSuggestion = useMemo(() => {
    const official = Number(officialTotalTime);
    if (startSignalRaw === null || !Number.isFinite(official) || official <= 0) {
      return null;
    }
    return {
      rawTime: roundTime(startSignalRaw + official),
      climbTime: roundTime(official),
    };
  }, [officialTotalTime, startSignalRaw]);

  const splitRows = useMemo(() => {
    const start = getTimestamp(timestamps, "startSignal").rawTime;
    const firstMovement = getTimestamp(timestamps, "firstMovement").rawTime;
    const committedLaunch = getTimestamp(timestamps, "committedLaunch").rawTime;
    const firstHold = getTimestamp(timestamps, "firstHold").rawTime;
    const hold10 = getTimestamp(timestamps, "hold10").rawTime;
    const finish = getTimestamp(timestamps, "finishPad").rawTime;

    return [
      { label: "Reaction Time", value: diff(firstMovement, start) },
      { label: "Launch Delay", value: diff(committedLaunch, start) },
      { label: "Preload Gap", value: diff(committedLaunch, firstMovement) },
      { label: "Start to First Hold", value: diff(firstHold, start) },
      { label: "Movement to First Hold", value: diff(firstHold, firstMovement) },
      { label: "First Hold to Hold 10", value: diff(hold10, firstHold) },
      { label: "Hold 10 to Finish", value: diff(finish, hold10) },
      { label: "Movement Time", value: diff(finish, firstMovement) },
      { label: "Launch-to-Finish Time", value: diff(finish, committedLaunch) },
      { label: "Calculated Total Time", value: diff(finish, start) },
    ];
  }, [timestamps]);

  const startFinalRaw = startResult?.rawTime !== undefined ? Math.max(0, roundTime(startResult.rawTime + startSignalOffset)) : undefined;
  const movementFinalRaw = movementResult?.rawTime !== undefined ? Math.max(0, roundTime(movementResult.rawTime + firstMovementOffset)) : undefined;
  const movementFinalClimb =
    movementFinalRaw !== undefined && startSignalRaw !== null ? roundTime(movementFinalRaw - startSignalRaw) : movementResult?.climbTime;
  const calibrationReady = Boolean(
    startLightCalibration.beforeStartRGB &&
    startLightCalibration.afterStartRGB &&
    startLightCalibration.colorDelta !== undefined,
  );
  const resolvedStartProfile: StartDetectionProfile =
    startDetectionProfile === "auto" && calibrationReady ? "calibrated" : startDetectionProfile;
  const isCalibrationWeak =
    startLightCalibration.colorDelta !== undefined && startLightCalibration.colorDelta < 18;
  const startDetectionMethodLabel =
    resolvedStartProfile === "motion"
      ? "Motion-based start estimate"
      : calibrationReady && ["calibrated", "blocked", "manual"].includes(resolvedStartProfile)
      ? "Calibrated light transition"
      : "Generic color-distance detection";
  const videoAnalysisRunning = frameTestRunning || startRunning || movementRunning || movementPreviewRunning || biomechanicsRunning || autoAnalysisRunning;

  const zoneStageStyle = useMemo((): CSSProperties => {
    const width = metadata?.videoWidth || 16;
    const height = metadata?.videoHeight || 9;
    const aspectRatio = `${width} / ${height}`;

    if (zoneDisplayMode === "scroll") {
      return {
        aspectRatio,
        width: `${width}px`,
        height: `${height}px`,
      };
    }

    return {
      aspectRatio,
      width: `min(100%, ${(width / height) * 68}vh)`,
    };
  }, [metadata?.videoHeight, metadata?.videoWidth, zoneDisplayMode]);

  function resetAnalysisForNewVideo(fileName: string) {
    setFrameDebug(null);
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setMovementPreviewFrames({});
    setMovementPreviewRunning(false);
    setStartSearchStart(0);
    setStartSignalOffset(0);
    setFirstMovementOffset(0);
    setStartLightVisibility("clear");
    setStartDetectionProfile("auto");
    setStartLightCalibration({});
    setCalibrationStatus("");
    setReactionTimeOffset(0.2);
    setMovementSensitivity("medium");
    setFirstMovementDefinition("earliest");
    setCommittedLaunchMinDelay(0.1);
    setOfficialTotalTime("");
    setCapturedFrame(null);
    setZones({});
    setBiomechanics(createDefaultBiomechanicsSession());
    setBiomechanicsRunning(false);
    setStartEvidenceStatus("");
    setTimestamps(INITIAL_TIMESTAMPS);
    setActiveSessionId(null);
    if (!sessionName || sessionName === "Untitled climb analysis") {
      setSessionName(fileName.replace(/\.[^/.]+$/, ""));
    }
  }

  function handleVideoUpload(event: ChangeEvent<HTMLInputElement>) {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before replacing the video.");
      event.target.value = "";
      return;
    }
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (previousObjectUrl.current) {
      URL.revokeObjectURL(previousObjectUrl.current);
    }

    const expectedSessionVideo = activeSessionId && metadata && metadata.fileName === file.name
      ? { ...metadata }
      : null;
    pendingSessionVideoMetadataRef.current = expectedSessionVideo;
    pendingVideoFileNameRef.current = file.name;

    const nextUrl = URL.createObjectURL(file);
    videoFileRef.current = file;
    previousObjectUrl.current = nextUrl;
    setVideoUrl(nextUrl);
    setMetadata({
      fileName: file.name,
      duration: 0,
      videoWidth: 0,
      videoHeight: 0,
      metadataLoaded: false,
    });
    setCapturedFrame(null);
    setFrameDebug(null);
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setMovementPreviewFrames({});
    setMovementPreviewRunning(false);
    if (expectedSessionVideo) {
      setSessionStatus(`Attaching ${file.name} to the loaded session. Verifying video metadata…`);
    } else {
      resetAnalysisForNewVideo(file.name);
      setSessionStatus("");
    }
  }

  function handleMetadataLoaded() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const actualMetadata: VideoMetadata = {
      fileName: pendingVideoFileNameRef.current ?? metadata?.fileName ?? "Local video",
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      metadataLoaded: true,
    };
    const expected = pendingSessionVideoMetadataRef.current;
    pendingSessionVideoMetadataRef.current = null;
    pendingVideoFileNameRef.current = null;
    setMetadata(actualMetadata);
    if (expected && !videoMetadataMatches(actualMetadata, expected)) {
      resetAnalysisForNewVideo(actualMetadata.fileName);
      setStartSearchEnd(Math.min(8, video.duration));
      setSessionStatus("The selected video does not match the loaded session metadata. Saved analysis was detached to prevent incorrect overlays.");
    } else if (expected) {
      setSessionStatus(`Matching video attached to "${sessionName}". Saved zones, timestamps, and biomechanics were preserved.`);
    } else {
      setStartSearchEnd(Math.min(8, video.duration));
    }
  }

  async function stepVideo(delta: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = clamp(video.currentTime + delta, 0, Math.max(0, video.duration - 0.001));
    setCurrentTime(video.currentTime);
  }

  function jumpTo(time: number | null | undefined) {
    const video = videoRef.current;
    if (!video || time === null || time === undefined || !Number.isFinite(time)) {
      return;
    }
    video.currentTime = clamp(time, 0, Math.max(0, video.duration - 0.001));
    setCurrentTime(video.currentTime);
  }

  async function runWithVideoRestore<T>(
    video: HTMLVideoElement,
    work: () => Promise<T>,
    completeMessage: string,
    taskName = "video analysis",
  ): Promise<T> {
    const previousTask = videoTaskQueueRef.current;
    let releaseTask!: () => void;
    const currentTask = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    videoTaskQueueRef.current = previousTask.catch(() => undefined).then(() => currentTask);
    await previousTask.catch(() => undefined);

    const previousTime = video.currentTime;
    const previousPaused = video.paused;
    setVideoRestoreStatus("");

    if (!previousPaused) {
      video.pause();
    }

    let workSucceeded = false;
    try {
      const output = await work();
      workSucceeded = true;
      return output;
    } finally {
      try {
        await seekTo(video, previousTime);
        setCurrentTime(video.currentTime);
        if (previousPaused) {
          video.pause();
        } else {
          await video.play();
        }
        setVideoRestoreStatus(
          workSucceeded
            ? completeMessage
            : `Video restored after ${taskName.replaceAll("-", " ")} stopped.`,
        );
      } catch (error) {
        setVideoRestoreStatus(
          error instanceof Error ? `Video restore failed: ${error.message}` : "Video restore failed.",
        );
      } finally {
        releaseTask();
      }
    }
  }

  function runNamedVideoTask<T>(taskName: string, work: () => Promise<T>, completeMessage: string): Promise<T> {
    const video = videoRef.current;
    if (!video) {
      return Promise.reject(new Error("Load a video before running analysis."));
    }
    return runWithVideoRestore(video, work, completeMessage, taskName);
  }

  async function runFrameSamplingTest() {
    const video = videoRef.current;
    const duration = video?.duration ?? null;
    const debug: FrameSamplingDebug = {
      videoElementFound: Boolean(video),
      metadataLoaded: Boolean(video && metadata?.metadataLoaded),
      duration,
      videoWidth: video?.videoWidth ?? null,
      videoHeight: video?.videoHeight ?? null,
      framesRequested: 0,
      framesSampled: 0,
      canvasDrawSucceeded: false,
      pixelDataReadSucceeded: false,
      samples: [],
      errors: [],
    };

    if (!video || !metadata?.metadataLoaded || !duration) {
      debug.errors.push("Video and metadata must be loaded before frame sampling.");
      setFrameDebug(debug);
      return;
    }

    setFrameTestRunning(true);
    const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 0.08)].map(roundTime);
    debug.framesRequested = times.length;

    try {
      await runWithVideoRestore(
        video,
        async () => {
          for (const time of times) {
            const sample = await sampleFrameAt(video, time);
            debug.samples.push(sample);
            if (sample.success) {
              debug.framesSampled += 1;
            } else if (sample.error) {
              debug.errors.push(sample.error);
            }
          }
          debug.canvasDrawSucceeded = debug.samples.some((sample) => sample.success);
          debug.pixelDataReadSucceeded = debug.samples.some((sample) => sample.success);
        },
        "Frame test complete. Video restored to previous position.",
      );
    } catch (error) {
      debug.errors.push(error instanceof Error ? error.message : "Unknown frame sampling error.");
    } finally {
      setFrameDebug(debug);
      setFrameTestRunning(false);
    }
  }

  function getPointerPosition(event: PointerEvent<HTMLElement>): PointerDebugInfo {
    const stage = zoneStageRef.current;
    const wrapper = zoneFrameWrapRef.current;
    const scrollTop = wrapper?.scrollTop ?? 0;
    const scrollLeft = wrapper?.scrollLeft ?? 0;

    if (!stage) {
      return {
        rawX: event.clientX,
        rawY: event.clientY,
        normalizedX: null,
        normalizedY: null,
        insideImage: false,
        scrollTop,
        scrollLeft,
      };
    }

    const imageRect = stage.getBoundingClientRect();
    const relativeX = event.clientX - imageRect.left;
    const relativeY = event.clientY - imageRect.top;
    const insideImage =
      relativeX >= 0 && relativeY >= 0 && relativeX <= imageRect.width && relativeY <= imageRect.height;

    return {
      rawX: event.clientX,
      rawY: event.clientY,
      normalizedX: insideImage ? clamp(relativeX / imageRect.width, 0, 1) : null,
      normalizedY: insideImage ? clamp(relativeY / imageRect.height, 0, 1) : null,
      insideImage,
      scrollTop,
      scrollLeft,
    };
  }

  function updatePointerDebug(event: PointerEvent<HTMLElement>) {
    setPointerDebug(getPointerPosition(event));
  }

  function pointerToNormalized(event: PointerEvent<HTMLElement>) {
    const pointer = getPointerPosition(event);
    setPointerDebug(pointer);
    if (!pointer.insideImage || pointer.normalizedX === null || pointer.normalizedY === null) {
      return null;
    }

    return {
      x: pointer.normalizedX,
      y: pointer.normalizedY,
    };
  }

  function captureCurrentFrameForZones() {
    const video = videoRef.current;
    if (videoAnalysisRunning || !video || !metadata?.metadataLoaded) {
      return;
    }

    const captured = captureFrame(video);
    setCapturedFrame(captured.dataUrl);
  }

  function beginZoneDrag(event: PointerEvent<HTMLDivElement>) {
    if (videoAnalysisRunning || !capturedFrame) {
      return;
    }
    const point = pointerToNormalized(event);
    if (!point) {
      return;
    }
    setDragStart(point);
    setDraftZone({
      id: selectedZoneId,
      label: zoneLabel(selectedZoneId),
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateZoneDrag(event: PointerEvent<HTMLDivElement>) {
    if (videoAnalysisRunning || !dragStart) {
      return;
    }
    const point = pointerToNormalized(event);
    if (!point) {
      return;
    }
    setDraftZone({
      id: selectedZoneId,
      label: zoneLabel(selectedZoneId),
      x1: dragStart.x,
      y1: dragStart.y,
      x2: point.x,
      y2: point.y,
    });
  }

  function finishZoneDrag(event: PointerEvent<HTMLDivElement>) {
    if (videoAnalysisRunning) {
      setDraftZone(null);
      setDragStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (!draftZone) {
      setDragStart(null);
      return;
    }

    const width = Math.abs(draftZone.x2 - draftZone.x1);
    const height = Math.abs(draftZone.y2 - draftZone.y1);
    if (width > 0.005 && height > 0.005) {
      setZones((current) => ({ ...current, [draftZone.id]: normalizeZone(draftZone) }));
    }
    setDraftZone(null);
    setDragStart(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function runStartSignalDetection() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    setStartRunning(true);
    try {
      await runWithVideoRestore(
        video,
        async () => {
          let result: StartSignalDetectionResult;
          if (resolvedStartProfile === "motion") {
            result = await detectMotionBasedStartEstimate({
                video,
                zone: zones.startBody,
                searchStart: startSearchStart,
                searchEnd: startSearchEnd,
                reactionOffset: reactionTimeOffset,
                sensitivity: startSensitivity,
              });
          } else if (zones.startLight && startDetectionProfile !== "auto") {
            result = await detectStartSignal({
                video,
                zone: zones.startLight,
                searchStart: startSearchStart,
                searchEnd: startSearchEnd,
                sensitivity: startSensitivity,
                lightVisibility: startLightVisibility,
                profile: resolvedStartProfile,
                calibration: startLightCalibration,
              });
          } else {
            setVideoRestoreStatus("Locating the green-to-blue start sensor…");
            const automaticLight = await detectAutomaticStartLight({
              video,
              searchStart: startSearchStart,
              searchEnd: startSearchEnd,
              onProgress: (processed, total) => {
                setVideoRestoreStatus(`Locating start sensor: ${processed}/${total} frames…`);
              },
            });
            if (automaticLight.found && automaticLight.zone && automaticLight.calibration && automaticLight.result) {
              const detectedZone = automaticLight.zone;
              setZones((current) => ({ ...current, startLight: detectedZone }));
              setStartLightCalibration(automaticLight.calibration);
              setStartDetectionProfile("calibrated");
              setCalibrationStatus("Green-to-blue start sensor found and calibrated automatically.");
              result = automaticLight.result;
            } else if (zones.startLight) {
              result = await detectStartSignal({
                video,
                zone: zones.startLight,
                searchStart: startSearchStart,
                searchEnd: startSearchEnd,
                sensitivity: startSensitivity,
                lightVisibility: startLightVisibility,
                profile: calibrationReady ? "calibrated" : "generic",
                calibration: startLightCalibration,
              });
            } else {
              result = await detectMotionBasedStartEstimate({
                video,
                zone: zones.startBody,
                searchStart: startSearchStart,
                searchEnd: startSearchEnd,
                reactionOffset: reactionTimeOffset,
                sensitivity: startSensitivity,
              });
            }
          }
          setStartResult(result);
        },
        "Start detection complete. Video restored to previous position.",
      );
    } catch (error) {
      setVideoRestoreStatus(error instanceof Error ? `Start detection failed: ${error.message}` : "Start detection failed.");
    } finally {
      setStartRunning(false);
    }
  }

  async function runMotionBasedStartEstimate() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    setStartDetectionProfile("motion");
    setStartRunning(true);
    try {
      await runWithVideoRestore(
        video,
        async () => {
          const result = await detectMotionBasedStartEstimate({
            video,
            zone: zones.startBody,
            searchStart: startSearchStart,
            searchEnd: startSearchEnd,
            reactionOffset: reactionTimeOffset,
            sensitivity: startSensitivity,
          });
          setStartResult(result);
        },
        "Motion-based start estimate complete. Video restored to previous position.",
      );
    } catch (error) {
      setVideoRestoreStatus(error instanceof Error ? `Motion-based start failed: ${error.message}` : "Motion-based start failed.");
    } finally {
      setStartRunning(false);
    }
  }

  async function setCalibrationSample(kind: "before" | "after") {
    const video = videoRef.current;
    const zone = zones.startLight;
    if (!video || !zone) {
      setCalibrationStatus("Draw Start Light Zone before setting calibration samples.");
      return;
    }

    if (videoAnalysisRunning) {
      setCalibrationStatus("Wait for the active video analysis to finish before sampling the light.");
      return;
    }

    let sample;
    try {
      sample = await sampleZoneAverageColor(video, video.currentTime, zone);
    } catch (error) {
      setCalibrationStatus(error instanceof Error ? `Calibration sample failed: ${error.message}` : "Calibration sample failed.");
      return;
    }
    setStartLightCalibration((current) => {
      const next: StartLightCalibration = {
        ...current,
        beforeStartRGB: kind === "before" ? sample.averageRgb : current.beforeStartRGB,
        afterStartRGB: kind === "after" ? sample.averageRgb : current.afterStartRGB,
        calibrationFrameBeforeTime: kind === "before" ? roundTime(sample.time) : current.calibrationFrameBeforeTime,
        calibrationFrameAfterTime: kind === "after" ? roundTime(sample.time) : current.calibrationFrameAfterTime,
      };
      if (next.beforeStartRGB && next.afterStartRGB) {
        next.colorDelta = rgbDistance(next.beforeStartRGB, next.afterStartRGB);
      }
      return next;
    });
    setCalibrationStatus(`${kind === "before" ? "Before-start" : "After-start"} sample set at ${sample.time.toFixed(3)}s.`);
  }

  async function runFirstMovementDetection() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    setMovementRunning(true);
    setMovementPreviewFrames({});
    try {
      const result = await runWithVideoRestore(
        video,
        async () => {
          return detectFirstMovement({
            video,
            zone: zones.startBody,
            startSignalRawTime: startSignalRaw ?? undefined,
            sensitivity: movementSensitivity,
            movementDefinition: firstMovementDefinition,
            committedLaunchMinDelay,
          });
        },
        "First movement detection complete. Video restored to previous position.",
      );
      setMovementResult(result);
    } catch (error) {
      setVideoRestoreStatus(error instanceof Error ? `First movement detection failed: ${error.message}` : "First movement detection failed.");
    } finally {
      setMovementRunning(false);
    }
  }

  async function runAutomaticAnalysis() {
    const video = videoRef.current;
    if (!video || !metadata?.metadataLoaded) {
      setAutoAnalysisStatus("Load a video and wait for its metadata first.");
      return;
    }

    const abortController = new AbortController();
    autoAnalysisAbortRef.current = abortController;
    setAutoAnalysisRunning(true);
    setAutoAnalysisStatus("Finding the start signal…");
    setStartEvidenceStatus("");
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setMovementPreviewFrames({});
    let reviewSeekTarget: number | null = null;

    try {
      await runWithVideoRestore(
        video,
        async () => {
          const searchStart = clamp(startSearchStart, 0, Math.max(0, video.duration - 0.5));
          const searchEnd = Math.min(
            video.duration,
            Math.max(
              searchStart + 0.5,
              Number.isFinite(startSearchEnd) ? startSearchEnd : 0,
              Math.min(12, video.duration),
            ),
          );
          setAutoAnalysisStatus("Scanning both lanes for faint start lights and listening for the countdown…");
          const audioPromise: Promise<AudioStartResult> = videoFileRef.current
            ? detectAudioStartSignal({
                file: videoFileRef.current,
                searchStart,
                searchEnd,
                signal: abortController.signal,
              })
            : Promise.resolve({
                found: false,
                confidence: "None",
                reason: "The original local video file is unavailable for audio analysis.",
                segments: [],
              });
          const automaticLight = await detectAutomaticStartLight({
            video,
            searchStart,
            searchEnd,
            startBodyZone: zones.startBody,
            signal: abortController.signal,
            onProgress: (processed, total) => {
              setAutoAnalysisStatus(`Scanning lane lights: ${processed}/${total} frames… Audio is being checked too.`);
            },
          });
          const colorResults = (automaticLight.laneResults ?? (automaticLight.result ? [automaticLight.result] : []))
            .filter((result) => result.detected && result.rawTime !== undefined);
          if (automaticLight.found && automaticLight.zone && automaticLight.calibration) {
            setZones((current) => ({ ...current, startLight: automaticLight.zone }));
            setStartLightCalibration(automaticLight.calibration);
            setStartDetectionProfile("calibrated");
            setCalibrationStatus(
              `${automaticLight.laneCandidates?.length ?? 1} lane-light candidate${(automaticLight.laneCandidates?.length ?? 1) === 1 ? "" : "s"} found. Primary sensor is near ${Math.round(((automaticLight.zone.x1 + automaticLight.zone.x2) / 2) * 100)}% across and ${Math.round(((automaticLight.zone.y1 + automaticLight.zone.y2) / 2) * 100)}% down the frame.`,
            );
          }

          if (!colorResults.length && zones.startLight) {
            setAutoAnalysisStatus("Automatic light search was inconclusive. Checking the saved Start Light Zone…");
            const savedZoneResult = await detectStartSignal({
                video,
                zone: zones.startLight,
                searchStart,
                searchEnd,
                sensitivity: startSensitivity,
                lightVisibility: startLightVisibility,
                profile: calibrationReady ? "calibrated" : "auto",
                calibration: startLightCalibration,
                signal: abortController.signal,
              });
            if (savedZoneResult.detected && savedZoneResult.rawTime !== undefined) {
              colorResults.push(savedZoneResult);
            }
          }

          if (abortController.signal.aborted) {
            throw new PoseAnalysisCancelledError();
          }
          const audioStart = await audioPromise;
          setAutoAnalysisStatus("Comparing lane lights, final beep, and body motion…");
          const motionStart = await detectMotionBasedStartEstimate({
            video,
            zone: zones.startBody,
            searchStart,
            searchEnd,
            reactionOffset: reactionTimeOffset,
            sensitivity: startSensitivity,
          });

          if (abortController.signal.aborted) {
            throw new PoseAnalysisCancelledError();
          }

          const evidence: StartEvidence[] = colorResults.map((result, index) => ({
            kind: "color",
            rawTime: result.rawTime!,
            confidence: result.confidence,
            reason: result.reason,
            label: `lane light ${index + 1}`,
          }));
          if (audioStart.found && audioStart.rawTime !== undefined) {
            evidence.push({
              kind: "audio",
              rawTime: audioStart.rawTime,
              confidence: audioStart.confidence,
              reason: audioStart.reason,
              label: "final countdown beep",
            });
          }
          if (motionStart.detected && motionStart.rawTime !== undefined) {
            evidence.push({
              kind: "motion",
              rawTime: motionStart.rawTime,
              confidence: motionStart.confidence,
              reason: motionStart.reason,
              label: "body motion estimate",
            });
          }
          const decision = fuseStartEvidence(evidence);
          setStartEvidenceStatus(
            `${decision.reason} Audio: ${audioStart.reason}`,
          );
          if (!decision.found || decision.rawTime === undefined) {
            setAutoAnalysisStatus("Start could not be confirmed. Use the current-frame button or open Manual timing settings.");
            return;
          }

          const closestColor = colorResults
            .filter((result) => result.rawTime !== undefined)
            .sort((left, right) => Math.abs(left.rawTime! - decision.rawTime!) - Math.abs(right.rawTime! - decision.rawTime!))[0];
          const baseResult = closestColor ?? (motionStart.detected ? motionStart : buildAudioStartResult(audioStart));
          const automaticStart: StartSignalDetectionResult = {
            ...baseResult,
            detected: true,
            rawTime: decision.rawTime,
            confidence: decision.confidence,
            reason: decision.reason,
            candidates: evidence.map((item) => ({
              rawTime: item.rawTime,
              confidence: item.confidence,
              reason: item.reason,
              score: item.kind === "motion" ? 1 : 2,
              kind: item.label ?? item.kind,
              method: `Start fusion: ${item.kind}`,
            })),
            debug: {
              ...baseResult.debug,
              detectionMethod: "Fused lane-light, final-beep, and motion evidence",
              selectedCandidateTime: decision.rawTime,
              selectedCandidateReason: decision.reason,
              detectedRawTime: decision.rawTime,
            },
          };
          setStartResult(automaticStart);
          if (!decision.autoAccept) {
            setSuggestedStartRawTime(decision.rawTime);
            reviewSeekTarget = decision.rawTime;
            setAutoAnalysisStatus(
              `Start evidence needs review. The video has been moved to the suggested start at ${decision.rawTime.toFixed(3)}s — if the frame looks right, press "Accept suggested start", or use the current frame instead.`,
            );
            return;
          }

          const acceptedStart = Math.max(0, roundTime(decision.rawTime + startSignalOffset));
          acceptTimestamp(
            "startSignal",
            acceptedStart,
            startSourceForResult(automaticStart),
            automaticStart.confidence,
            {
              detectedRawTime: decision.rawTime,
              offsetApplied: startSignalOffset,
              note: `Automatically accepted by Quick Analyze. ${automaticStart.reason}`,
            },
          );

          setAutoAnalysisStatus("Start found. Detecting the first visible movement…");
          const automaticMovementAccepted = await detectAndMaybeAcceptFirstMovement(
            video,
            acceptedStart,
            "Automatically accepted by Quick Analyze.",
            abortController.signal,
          );

          const calibrationValidation = validateWallCalibration(biomechanics.calibration);
          if (!calibrationValidation.valid || !biomechanics.calibration) {
            setAutoAnalysisStatus(
              `Timing finished${automaticMovementAccepted ? " and first movement was accepted" : "; first movement needs review"}. To add center of mass, do the one-time four-corner wall calibration below, then press Quick Analyze again.`,
            );
            return;
          }

          const acceptedFinish = getTimestamp(timestamps, "finishPad").rawTime;
          const officialDuration = Number(officialTotalTime);
          const inferredFinish = Number.isFinite(officialDuration) && officialDuration > 0
            ? acceptedStart + officialDuration
            : video.duration;
          const poseEnd = Math.min(
            video.duration,
            acceptedFinish !== null && acceptedFinish > acceptedStart ? acceptedFinish : inferredFinish,
          );
          if (poseEnd <= acceptedStart + 0.2) {
            throw new Error("The automatic pose range is too short. Check the accepted start and finish markers.");
          }

          const maxSafeFps = (poseEnd - acceptedStart) * biomechanics.settings.sampleFps > 450
            ? 5
            : biomechanics.settings.sampleFps;
          const automaticSettings = { ...biomechanics.settings, sampleFps: maxSafeFps };
          setBiomechanicsRunning(true);
          setAutoAnalysisStatus("Timing finished. Following the climber and calculating center of mass…");
          try {
            const poseResult = await analyzePoseVideo({
              video,
              startRawTime: acceptedStart,
              endRawTime: poseEnd,
              settings: automaticSettings,
              calibration: biomechanics.calibration,
              identityZone: zones.startBody,
              signal: abortController.signal,
              onProgress: (progress) => {
                if (progress.phase === "analyzing") {
                  setAutoAnalysisStatus(`Following the climber: ${progress.processed}/${progress.total} frames…`);
                }
              },
            });
            setBiomechanics((current) => ({
              ...current,
              settings: automaticSettings,
              result: poseResult,
            }));
            const selectedFrames = poseResult.metrics.selectedFrames ?? poseResult.metrics.detectedFrames;
            if (poseResult.metrics.validFrames > 0) {
              setAutoAnalysisStatus(
                `Quick Analyze finished: ${poseResult.metrics.validFrames}/${poseResult.metrics.requestedFrames} usable COM frames${automaticMovementAccepted ? ", with start and first movement accepted." : "; first movement still needs review."}`,
              );
            } else if (poseResult.metrics.detectedFrames === 0) {
              setAutoAnalysisStatus("Timing finished, but the pose scan still found no athlete. Recheck the wall corners and make the Start Body Zone surround the climber at the start.");
            } else {
              setAutoAnalysisStatus(`The athlete was tracked on ${selectedFrames} frames, but no frame had enough visible hips, knees, and shoulders for a reliable COM estimate.`);
            }
          } finally {
            setBiomechanicsRunning(false);
          }
        },
        "Quick Analyze finished. Video restored to its previous position.",
        "Quick Analyze",
      );
      if (reviewSeekTarget !== null) {
        jumpTo(reviewSeekTarget);
      }
    } catch (error) {
      if (error instanceof PoseAnalysisCancelledError || abortController.signal.aborted) {
        setAutoAnalysisStatus("Quick Analyze cancelled. Existing accepted results were kept.");
      } else {
        setAutoAnalysisStatus(error instanceof Error ? `Quick Analyze stopped: ${error.message}` : "Quick Analyze stopped.");
      }
    } finally {
      autoAnalysisAbortRef.current = null;
      setAutoAnalysisRunning(false);
      setBiomechanicsRunning(false);
    }
  }

  async function detectAndMaybeAcceptFirstMovement(
    video: HTMLVideoElement,
    acceptedStart: number,
    notePrefix: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const automaticMovement = await detectFirstMovement({
      video,
      zone: zones.startBody,
      startSignalRawTime: acceptedStart,
      sensitivity: movementSensitivity,
      movementDefinition: firstMovementDefinition,
      committedLaunchMinDelay,
    });
    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    setMovementResult(automaticMovement);
    const accepted = Boolean(
      automaticMovement.detected &&
      automaticMovement.rawTime !== undefined &&
      automaticMovement.confidence !== "Low" &&
      !automaticMovement.debug.suspiciousFirstFrameDetection &&
      !automaticMovement.debug.movementAlreadyUnderway,
    );
    if (accepted && automaticMovement.rawTime !== undefined) {
      const markerId = firstMovementDefinition === "committed" ? "committedLaunch" : "firstMovement";
      acceptTimestamp(
        markerId,
        Math.max(0, roundTime(automaticMovement.rawTime + firstMovementOffset)),
        "Body motion detection",
        automaticMovement.confidence,
        {
          detectedRawTime: automaticMovement.rawTime,
          offsetApplied: firstMovementOffset,
          note: `${notePrefix} ${automaticMovement.reason}`,
        },
      );
    }
    return accepted;
  }

  async function acceptSuggestedStart() {
    const video = videoRef.current;
    if (suggestedStartRawTime === null) {
      return;
    }
    const source = startResult ? startSourceForResult(startResult) : "Fused start detection";
    const confidence: Confidence = startResult && startResult.confidence !== "None" ? startResult.confidence : "Medium";
    const acceptedStart = Math.max(0, roundTime(suggestedStartRawTime + startSignalOffset));
    acceptTimestamp("startSignal", acceptedStart, source, confidence, {
      detectedRawTime: suggestedStartRawTime,
      offsetApplied: startSignalOffset,
      note: "Suggested by Quick Analyze and accepted after review.",
    });
    setSuggestedStartRawTime(null);
    if (!video) {
      setAutoAnalysisStatus(`Start accepted at ${acceptedStart.toFixed(3)}s.`);
      return;
    }
    setAutoAnalysisRunning(true);
    setAutoAnalysisStatus(`Start accepted at ${acceptedStart.toFixed(3)}s. Detecting the first visible movement…`);
    try {
      const movementAccepted = await runWithVideoRestore(
        video,
        () => detectAndMaybeAcceptFirstMovement(video, acceptedStart, "Automatically detected after the reviewed start was accepted."),
        "First movement search finished. Video restored to its previous position.",
        "first movement detection",
      );
      setAutoAnalysisStatus(
        movementAccepted
          ? `Start accepted at ${acceptedStart.toFixed(3)}s and First Movement was detected automatically.`
          : `Start accepted at ${acceptedStart.toFixed(3)}s. Review First Movement in its card below.`,
      );
    } catch (error) {
      setAutoAnalysisStatus(error instanceof Error ? `First movement search stopped: ${error.message}` : "First movement search stopped.");
    } finally {
      setAutoAnalysisRunning(false);
    }
  }

  function acceptTimestamp(
    id: TimestampMarker["id"],
    rawTime: number,
    source: TimestampSource,
    confidence: Confidence,
    metadata?: { detectedRawTime?: number; offsetApplied?: number; note?: string },
  ) {
    setTimestamps((current) =>
      recalculateTimestampClimbs(
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                rawTime: roundTime(rawTime),
                climbTime: id === "startSignal" ? 0 : item.climbTime,
                detectedRawTime: metadata?.detectedRawTime ?? rawTime,
                offsetApplied: metadata?.offsetApplied ?? 0,
                note: metadata?.note,
                source,
                confidence,
              }
            : item,
        ),
      ),
    );
  }

  function clearTimestamp(id: TimestampMarker["id"]) {
    setTimestamps((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              rawTime: null,
              climbTime: null,
              source: "Not set",
              confidence: "None",
            }
          : item,
      ),
    );
  }

  function setTimestampFromInput(id: TimestampMarker["id"], value: string, mode: "raw" | "climb") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }

    const startRaw = getTimestamp(timestamps, "startSignal").rawTime ?? startResult?.rawTime;
    const rawTime = mode === "climb" && startRaw !== null && startRaw !== undefined ? startRaw + parsed : parsed;
    acceptTimestamp(id, rawTime, "Manual", "Medium");
  }

  function buildDebugReport(): DetectionDebugReport {
    return {
      videoMetadata: metadata,
      zones,
      frameSamplingTest: frameDebug,
      startSignalDetection: startResult?.debug ?? null,
      firstMovementDetection: movementResult?.debug ?? null,
      acceptedTimestamps: timestamps,
    };
  }

  async function copyDebugReport() {
    const report = JSON.stringify(buildDebugReport(), null, 2);
    await navigator.clipboard.writeText(report);
    setCopyStatus("Copied");
    window.setTimeout(() => setCopyStatus(""), 1800);
  }

  function buildDetectionWarnings() {
    const warnings: string[] = [];
    if (startResult?.debug.failureReason) {
      warnings.push(startResult.debug.failureReason);
    }
    if (movementResult?.debug.failureReason) {
      warnings.push(movementResult.debug.failureReason);
    }
    if (movementResult?.debug.movementAlreadyUnderway) {
      warnings.push("Movement appears to already be underway near Start Signal.");
    }
    if (movementResult?.debug.suspiciousFirstFrameDetection) {
      warnings.push("First Movement candidate occurred at the first sampled frame.");
    }
    if (zones.startLight && zoneArea(zones.startLight) > 0.05) {
      warnings.push("Start Light Zone may be large for light detection.");
    }
    if (zones.startBody && zoneArea(zones.startBody) > 0.3) {
      warnings.push("Start Body Zone is large and may include background motion.");
    }
    return warnings;
  }

  function formatCalibrationNote() {
    if (!startLightCalibration.colorDelta) {
      return "Not set";
    }
    return `Before ${formatRgb(startLightCalibration.beforeStartRGB)}, after ${formatRgb(startLightCalibration.afterStartRGB)}, delta ${startLightCalibration.colorDelta.toFixed(3)}.`;
  }

  function buildDatasetExport() {
    const session = buildSessionSnapshot();
    const splits = buildSplitMap(splitRows);
    const acceptedTimestamps = timestamps.map((item) => ({
      markerId: item.id,
      label: item.label,
      acceptedRawTime: item.rawTime,
      climbTime: item.climbTime,
      detectedRawTime: item.detectedRawTime ?? null,
      offsetApplied: item.offsetApplied ?? 0,
      source: item.source,
      confidence: item.confidence,
      userAccepted: item.rawTime !== null,
      userAdjusted: item.rawTime !== null && item.detectedRawTime !== undefined && item.detectedRawTime !== null
        ? Math.abs(item.rawTime - item.detectedRawTime) > 0.001
        : false,
      note: item.note ?? "",
    }));

    return {
      appVersion: APP_VERSION,
      exportTimestamp: new Date().toISOString(),
      session: {
        sessionId: session.id,
        sessionName: session.name,
        climberName: session.climberName,
        date: session.date,
        notes: session.notes,
        location: session.location,
        gym: session.location,
        attemptType: session.attemptType,
      },
      video: {
        fileName: metadata?.fileName ?? session.videoFileName ?? "",
        duration: metadata?.duration ?? null,
        videoWidth: metadata?.videoWidth ?? null,
        videoHeight: metadata?.videoHeight ?? null,
        officialTotalTime: parseOptionalNumber(officialTotalTime),
      },
      zones: {
        startLightZone: zones.startLight ?? null,
        startBodyZone: zones.startBody ?? null,
        hold10Zone: zones.hold10 ?? null,
        finishLightZone: zones.finishLight ?? null,
      },
      calibration: {
        beforeStartRGB: startLightCalibration.beforeStartRGB ?? null,
        afterStartRGB: startLightCalibration.afterStartRGB ?? null,
        calibrationFrameBeforeTime: startLightCalibration.calibrationFrameBeforeTime ?? null,
        calibrationFrameAfterTime: startLightCalibration.calibrationFrameAfterTime ?? null,
        colorDelta: startLightCalibration.colorDelta ?? null,
      },
      settings: session.settings,
      acceptedTimestamps,
      candidates: {
        startSignal: exportCandidates(startResult?.candidates ?? [], getTimestamp(timestamps, "startSignal")),
        firstMovement: exportCandidates(movementResult?.candidates ?? [], getTimestamp(timestamps, "firstMovement")),
        committedLaunch: exportCandidates(movementResult?.candidates ?? [], getTimestamp(timestamps, "committedLaunch")),
      },
      splitCalculations: splits,
      detectionWarnings: buildDetectionWarnings(),
      biomechanics,
      athleteNotes: sessionNotes.trim(),
    };
  }

  function buildObsidianMarkdown() {
    const dataset = buildDatasetExport();
    const start = getTimestamp(timestamps, "startSignal");
    const earliest = getTimestamp(timestamps, "firstMovement");
    const committed = getTimestamp(timestamps, "committedLaunch");
    const firstHold = getTimestamp(timestamps, "firstHold");
    const hold10 = getTimestamp(timestamps, "hold10");
    const finish = getTimestamp(timestamps, "finishPad");
    const splits = buildSplitMap(splitRows);
    const calculatedTotal = splits["Calculated Total Time"];
    const reactionTime = splits["Reaction Time"];
    const launchDelay = splits["Launch Delay"];
    const official = parseOptionalNumber(officialTotalTime);
    const date = attemptDate || todayDateString();

    return `---\n` +
      `type: climbiq-attempt\n` +
      `climber: ${yamlString(climberName)}\n` +
      `date: ${yamlString(date)}\n` +
      `session_name: ${yamlString(sessionName)}\n` +
      `video_file: ${yamlString(metadata?.fileName ?? "")}\n` +
      `official_time: ${yamlNumber(official)}\n` +
      `reaction_time: ${yamlNumber(reactionTime)}\n` +
      `launch_delay: ${yamlNumber(launchDelay)}\n` +
      `calculated_total_time: ${yamlNumber(calculatedTotal)}\n` +
      `tags:\n` +
      `  - climbiq\n` +
      `  - speed-climbing\n` +
      `  - training-log\n` +
      `---\n\n` +
      `# ClimbIQ Attempt - ${date}\n\n` +
      `## Summary\n` +
      `- Session: ${sessionName || "Not set"}\n` +
      `- Climber: ${climberName || "Not set"}\n` +
      `- Video file: ${metadata?.fileName ?? "Not set"}\n` +
      `- Official time: ${formatExportTime(official)}\n` +
      `- Calculated total: ${formatExportTime(calculatedTotal)}\n` +
      `- Attempt type: ${attemptType || "Not set"}\n` +
      `- Location / gym: ${attemptLocation || "Not set"}\n` +
      `- Notes: ${sessionNotes || "Not set"}\n\n` +
      `## Accepted Timestamps\n\n` +
      `| Marker | Raw Video Time | Climb Time | Source | Confidence | Offset |\n` +
      `|---|---:|---:|---|---|---:|\n` +
      markdownTimestampRow("Start Signal", start) +
      markdownTimestampRow("Earliest Visible Motion", earliest) +
      markdownTimestampRow("Committed Launch", committed) +
      markdownTimestampRow("First Hold", firstHold) +
      markdownTimestampRow("Hold 10", hold10) +
      markdownTimestampRow("Finish Pad", finish) +
      `\n## Splits\n\n` +
      `| Split | Time |\n` +
      `|---|---:|\n` +
      markdownSplitRow("Reaction Time", splits) +
      markdownSplitRow("Launch Delay", splits) +
      markdownSplitRow("Preload Gap", splits) +
      markdownSplitRow("Start to First Hold", splits) +
      markdownSplitRow("Movement to First Hold", splits) +
      markdownSplitRow("First Hold to Hold 10", splits) +
      markdownSplitRow("Hold 10 to Finish", splits) +
      markdownSplitRow("Movement Time", splits) +
      markdownSplitRow("Launch-to-Finish Time", splits) +
      markdownSplitRow("Calculated Total Time", splits) +
      `\n## Detection Notes\n` +
      `- Start Signal: ${start.note || startResult?.reason || "Not set"}\n` +
      `- First Movement: ${earliest.note || movementResult?.reason || "Not set"}\n` +
      `- Calibration: ${formatCalibrationNote()}\n` +
      `- Warnings: ${buildDetectionWarnings().join("; ") || "None"}\n\n` +
      `## Athlete Notes\n` +
      `Write observations here.\n\n` +
      `## Review Questions\n` +
      `- Where did I lose time?\n` +
      `- Was the start reaction clean?\n` +
      `- Was the launch delayed?\n` +
      `- Did I lose more time before or after Hold 10?\n` +
      `- What should I focus on next?\n\n` +
      `## Machine Data\n\n` +
      "```json\n" +
      JSON.stringify({
        session: dataset.session,
        video: dataset.video,
        timestamps: dataset.acceptedTimestamps,
        splits: dataset.splitCalculations,
        zones: dataset.zones,
        calibration: dataset.calibration,
        settings: dataset.settings,
        biomechanics: dataset.biomechanics,
        warnings: dataset.detectionWarnings,
      }, null, 2) +
      "\n```\n";
  }

  async function copyObsidianNote() {
    await navigator.clipboard.writeText(buildObsidianMarkdown());
    setExportStatus("Obsidian note copied.");
  }

  function downloadMarkdown() {
    const name = `${slugify(sessionName || "climbiq-attempt")}.md`;
    downloadTextFile(name, buildObsidianMarkdown(), "text/markdown");
    setExportStatus(`Downloaded ${name}.`);
  }

  async function copyDatasetJson() {
    await navigator.clipboard.writeText(JSON.stringify(buildDatasetExport(), null, 2));
    setExportStatus("Dataset JSON copied.");
  }

  function downloadDatasetJson() {
    const name = `${slugify(sessionName || "climbiq-attempt")}.climbiq-dataset.json`;
    downloadTextFile(name, JSON.stringify(buildDatasetExport(), null, 2), "application/json");
    setExportStatus(`Downloaded ${name}.`);
  }

  async function chooseObsidianFolder() {
    if (!("showDirectoryPicker" in window)) {
      setExportStatus("Direct folder saving works only in supported desktop browsers. Downloads and copy buttons work everywhere.");
      return;
    }

    try {
      obsidianDirectoryHandle.current = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      setObsidianFolderName(obsidianDirectoryHandle.current?.name ?? "Selected folder");
      setExportStatus("Obsidian folder selected.");
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : "Folder selection cancelled.");
    }
  }

  async function saveExportsToObsidianFolder() {
    if (!obsidianDirectoryHandle.current) {
      setExportStatus("Choose an Obsidian folder first.");
      return;
    }

    try {
      const baseName = slugify(sessionName || "climbiq-attempt");
      await writeFileToDirectory(obsidianDirectoryHandle.current, `${baseName}.md`, buildObsidianMarkdown());
      await writeFileToDirectory(obsidianDirectoryHandle.current, `${baseName}.climbiq-dataset.json`, JSON.stringify(buildDatasetExport(), null, 2));
      setExportStatus(`Saved Markdown and JSON to ${obsidianFolderName || "selected folder"}.`);
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : "Could not save to selected folder.");
    }
  }

  function buildSessionSnapshot(id = activeSessionId ?? createSessionId()): SavedAnalysisSession {
    const existing = savedSessions.find((session) => session.id === id);
    const name = sessionName.trim() || metadata?.fileName?.replace(/\.[^/.]+$/, "") || "Untitled climb analysis";
    const now = new Date().toISOString();

    return {
      id,
      version: 1,
      name,
      climberName: climberName.trim(),
      date: attemptDate,
      location: attemptLocation.trim(),
      attemptType: attemptType.trim(),
      notes: sessionNotes.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      videoFileName: metadata?.fileName,
      videoMetadata: metadata,
      zones,
      startLightCalibration,
      settings: {
        startSearchStart,
        startSearchEnd,
        startSensitivity,
        startLightVisibility,
        startDetectionProfile,
        reactionTimeOffset,
        startSignalOffset,
        movementSensitivity,
        firstMovementDefinition,
        committedLaunchMinDelay,
        firstMovementOffset,
        officialTotalTime,
      },
      timestamps,
      splitCalculations: buildSplitMap(splitRows),
      biomechanics: compactBiomechanicsSession(biomechanics),
    };
  }

  function saveCurrentSession() {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before saving the session.");
      return;
    }
    const session = buildSessionSnapshot();
    const next = [session, ...savedSessions.filter((item) => item.id !== session.id)].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    setSavedSessions(next);
    writeSavedSessions(next);
    setActiveSessionId(session.id);
    setSessionName(session.name);
    setSessionStatus(`Saved "${session.name}" locally.`);
  }

  function applySession(session: SavedAnalysisSession) {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active video analysis to finish before loading another session.");
      return;
    }
    const currentVideoMatches = Boolean(
      videoUrl && metadata?.metadataLoaded && session.videoMetadata && videoMetadataMatches(metadata, session.videoMetadata),
    );
    if (!currentVideoMatches) {
      if (previousObjectUrl.current) {
        URL.revokeObjectURL(previousObjectUrl.current);
        previousObjectUrl.current = null;
      }
      setVideoUrl(null);
      videoFileRef.current = null;
      setCurrentTime(0);
      setCapturedFrame(null);
      pendingSessionVideoMetadataRef.current = null;
      pendingVideoFileNameRef.current = null;
    }
    setActiveSessionId(session.id);
    setSessionName(session.name);
    setClimberName(session.climberName ?? "");
    setAttemptDate(session.date || todayDateString());
    setAttemptLocation(session.location ?? "");
    setAttemptType(session.attemptType ?? "Training");
    setSessionNotes(session.notes ?? "");
    setZones(session.zones ?? {});
    setStartLightCalibration(session.startLightCalibration ?? {});
    setStartSearchStart(session.settings.startSearchStart);
    setStartSearchEnd(session.settings.startSearchEnd);
    setStartSensitivity(session.settings.startSensitivity);
    setStartLightVisibility(session.settings.startLightVisibility);
    setStartDetectionProfile(session.settings.startDetectionProfile);
    setReactionTimeOffset(session.settings.reactionTimeOffset);
    setStartSignalOffset(session.settings.startSignalOffset);
    setMovementSensitivity(session.settings.movementSensitivity);
    setFirstMovementDefinition(session.settings.firstMovementDefinition);
    setCommittedLaunchMinDelay(session.settings.committedLaunchMinDelay);
    setFirstMovementOffset(session.settings.firstMovementOffset);
    setOfficialTotalTime(session.settings.officialTotalTime);
    setTimestamps(recalculateTimestampClimbs(mergeTimestampDefaults(session.timestamps ?? [])));
    setBiomechanics(sanitizeBiomechanicsSession(session.biomechanics));
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setFrameDebug(null);
    if (!currentVideoMatches) {
      setMetadata(session.videoMetadata ? { ...session.videoMetadata, metadataLoaded: false } : null);
    }
    setSessionStatus(currentVideoMatches
      ? `Loaded "${session.name}" with the matching local video still attached.`
      : `Loaded "${session.name}". Reupload the matching local video before running frame or pose analysis.`);
  }

  function loadSelectedSession(sessionId: string) {
    const session = savedSessions.find((item) => item.id === sessionId);
    if (session) {
      applySession(session);
    }
  }

  function deleteActiveSession() {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before deleting a session.");
      return;
    }
    if (!activeSessionId) {
      setSessionStatus("Choose a saved session before deleting.");
      return;
    }
    const next = savedSessions.filter((session) => session.id !== activeSessionId);
    setSavedSessions(next);
    writeSavedSessions(next);
    setActiveSessionId(null);
    setSessionStatus("Saved session deleted.");
  }

  function renameActiveSession() {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before renaming the session.");
      return;
    }
    if (!activeSessionId) {
      setSessionStatus("Load a saved session before renaming.");
      return;
    }

    const nextName = sessionName.trim();
    if (!nextName) {
      setSessionStatus("Enter a session name before renaming.");
      return;
    }

    const next = savedSessions.map((session) =>
      session.id === activeSessionId
        ? { ...session, name: nextName, updatedAt: new Date().toISOString() }
        : session,
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setSavedSessions(next);
    writeSavedSessions(next);
    setSessionStatus(`Renamed session to "${nextName}".`);
  }

  function duplicateActiveSession() {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before duplicating a session.");
      return;
    }
    const source = activeSessionId
      ? savedSessions.find((session) => session.id === activeSessionId)
      : buildSessionSnapshot();
    if (!source) {
      setSessionStatus("No session available to duplicate.");
      return;
    }

    const now = new Date().toISOString();
    const duplicate = {
      ...source,
      id: createSessionId(),
      name: `${source.name} copy`,
      createdAt: now,
      updatedAt: now,
    };
    const next = [duplicate, ...savedSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setSavedSessions(next);
    writeSavedSessions(next);
    applySession(duplicate);
    setSessionStatus(`Duplicated "${source.name}".`);
  }

  function exportCurrentSession() {
    const session = buildSessionSnapshot();
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(session.name)}.climbiq-session.json`;
    link.click();
    URL.revokeObjectURL(url);
    setSessionStatus(`Exported "${session.name}" as JSON.`);
  }

  async function importSession(event: ChangeEvent<HTMLInputElement>) {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before importing a session.");
      event.target.value = "";
      return;
    }
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());
      const parsedSession = isDatasetExport(parsed) ? datasetToSavedSession(parsed) : parsed;
      if (!isSavedAnalysisSession(parsedSession)) {
        throw new Error("This file is not a ClimbIQ analysis session.");
      }

      const session = {
        ...parsedSession,
        id: parsedSession.id || createSessionId(),
        updatedAt: new Date().toISOString(),
      };
      const next = [session, ...savedSessions.filter((item) => item.id !== session.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      setSavedSessions(next);
      writeSavedSessions(next);
      applySession(session);
      setSessionStatus(`Session imported. Reload the matching local video file if you want to review frames.`);
      setExportStatus(`Imported "${session.name}".`);
    } catch (error) {
      setSessionStatus(error instanceof Error ? error.message : "Session import failed.");
    } finally {
      event.target.value = "";
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">ClimbIQ Detection Lab</p>
          <h1>Upload a climb. Let ClimbIQ find the important moments.</h1>
          <p className="hero-copy">
            Automatic green-to-blue start timing, first movement, and calibrated center-of-mass analysis—all on your device.
          </p>
        </div>
      </header>

      <section className="layout-grid">
        <Card title="1. Video Upload">
          <input className="file-input" type="file" accept="video/*" onChange={handleVideoUpload} disabled={videoAnalysisRunning} />
          <div className="meta-grid">
            <Metric label="File" value={metadata?.fileName ?? "No video loaded"} />
            <Metric label="Duration" value={metadata?.duration ? `${metadata.duration.toFixed(3)}s` : "Not loaded"} />
            <Metric
              label="Resolution"
              value={metadata?.videoWidth ? `${metadata.videoWidth} x ${metadata.videoHeight}` : "Not loaded"}
            />
            <Metric label="Metadata" value={metadata?.metadataLoaded ? "Loaded" : "Waiting"} />
          </div>
          <div className="quick-analysis-box">
            <div>
              <strong>Quick Analyze</strong>
              <p className="muted">
                One click compares left/right lane lights, the countdown or single loud start beep, and body motion. The light search stays low in the frame, where the start box sits below the first two holds, and early rocking is ignored when the synchronized cues agree later.
              </p>
            </div>
            <div className="readiness-row" aria-label="Analysis readiness">
              <span className="time-pill">
                Start light: {zones.startLight?.label.startsWith("Auto-detected") ? "located automatically" : "automatic green → blue search"}
              </span>
              <span className="time-pill">Audio: countdown or single loud beep, detected locally</span>
              <span className="time-pill">
                Center of mass: {validateWallCalibration(biomechanics.calibration).valid ? "ready" : "needs one-time wall calibration"}
              </span>
            </div>
            <div className="button-row">
              <button
                className="primary"
                onClick={runAutomaticAnalysis}
                disabled={!metadata?.metadataLoaded || videoAnalysisRunning}
              >
                {autoAnalysisRunning ? "Analyzing climb…" : "Analyze climb automatically"}
              </button>
              {autoAnalysisRunning && (
                <button onClick={() => autoAnalysisAbortRef.current?.abort()}>Cancel</button>
              )}
              {!autoAnalysisRunning && suggestedStartRawTime !== null && (
                <button className="primary" onClick={acceptSuggestedStart} disabled={videoAnalysisRunning}>
                  Accept suggested start ({suggestedStartRawTime.toFixed(3)}s)
                </button>
              )}
              {!autoAnalysisRunning && metadata?.metadataLoaded && (
                <button onClick={() => {
                  acceptTimestamp("startSignal", currentTime, "Manual", "Medium", { note: "Set from the current video frame." });
                  setSuggestedStartRawTime(null);
                  setAutoAnalysisStatus(`Start manually set to ${currentTime.toFixed(3)}s.`);
                }}>
                  Use current frame as start
                </button>
              )}
            </div>
            {autoAnalysisStatus && <p className="status-message" aria-live="polite">{autoAnalysisStatus}</p>}
            {startEvidenceStatus && <p className="evidence-message">{startEvidenceStatus}</p>}
          </div>
        </Card>

        <Card title="Analysis Session">
          <details className="help-details">
            <summary>Session name and athlete details</summary>
          <div className="form-grid">
            <label>
              Session name
              <input type="text" value={sessionName} onChange={(event) => setSessionName(event.target.value)} />
            </label>
            <label>
              Climber
              <input type="text" value={climberName} onChange={(event) => setClimberName(event.target.value)} placeholder="Optional" />
            </label>
            <label>
              Date
              <input type="date" value={attemptDate} onChange={(event) => setAttemptDate(event.target.value)} />
            </label>
            <label>
              Location / gym
              <input type="text" value={attemptLocation} onChange={(event) => setAttemptLocation(event.target.value)} placeholder="Optional" />
            </label>
            <label>
              Attempt type
              <input type="text" value={attemptType} onChange={(event) => setAttemptType(event.target.value)} placeholder="Training" />
            </label>
          </div>
          <label className="single-field">
            Notes
            <textarea
              value={sessionNotes}
              onChange={(event) => setSessionNotes(event.target.value)}
              placeholder="What are you trying to verify in this run?"
            />
          </label>
          </details>
          <div className="button-row">
            <button className="primary" onClick={saveCurrentSession} disabled={videoAnalysisRunning}>Save Session</button>
            <button onClick={renameActiveSession} disabled={videoAnalysisRunning}>Rename Session</button>
            <button onClick={duplicateActiveSession} disabled={videoAnalysisRunning}>Duplicate Session</button>
          </div>
          <div className="session-load-row">
            <select value={activeSessionId ?? ""} onChange={(event) => loadSelectedSession(event.target.value)} disabled={videoAnalysisRunning}>
              <option value="">Load saved session</option>
              {savedSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} {session.videoFileName ? `- ${session.videoFileName}` : ""}
                </option>
              ))}
            </select>
            <button onClick={deleteActiveSession} disabled={videoAnalysisRunning}>Delete Session</button>
          </div>
          <SavedSessionsList sessions={savedSessions} activeSessionId={activeSessionId} onLoad={loadSelectedSession} disabled={videoAnalysisRunning} />
          <p className="muted">
            Sessions save zones, timing, compact biomechanics results, settings, and notes in this browser. Videos stay local and are not uploaded.
          </p>
          {sessionStatus && <p className="status-message">{sessionStatus}</p>}
        </Card>

        <Card title="2. Video Player" className="wide">
          <div className="video-viewport">
            <video
              ref={videoRef}
              src={videoUrl ?? undefined}
              className="video-player"
              controls={!videoAnalysisRunning}
              onLoadedMetadata={handleMetadataLoaded}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
            />
            <PoseVideoOverlay
              result={biomechanics.result}
              currentTime={currentTime}
              videoWidth={metadata?.videoWidth ?? 0}
              videoHeight={metadata?.videoHeight ?? 0}
            />
          </div>
          <div className="player-controls">
            <button disabled={videoAnalysisRunning} onClick={() => (videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause())}>
              Play / pause
            </button>
            <span className="time-pill">Raw video time {currentTime.toFixed(3)}s</span>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(-0.03)}>-0.03s</button>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(0.03)}>+0.03s</button>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(-0.1)}>-0.10s</button>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(0.1)}>+0.10s</button>
            <input
              className="small-input"
              value={jumpInput}
              onChange={(event) => setJumpInput(event.target.value)}
              placeholder="Raw time"
              disabled={videoAnalysisRunning}
            />
            <button disabled={videoAnalysisRunning} onClick={() => jumpTo(Number(jumpInput))}>Jump</button>
          </div>
          {videoRestoreStatus && <p className="status-message">{videoRestoreStatus}</p>}
        </Card>

        <Card title="3. Optional Zones" className="wide">
          <div className="toolbar">
            <button className="primary" onClick={captureCurrentFrameForZones} disabled={videoAnalysisRunning}>
              Capture Current Frame for Zone Setup
            </button>
            <select value={selectedZoneId} onChange={(event) => setSelectedZoneId(event.target.value as ZoneId)} disabled={videoAnalysisRunning}>
              {ZONES.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </select>
            <button disabled={videoAnalysisRunning} onClick={() => setZones((current) => omitZone(current, selectedZoneId))}>Delete selected zone</button>
            <button disabled={videoAnalysisRunning} onClick={() => setZones({})}>Clear all zones</button>
          </div>
          <p className="muted zone-helper">
            You normally do not need a Start Light Zone anymore. Add a Start Body Zone only when another person appears in the video, or draw a light zone manually if automatic green-to-blue search fails.
          </p>

          {capturedFrame ? (
            <div
              ref={zoneFrameWrapRef}
              className={`zone-frame-wrap ${zoneDisplayMode}`}
            >
              <div
                ref={zoneStageRef}
                className="zone-image-stage"
                style={zoneStageStyle}
              >
                <img className="zone-frame" src={capturedFrame} alt="Captured frame for zone setup" />
                <div
                  className={`zone-overlay${videoAnalysisRunning ? " locked" : ""}`}
                  aria-disabled={videoAnalysisRunning}
                  onPointerDown={beginZoneDrag}
                  onPointerMove={updateZoneDrag}
                  onPointerUp={finishZoneDrag}
                  onPointerCancel={finishZoneDrag}
                >
                  {Object.values(zones).map((zone) => (
                    <ZoneRect key={zone.id} zone={zone} active={zone.id === selectedZoneId} />
                  ))}
                  {draftZone && <ZoneRect zone={draftZone} active preview />}
                </div>
              </div>
            </div>
          ) : (
            <p className="muted">Capture a frame to draw normalized detection zones.</p>
          )}
          <ZoneWarnings zones={zones} />
        </Card>

        <Card title="4. Start Timing">
          <p className="muted">
            Quick Analyze searches multiple scales and both lanes for faint green→blue lights in the lower frame (the start box always sits below the first two holds), detects the countdown or a single loud start beep locally, and compares them with motion. Conflicting cues are left for review instead of silently accepted.
          </p>
          <details className="help-details">
            <summary>Manual timing settings</summary>
          <div className="form-grid">
            <label>
              Search start
              <input type="number" value={startSearchStart} step="0.1" onChange={(event) => setStartSearchStart(Number(event.target.value))} />
            </label>
            <label>
              Search end
              <input type="number" value={startSearchEnd} step="0.1" onChange={(event) => setStartSearchEnd(Number(event.target.value))} />
            </label>
            <label>
              Sensitivity
              <select value={startSensitivity} onChange={(event) => setStartSensitivity(event.target.value as Sensitivity)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              Detection profile
              <select
                value={startDetectionProfile}
                onChange={(event) => {
                  const value = event.target.value as StartDetectionProfile;
                  setStartDetectionProfile(value);
                  if (value === "blocked") {
                    setStartLightVisibility("blocked");
                    setStartSignalOffset(-0.1);
                  }
                }}
              >
                <option value="auto">Auto / Generic</option>
                <option value="calibrated">Calibrated Start Light</option>
                <option value="generic">Generic Start Light</option>
                <option value="motion">Motion-Based Start Estimate</option>
                <option value="blocked">Blocked Light</option>
                <option value="manual">Manual / Review Mode</option>
              </select>
            </label>
            <label>
              Start Light Visibility
              <select
                value={startLightVisibility}
                onChange={(event) => {
                  const value = event.target.value as "clear" | "blocked";
                  setStartLightVisibility(value);
                  setStartSignalOffset(value === "blocked" ? -0.1 : 0);
                }}
              >
                <option value="clear">Clear</option>
                <option value="blocked">Partially blocked by climber</option>
              </select>
            </label>
            <label>
              Start Signal offset
              <input
                type="number"
                step="0.001"
                value={startSignalOffset}
                onChange={(event) => setStartSignalOffset(Number(event.target.value))}
              />
            </label>
            <label>
              Estimated reaction time offset
              <input
                type="number"
                step="0.01"
                value={reactionTimeOffset}
                onChange={(event) => setReactionTimeOffset(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="button-row compact-row">
            {[0.1, 0.15, 0.2, 0.25, 0.3].map((value) => (
              <button key={value} onClick={() => setReactionTimeOffset(value)}>
                reaction {value.toFixed(2)}s
              </button>
            ))}
          </div>
          {startLightVisibility === "blocked" && (
            <p className="guidance">
              Because the light may be blocked, the visible color change can occur slightly after the true start.
            </p>
          )}
          {isCalibrationWeak && (
            <p className="guidance">
              The light change is weak in this video. Start light detection may not be reliable. Try a tighter light zone, a clearer before/after frame, or use motion-based start fallback.
            </p>
          )}
          <p className="muted">Detection method: {startDetectionMethodLabel}</p>
          <div className="button-row">
            <button disabled={videoAnalysisRunning || !zones.startLight} onClick={() => setCalibrationSample("before")}>Use current frame as green</button>
            <button disabled={videoAnalysisRunning || !zones.startLight} onClick={() => setCalibrationSample("after")}>Use current frame as blue</button>
            <button
              disabled={videoAnalysisRunning}
              onClick={() => {
                setStartLightCalibration({});
                setCalibrationStatus("Manual light calibration cleared.");
              }}
            >
              Clear light calibration
            </button>
          </div>
          {calibrationStatus && <p className="status-message">{calibrationStatus}</p>}
          <CalibrationPanel calibration={startLightCalibration} lightZone={zones.startLight} />
          </details>
          <button className="primary" disabled={videoAnalysisRunning} onClick={runStartSignalDetection}>
            {startRunning ? "Finding start…" : "Find start automatically"}
          </button>
          {(isCalibrationWeak || (startResult && !startResult.detected)) && (
            <button className="primary secondary-action" disabled={videoAnalysisRunning} onClick={runMotionBasedStartEstimate}>
              Try Motion-Based Start Estimate
            </button>
          )}
          <DetectionCard
            title="Suggested Start Signal"
            result={startResult}
            climbTime={0}
            detectedClimbTime={0}
            offset={startSignalOffset}
            finalRawTime={startFinalRaw}
            finalClimbTime={0}
            acceptLabel="Accept Start Signal"
            offsetButtons={[-0.05, -0.1, -0.15]}
            onOffsetChange={setStartSignalOffset}
            onAcceptCandidate={(candidate) =>
              acceptTimestamp("startSignal", Math.max(0, roundTime(candidate.rawTime + startSignalOffset)), startSourceForCandidate(candidate), candidate.confidence, {
                detectedRawTime: candidate.rawTime,
                offsetApplied: startSignalOffset,
                note: candidate.method === "Motion-based start estimate" ? `${candidate.reason} Estimated from body motion, not light-detected. Review recommended.` : candidate.reason,
              })
            }
            onJumpCandidate={(candidate, delta = 0) => jumpTo(Math.max(0, roundTime(candidate.rawTime + startSignalOffset + delta)))}
            getCandidateJumpTarget={(candidate) => Math.max(0, roundTime(candidate.rawTime + startSignalOffset))}
            onAccept={() =>
              startResult?.rawTime !== undefined &&
              acceptTimestamp("startSignal", Math.max(0, roundTime(startResult.rawTime + startSignalOffset)), startSourceForResult(startResult), startResult.confidence, {
                detectedRawTime: startResult.rawTime,
                offsetApplied: startSignalOffset,
                note: startResult.debug.detectionMethod === "Motion-based start estimate" ? `${startResult.reason} Estimated from body motion, not light-detected. Review recommended.` : startResult.reason,
              })
            }
            onJump={(delta = 0) => jumpTo(startFinalRaw !== undefined ? Math.max(0, roundTime(startFinalRaw + delta)) : undefined)}
            onReject={() => {
              setStartResult(null);
              setSuggestedStartRawTime(null);
            }}
            emptyText="Start Signal not detected."
            defaultCandidateSource="Start light detection"
          />
        </Card>

        <Card title="5. First Movement">
          <p className="muted">Quick Analyze runs this automatically after the color-defined start. Open settings only when manual tuning is needed.</p>
          <details className="help-details">
            <summary>Manual movement settings</summary>
          <label className="single-field">
            Sensitivity
            <select value={movementSensitivity} onChange={(event) => setMovementSensitivity(event.target.value as Sensitivity)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="single-field">
            First movement definition
            <select
              value={firstMovementDefinition}
              onChange={(event) => setFirstMovementDefinition(event.target.value as FirstMovementDefinition)}
            >
              <option value="earliest">Earliest visible motion</option>
              <option value="committed">Committed launch</option>
            </select>
          </label>
          <p className="muted">
            {firstMovementDefinition === "earliest"
              ? "Earliest visible motion: first visible movement after the start signal. May include preload or weight shift."
              : "Committed launch: stronger launch movement after preload. Ignores very early small shifts by default."}
          </p>
          <label className="single-field">
            Committed launch minimum delay
            <select
              value={committedLaunchMinDelay}
              onChange={(event) => setCommittedLaunchMinDelay(Number(event.target.value))}
            >
              <option value={0}>0.00s</option>
              <option value={0.05}>0.05s</option>
              <option value={0.1}>0.10s</option>
              <option value={0.15}>0.15s</option>
              <option value={0.2}>0.20s</option>
            </select>
          </label>
          <label className="single-field">
            First Movement offset
            <input
              type="number"
              step="0.001"
              value={firstMovementOffset}
              onChange={(event) => setFirstMovementOffset(Number(event.target.value))}
            />
          </label>
          </details>
          {startSignalRaw === null && <p className="muted">Accept a Start Signal suggestion or set Start Signal manually first.</p>}
          <button className="primary" disabled={videoAnalysisRunning || startSignalRaw === null} onClick={runFirstMovementDetection}>
            {movementRunning ? "Detecting…" : "Detect first movement"}
          </button>
          <DetectionCard
            title="Suggested First Movement"
            result={movementResult}
            climbTime={movementFinalClimb}
            detectedClimbTime={movementResult?.climbTime}
            offset={firstMovementOffset}
            finalRawTime={movementFinalRaw}
            finalClimbTime={movementFinalClimb}
            acceptLabel="Accept First Movement"
            offsetButtons={[-0.03, -0.05, -0.1]}
            onOffsetChange={setFirstMovementOffset}
            onAcceptCandidate={(candidate) =>
              acceptTimestamp("firstMovement", Math.max(0, roundTime(candidate.rawTime + firstMovementOffset)), "Body motion detection", candidate.confidence, {
                detectedRawTime: candidate.rawTime,
                offsetApplied: firstMovementOffset,
                note: candidate.reason,
              })
            }
            onAcceptCandidateAs={(candidate, definition) =>
              acceptTimestamp(definition === "committed" ? "committedLaunch" : "firstMovement", Math.max(0, roundTime(candidate.rawTime + firstMovementOffset)), "Body motion detection", candidate.confidence, {
                detectedRawTime: candidate.rawTime,
                offsetApplied: firstMovementOffset,
                note: `${movementDefinitionLabel(definition)} accepted from ${candidate.kind}. ${candidate.reason}`,
              })
            }
            onJumpCandidate={(candidate, delta = 0) => jumpTo(Math.max(0, roundTime(candidate.rawTime + firstMovementOffset + delta)))}
            getCandidateJumpTarget={(candidate) => Math.max(0, roundTime(candidate.rawTime + firstMovementOffset))}
            candidatePreviewFrames={movementPreviewFrames}
            defaultCandidateSource="Body motion detection"
            showMovementCandidateActions
            onAccept={() =>
              movementResult?.rawTime !== undefined &&
              acceptTimestamp(firstMovementDefinition === "committed" ? "committedLaunch" : "firstMovement", Math.max(0, roundTime(movementResult.rawTime + firstMovementOffset)), "Body motion detection", movementResult.confidence, {
                detectedRawTime: movementResult.rawTime,
                offsetApplied: firstMovementOffset,
                note: movementResult.reason,
              })
            }
            onJump={(delta = 0) => jumpTo(movementFinalRaw !== undefined ? Math.max(0, roundTime(movementFinalRaw + delta)) : undefined)}
            onReject={() => setMovementResult(null)}
            emptyText="First Movement not detected."
          />
        </Card>

        <Card title="6. Official Finish Time">
          <label className="single-field">
            Official total time
            <input
              type="number"
              step="0.001"
              value={officialTotalTime}
              placeholder="13.125"
              onChange={(event) => setOfficialTotalTime(event.target.value)}
            />
          </label>
          {startSignalRaw === null ? (
            <p className="muted">Set Start Signal first, then official time can calculate Finish Pad.</p>
          ) : finishSuggestion ? (
            <div className="suggestion-card">
              <h3>Suggested Finish Pad</h3>
              <p>Climb time: {finishSuggestion.climbTime.toFixed(3)}s after Start Signal</p>
              <p>Raw video time: {finishSuggestion.rawTime.toFixed(3)}s</p>
              <p>Source: Calculated from official total time, not video-detected</p>
              <p>Confidence: High</p>
              <p className="muted">Jump target: {finishSuggestion.rawTime.toFixed(3)}s raw</p>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => acceptTimestamp("finishPad", finishSuggestion.rawTime, "Official total time", "High")}
                >
                  Accept Finish Pad
                </button>
                <button onClick={() => jumpTo(Math.max(0, roundTime(finishSuggestion.rawTime - 0.1)))}>Jump -0.10s</button>
                <button onClick={() => jumpTo(finishSuggestion.rawTime)}>Jump exact</button>
                <button onClick={() => jumpTo(roundTime(finishSuggestion.rawTime + 0.1))}>Jump +0.10s</button>
              </div>
            </div>
          ) : (
            <p className="muted">Enter an official total time to calculate Finish Pad.</p>
          )}
        </Card>

        <Card title="7. Results" className="full">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Marker</th>
                  <th>Raw video time</th>
                  <th>Climb time after Start Signal</th>
                  <th>Source</th>
                  <th>Confidence</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {timestamps.map((item) => (
                  <tr key={item.id}>
                    <td>{item.label}</td>
                    <td>{formatTime(item.rawTime)}</td>
                    <td>{formatTime(item.climbTime)}</td>
                    <td>{item.source}</td>
                    <td>{item.confidence}</td>
                    <td>
                      <div className="table-actions">
                        <button onClick={() => jumpTo(item.rawTime)}>Jump</button>
                        <button onClick={() => clearTimestamp(item.id)}>Clear</button>
                        <button onClick={() => acceptTimestamp(item.id, currentTime, "Manual", "Medium")}>Set current</button>
                        <input placeholder="Raw" onBlur={(event) => setTimestampFromInput(item.id, event.target.value, "raw")} />
                        <input
                          placeholder="Climb"
                          disabled={startSignalRaw === null}
                          onBlur={(event) => setTimestampFromInput(item.id, event.target.value, "climb")}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="8. Splits">
          <div className="split-grid">
            {splitRows.map((row) => (
              <Metric key={row.label} label={row.label} value={row.value === null ? "Not set" : `${row.value.toFixed(3)}s`} />
            ))}
          </div>
        </Card>

        <Card title="9. Center of Mass" className="full">
          <BiomechanicsPanel
            key={`${videoUrl ?? "no-video"}:${activeSessionId ?? "unsaved-session"}`}
            videoRef={videoRef}
            metadata={metadata}
            currentTime={currentTime}
            startRawTime={startSignalRaw}
            finishRawTime={getTimestamp(timestamps, "finishPad").rawTime}
            identityZone={zones.startBody}
            session={biomechanics}
            analysisBlocked={startRunning || movementRunning || movementPreviewRunning || frameTestRunning || autoAnalysisRunning}
            onSessionChange={setBiomechanics}
            onRunningChange={setBiomechanicsRunning}
            onJump={jumpTo}
            runVideoTask={runNamedVideoTask}
          />
        </Card>

        <Card title="Export & Dataset" className="wide">
          <p className="muted">
            Export a human-readable Obsidian note or machine-readable JSON dataset. Videos are not stored or uploaded.
          </p>
          <div className="button-row">
            <button className="primary" onClick={copyObsidianNote}>Copy Obsidian Note</button>
            <button onClick={downloadMarkdown}>Download Markdown</button>
            <button onClick={copyDatasetJson}>Copy JSON</button>
            <button onClick={downloadDatasetJson}>Download JSON</button>
            <label className="file-button">
              Import Session JSON
              <input type="file" accept="application/json,.json" onChange={importSession} disabled={videoAnalysisRunning} />
            </label>
          </div>
          <div className="button-row compact-row">
            <button onClick={chooseObsidianFolder}>Choose Obsidian Folder</button>
            <button onClick={saveExportsToObsidianFolder}>Save Markdown + JSON to Folder</button>
            {obsidianFolderName && <span className="time-pill">Folder: {obsidianFolderName}</span>}
          </div>
          <p className="muted">
            Direct folder saving works only in supported desktop browsers. Downloads and copy buttons work everywhere.
          </p>
          {exportStatus && <p className="status-message">{exportStatus}</p>}
          <details className="help-details">
            <summary>Using ClimbIQ with Obsidian</summary>
            <p>
              ClimbIQ uses an on-device pretrained pose model but does not train a custom model. Exports create a labeled history for comparing attempts and improving future timing and coaching workflows.
            </p>
            <div className="mini-table">
              <div><span>Vault</span><span>ClimbIQ Training Log/</span></div>
              <div><span>Folder</span><span>Attempts/</span></div>
              <div><span>Folder</span><span>Exports/</span></div>
              <div><span>Folder</span><span>Debug Reports/</span></div>
              <div><span>Folder</span><span>Templates/</span></div>
            </div>
            <ol className="help-list">
              <li>Create an Obsidian vault called ClimbIQ Training Log.</li>
              <li>Create folders: Attempts, Exports, Debug Reports, Templates.</li>
              <li>After analyzing a climb, click Download Markdown or Copy Obsidian Note.</li>
              <li>Save the Markdown note into Attempts.</li>
              <li>Save the JSON export into Exports.</li>
              <li>Keep videos local. ClimbIQ only stores the video file name, not the actual video.</li>
            </ol>
          </details>
        </Card>

      </section>
    </main>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SavedSessionsList({
  sessions,
  activeSessionId,
  onLoad,
  disabled = false,
}: {
  sessions: SavedAnalysisSession[];
  activeSessionId: string | null;
  onLoad: (sessionId: string) => void;
  disabled?: boolean;
}) {
  if (!sessions.length) {
    return <p className="muted">No saved sessions yet.</p>;
  }

  return (
    <div className="saved-session-list">
      {sessions.slice(0, 5).map((session) => (
        <button
          key={session.id}
          className={session.id === activeSessionId ? "active" : ""}
          onClick={() => onLoad(session.id)}
          disabled={disabled}
        >
          <strong>{session.name}</strong>
          <span>{session.date || "No date"}{session.videoFileName ? ` / ${session.videoFileName}` : ""}</span>
        </button>
      ))}
    </div>
  );
}

function SampleTable({ samples }: { samples: FrameSamplingDebug["samples"] }) {
  if (!samples.length) {
    return null;
  }

  return (
    <div className="mini-table">
      {samples.map((sample) => (
        <div key={sample.requestedTime}>
          <span>{sample.requestedTime.toFixed(3)}s</span>
          <span>{sample.success ? `RGB ${sample.averageRgb.r}, ${sample.averageRgb.g}, ${sample.averageRgb.b}` : sample.error}</span>
        </div>
      ))}
    </div>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) {
    return null;
  }
  return (
    <ul className="errors">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

function ZoneRect({ zone, active, preview = false }: { zone: NormalizedZone; active?: boolean; preview?: boolean }) {
  const left = Math.min(zone.x1, zone.x2) * 100;
  const top = Math.min(zone.y1, zone.y2) * 100;
  const width = Math.abs(zone.x2 - zone.x1) * 100;
  const height = Math.abs(zone.y2 - zone.y1) * 100;
  const tone = ZONES.find((item) => item.id === zone.id)?.tone ?? "#ffffff";

  return (
    <div
      className={`zone-rect ${active ? "active" : ""} ${preview ? "preview" : ""}`}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        borderColor: tone,
      }}
    >
      <span style={{ background: tone }}>{zone.label}</span>
    </div>
  );
}

function ZoneWarnings({ zones }: { zones: Partial<Record<ZoneId, NormalizedZone>> }) {
  const warnings: string[] = [];
  const startLightArea = zones.startLight ? zoneArea(zones.startLight) : 0;
  const startBodyArea = zones.startBody ? zoneArea(zones.startBody) : 0;

  if (startLightArea > 0.1) {
    warnings.push(`Draw the Start Light Zone tightly around only the light. Large zones dilute the color change and make detection unstable across videos. Current area: ${(startLightArea * 100).toFixed(2)}%; recommended under 2-5%.`);
  } else if (startLightArea > 0.05) {
    warnings.push(`Start Light Zone area: ${(startLightArea * 100).toFixed(2)}%. Recommended: under 2-5% of the frame for a light zone.`);
  } else if (startLightArea > 0) {
    warnings.push(`Start Light Zone area: ${(startLightArea * 100).toFixed(2)}%.`);
  }
  if (startBodyArea > 0.3) {
    warnings.push(`Large body zones can include background movement and make first movement detection inaccurate. Current area: ${(startBodyArea * 100).toFixed(2)}%.`);
  } else if (startBodyArea > 0 && startBodyArea < 0.02) {
    warnings.push(`Small body zones may miss early arm or torso movement. Current area: ${(startBodyArea * 100).toFixed(2)}%.`);
  } else if (startBodyArea > 0) {
    warnings.push(`Start Body Zone area: ${(startBodyArea * 100).toFixed(2)}%.`);
  }

  if (!warnings.length) {
    return null;
  }

  return (
    <div className="warnings">
      {warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  );
}

function ZoneCoordinateList({ zones }: { zones: Partial<Record<ZoneId, NormalizedZone>> }) {
  const values = Object.values(zones);
  if (!values.length) {
    return null;
  }

  return (
    <div className="zone-list">
      {values.map((zone) => (
        <div key={zone.id}>
          <strong>{zone.label}</strong>
          <span>
            x1 {zone.x1.toFixed(3)}, y1 {zone.y1.toFixed(3)}, x2 {zone.x2.toFixed(3)}, y2 {zone.y2.toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CalibrationPanel({ calibration, lightZone }: { calibration: StartLightCalibration; lightZone?: NormalizedZone }) {
  const delta = calibration.colorDelta;
  const areaPercent = lightZone ? zoneArea(lightZone) * 100 : null;
  const zoneMayBeLarge = areaPercent !== null && areaPercent > 5;
  return (
    <div className="calibration-panel">
      <ColorMetric label="Before RGB" rgb={calibration.beforeStartRGB} time={calibration.calibrationFrameBeforeTime} />
      <ColorMetric label="After RGB" rgb={calibration.afterStartRGB} time={calibration.calibrationFrameAfterTime} />
      <Metric label="Color difference" value={delta !== undefined ? delta.toFixed(3) : "Not set"} />
      <Metric
        label="Calibration strength"
        value={
          delta === undefined
            ? "Waiting"
            : delta >= 35
              ? "Strong"
              : delta >= 18
                ? "Moderate"
                : "Weak"
        }
      />
      <Metric label="Recommended minimum" value="18.000" />
      <Metric label="Light zone area" value={areaPercent !== null ? `${areaPercent.toFixed(2)}%` : "Not set"} />
      {delta !== undefined && delta < 18 && (
        <p className="guidance full-span">
          The light change is weak in this video. Start light detection may not be reliable. Try a tighter light zone, a clearer before/after frame, or use motion-based start fallback.
        </p>
      )}
      {zoneMayBeLarge && (
        <p className="guidance full-span">
          The Start Light Zone may be too large. Large zones dilute faint color changes and make detection unstable.
        </p>
      )}
    </div>
  );
}

function ColorMetric({ label, rgb, time }: { label: string; rgb?: RGB; time?: number }) {
  return (
    <div className="metric color-metric">
      <span>{label}</span>
      <div className="swatch-row">
        <ColorSwatch rgb={rgb} />
        <strong>{rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "Not set"}</strong>
      </div>
      <small>{time !== undefined ? `${time.toFixed(3)}s raw` : ""}</small>
    </div>
  );
}

function ColorSwatch({ rgb }: { rgb?: RGB }) {
  return (
    <span
      className="color-swatch"
      style={{ background: rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "transparent" }}
    />
  );
}

function PointerDebugPanel({
  pointerDebug,
  zoneDisplayMode,
}: {
  pointerDebug: PointerDebugInfo | null;
  zoneDisplayMode: ZoneDisplayMode;
}) {
  const hasNormalizedPoint =
    pointerDebug !== null && pointerDebug.normalizedX !== null && pointerDebug.normalizedY !== null;
  const normalizedPointValue = hasNormalizedPoint
    ? `${Number(pointerDebug.normalizedX).toFixed(3)}, ${Number(pointerDebug.normalizedY).toFixed(3)}`
    : "Outside image";

  return (
    <div className="pointer-debug">
      <Metric label="Raw pointer x/y" value={pointerDebug ? `${pointerDebug.rawX.toFixed(0)}, ${pointerDebug.rawY.toFixed(0)}` : "n/a"} />
      <Metric
        label="Normalized image x/y"
        value={normalizedPointValue}
      />
      <Metric label="Inside image bounds" value={pointerDebug?.insideImage ? "Yes" : "No"} />
      <Metric
        label={zoneDisplayMode === "scroll" ? "Scroll top / left" : "Scroll top"}
        value={pointerDebug ? `${pointerDebug.scrollTop.toFixed(0)} / ${pointerDebug.scrollLeft.toFixed(0)}` : "0 / 0"}
      />
    </div>
  );
}

function DetectionCard({
  title,
  result,
  climbTime,
  detectedClimbTime,
  offset = 0,
  finalRawTime,
  finalClimbTime,
  offsetButtons = [],
  onOffsetChange,
  acceptLabel = "Accept",
  onAcceptCandidate,
  onAcceptCandidateAs,
  onJumpCandidate,
  getCandidateJumpTarget,
  candidatePreviewFrames,
  defaultCandidateSource,
  showMovementCandidateActions = false,
  onAccept,
  onJump,
  onReject,
  emptyText,
}: {
  title: string;
  result: StartSignalDetectionResult | FirstMovementDetectionResult | null;
  climbTime?: number;
  detectedClimbTime?: number;
  offset?: number;
  finalRawTime?: number;
  finalClimbTime?: number;
  offsetButtons?: number[];
  onOffsetChange?: (offset: number) => void;
  acceptLabel?: string;
  onAcceptCandidate?: (candidate: DetectionCandidate) => void;
  onAcceptCandidateAs?: (candidate: DetectionCandidate, definition: FirstMovementDefinition) => void;
  onJumpCandidate?: (candidate: DetectionCandidate, delta?: number) => void;
  getCandidateJumpTarget?: (candidate: DetectionCandidate) => number;
  candidatePreviewFrames?: Record<string, CandidatePreviewFrames>;
  defaultCandidateSource?: string;
  showMovementCandidateActions?: boolean;
  onAccept: () => void;
  onJump: (delta?: number) => void;
  onReject: () => void;
  emptyText: string;
}) {
  if (!result) {
    return null;
  }

  const candidates = result.candidates ?? [];

  if (!result.detected || result.rawTime === undefined) {
    const debug = result.debug;
    const maxSignal = "maxColorDistance" in debug ? debug.maxColorDistance : debug.maxMotion;
    return (
      <div className="suggestion-card muted-card">
        <h3>{emptyText}</h3>
        <p>Max signal: {maxSignal.toFixed(3)}</p>
        <p>Threshold: {result.threshold.toFixed(3)}</p>
        <p>Frames sampled: {debug.framesSampled}</p>
        <p>Failure reason: {debug.failureReason ?? result.reason}</p>
        <DetectionDebugSummary result={result} />
        <CandidateList
          candidates={candidates}
          onAcceptCandidate={onAcceptCandidate}
          onAcceptCandidateAs={onAcceptCandidateAs}
          onJumpCandidate={onJumpCandidate}
          getCandidateJumpTarget={getCandidateJumpTarget}
          candidatePreviewFrames={candidatePreviewFrames}
          defaultCandidateSource={defaultCandidateSource}
          showMovementCandidateActions={showMovementCandidateActions}
        />
      </div>
    );
  }

  const jumpTarget = finalRawTime ?? result.rawTime;

  return (
    <div className="suggestion-card">
      <h3>{title}</h3>
      <div className="timing-calibration">
        <div>
          <span>Detected</span>
          <strong>{result.rawTime.toFixed(3)}s raw</strong>
          <small>{detectedClimbTime !== undefined ? `${detectedClimbTime.toFixed(3)}s climb` : ""}</small>
        </div>
        <div>
          <span>Correction</span>
          <strong>{offset.toFixed(3)}s</strong>
          <small>Applied offset</small>
        </div>
        <div>
          <span>Final</span>
          <strong>{(finalRawTime ?? result.rawTime).toFixed(3)}s raw</strong>
          <small>{finalClimbTime !== undefined ? `${finalClimbTime.toFixed(3)}s climb` : `${(climbTime ?? 0).toFixed(3)}s climb`}</small>
        </div>
      </div>
      {onOffsetChange && (
        <div className="button-row compact-row">
          {offsetButtons.map((buttonOffset) => (
            <button key={buttonOffset} onClick={() => onOffsetChange(buttonOffset)}>
              {buttonOffset.toFixed(2)}s
            </button>
          ))}
          <button onClick={() => onOffsetChange(0)}>reset</button>
        </div>
      )}
      <p>Confidence: {result.confidence}</p>
      {"detectionMethod" in result.debug && result.debug.detectionMethod && <p>Source: {result.debug.detectionMethod}</p>}
      <p>Reason: {result.reason}</p>
      {"detectionMethod" in result.debug && result.debug.detectionMethod === "Motion-based start estimate" && (
        <p className="guidance">Estimated from body motion, not light-detected. This is not an exact official start. Review recommended.</p>
      )}
      {result.confidence === "Low" && <p className="guidance">Low confidence. Use Jump to Suggestion to verify before accepting.</p>}
      {candidates.some((candidate) => candidate.rawTime === result.rawTime && candidate.boundaryRisk) && (
        <p className="guidance">This may be inaccurate because it occurs at the edge of the search window.</p>
      )}
      {candidates.some((candidate) => candidate.rawTime === result.rawTime && candidate.suspiciousFirstFrame) && (
        <p className="guidance">Detection occurred very close to the first sampled frame. Verify this is real movement and not sampling noise.</p>
      )}
      <DetectionDebugSummary result={result} />
      <p className="muted">Jump target: {jumpTarget.toFixed(3)}s raw</p>
      <div className="button-row">
        <button className="primary" onClick={onAccept}>
          {acceptLabel}
        </button>
        <button onClick={() => onJump(0)}>Jump to Suggestion</button>
        <button onClick={() => onJump(-0.1)}>Jump -0.10s</button>
        <button onClick={() => onJump(0)}>Jump exact</button>
        <button onClick={() => onJump(0.1)}>Jump +0.10s</button>
        <button onClick={onReject}>Reject</button>
      </div>
      <CandidateList
        candidates={candidates}
        onAcceptCandidate={onAcceptCandidate}
        onAcceptCandidateAs={onAcceptCandidateAs}
        onJumpCandidate={onJumpCandidate}
        getCandidateJumpTarget={getCandidateJumpTarget}
        candidatePreviewFrames={candidatePreviewFrames}
        defaultCandidateSource={defaultCandidateSource}
        showMovementCandidateActions={showMovementCandidateActions}
      />
    </div>
  );
}

function CandidateList({
  candidates,
  onAcceptCandidate,
  onAcceptCandidateAs,
  onJumpCandidate,
  getCandidateJumpTarget,
  candidatePreviewFrames,
  defaultCandidateSource = "Detection",
  showMovementCandidateActions = false,
}: {
  candidates: DetectionCandidate[];
  onAcceptCandidate?: (candidate: DetectionCandidate) => void;
  onAcceptCandidateAs?: (candidate: DetectionCandidate, definition: FirstMovementDefinition) => void;
  onJumpCandidate?: (candidate: DetectionCandidate, delta?: number) => void;
  getCandidateJumpTarget?: (candidate: DetectionCandidate) => number;
  candidatePreviewFrames?: Record<string, CandidatePreviewFrames>;
  defaultCandidateSource?: string;
  showMovementCandidateActions?: boolean;
}) {
  if (!candidates.length) {
    return null;
  }

  return (
    <div className="candidate-list">
      <h4>Review candidates</h4>
      {candidates.map((candidate) => {
        const jumpTarget = getCandidateJumpTarget?.(candidate) ?? candidate.rawTime;
        const previews = candidatePreviewFrames?.[movementCandidateKey(candidate)];

        return (
        <div key={`${candidate.rawTime}-${candidate.kind}`} className="candidate-row">
          <div>
            <strong>{candidate.rawTime.toFixed(3)}s</strong>
            {candidate.climbTime !== undefined && <span>Climb {candidate.climbTime.toFixed(3)}s</span>}
            <span>{candidate.kind} / score {candidate.score.toFixed(3)} / {candidate.confidence}</span>
            <span>Source: {candidate.method ?? defaultCandidateSource}</span>
            {(candidate.distanceToBefore !== undefined || candidate.distanceToAfter !== undefined) && (
              <span>
                Before {candidate.distanceToBefore?.toFixed(3) ?? "n/a"} / After {candidate.distanceToAfter?.toFixed(3) ?? "n/a"}
              </span>
            )}
            {candidate.detectedMovementRawTime !== undefined && (
              <span>
                First movement {candidate.detectedMovementRawTime.toFixed(3)}s / reaction offset {candidate.reactionOffset?.toFixed(2) ?? "n/a"}s
              </span>
            )}
            {candidate.persistenceFrames !== undefined && <span>Persistence: {candidate.persistenceFrames} sample{candidate.persistenceFrames === 1 ? "" : "s"}</span>}
            {candidate.suspiciousFirstFrame && (
              <span>Detection occurred very close to the first sampled frame. Verify this is real movement and not sampling noise.</span>
            )}
            {candidate.preloadFlag && <span>Possible preload / weight shift before committed launch.</span>}
            {candidate.method === "Motion-based start estimate" && (
              <span>Estimated from body motion, not light-detected. Review recommended.</span>
            )}
            {candidate.rgb && (
              <span className="inline-swatch"><ColorSwatch rgb={candidate.rgb} /> Candidate RGB {candidate.rgb.r}, {candidate.rgb.g}, {candidate.rgb.b}</span>
            )}
            <p>{candidate.reason}{candidate.boundaryRisk ? " Edge-of-window candidate." : ""}</p>
            <span className="muted">Jump target: {jumpTarget.toFixed(3)}s raw</span>
            {previews && <CandidatePreviewStrip previews={previews} />}
          </div>
          <div className="candidate-actions">
            <button onClick={() => onJumpCandidate?.(candidate, -0.1)}>Jump -0.10s</button>
            <button onClick={() => onJumpCandidate?.(candidate, 0)}>Jump exact</button>
            <button onClick={() => onJumpCandidate?.(candidate, 0.1)}>Jump +0.10s</button>
            {showMovementCandidateActions ? (
              <>
                <button className="primary" onClick={() => onAcceptCandidateAs?.(candidate, "earliest")}>Accept as Earliest Motion</button>
                <button className="primary" onClick={() => onAcceptCandidateAs?.(candidate, "committed")}>Accept as Committed Launch</button>
              </>
            ) : (
              <button className="primary" onClick={() => onAcceptCandidate?.(candidate)}>Accept</button>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

function CandidatePreviewStrip({ previews }: { previews: CandidatePreviewFrames }) {
  if (previews.error) {
    return <span className="muted">Preview frames unavailable: {previews.error}</span>;
  }

  return (
    <div className="candidate-previews" aria-label="Candidate preview frames">
      <PreviewFrame label="-0.10s" src={previews.before} />
      <PreviewFrame label="Exact" src={previews.exact} />
      <PreviewFrame label="+0.10s" src={previews.after} />
    </div>
  );
}

function PreviewFrame({ label, src }: { label: string; src?: string }) {
  return (
    <figure>
      {src ? <img src={src} alt={`${label} candidate preview`} /> : <div className="preview-placeholder" />}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function DetectionDebugSummary({
  result,
}: {
  result: StartSignalDetectionResult | FirstMovementDetectionResult;
}) {
  const debug = result.debug;

  if ("maxColorDistance" in debug) {
    const baseline = debug.baselineRgb
      ? `${debug.baselineRgb.r}, ${debug.baselineRgb.g}, ${debug.baselineRgb.b}`
      : "n/a";
    return (
      <div className="detection-summary">
        <span>Baseline RGB: {baseline}</span>
        <span>Method: {debug.detectionMethod ?? "Generic color-distance detection"}</span>
        <span>First crossing: {formatOptionalTime(debug.firstThresholdCrossingTime)}</span>
        <span>Strongest signal: {formatOptionalTime(debug.strongestSignalTime)}</span>
        <span>Selected: {formatOptionalTime(debug.selectedCandidateTime)}</span>
        {debug.selectedCandidateReason && <span>{debug.selectedCandidateReason}</span>}
      </div>
    );
  }

  return (
    <div className="detection-summary">
      <span>Start Signal used: {formatOptionalTime(debug.startSignalRawTime)}</span>
      <span>Window: {formatOptionalTime(debug.searchWindowStart)} to {formatOptionalTime(debug.searchWindowEnd)}</span>
      <span>Sample rate: {debug.sampleRateFps?.toFixed(0) ?? "n/a"} fps</span>
      <span>Frame interval: {debug.frameInterval?.toFixed(3) ?? "n/a"}s</span>
      <span>First sampled after start: {debug.firstSampledTimeAfterStart?.toFixed(3) ?? "n/a"}s</span>
      <span>Detected after start: {debug.detectedTimeAfterStart?.toFixed(3) ?? "n/a"}s</span>
      <span>Committed min delay: {debug.committedLaunchMinDelay?.toFixed(3) ?? "n/a"}s</span>
      <span>First sample / max: {debug.firstSampleToMaxRatio?.toFixed(3) ?? "n/a"}</span>
      <span>Zone area: {debug.zoneAreaPercentage?.toFixed(2) ?? "n/a"}%</span>
      <span>Baseline motion: {debug.baselineMotion?.toFixed(3) ?? "n/a"}</span>
      <span>Max motion: {debug.maxMotion.toFixed(3)}</span>
      <span>Earliest threshold: {debug.earliestMotionThreshold?.toFixed(3) ?? debug.threshold.toFixed(3)}</span>
      <span>Committed threshold: {debug.committedLaunchThreshold?.toFixed(3) ?? "n/a"}</span>
      <span>Fixed / dynamic / final: {debug.fixedThreshold?.toFixed(3) ?? "n/a"} / {debug.dynamicThreshold?.toFixed(3) ?? "n/a"} / {debug.threshold.toFixed(3)}</span>
      <span>First crossing: {formatOptionalTime(debug.firstThresholdCrossingTime)}</span>
      <span>Selected default: {debug.selectedCandidateKind ?? "n/a"}</span>
      {debug.suspiciousFirstFrameDetection && (
        <span>Warning: selected candidate is very close to the first sampled frame.</span>
      )}
      {debug.movementAlreadyUnderway && (
        <span className="full-span">Movement appears to already be underway at the start of the analysis window. Start Signal may be slightly late; try a -0.05s or -0.10s Start Signal offset.</span>
      )}
      {debug.preStartMotionDetected && (
        <span className="full-span">Motion was detected before or exactly at the detected Start Signal. Verify Start Signal timing and Start Body Zone.</span>
      )}
      {debug.topMotionPeaks && debug.topMotionPeaks.length > 0 && (
        <span className="full-span">
          Top motion peaks: {debug.topMotionPeaks.map((peak) => `${peak.climbTime.toFixed(3)}s (${peak.motionScore.toFixed(3)})`).join(", ")}
        </span>
      )}
      {debug.movementSegments && debug.movementSegments.length > 0 && (
        <span className="full-span">
          Motion segments: {debug.movementSegments.map((segment) => `${(segment.startTime - (debug.startSignalRawTime ?? segment.startTime)).toFixed(3)}s-${(segment.endTime - (debug.startSignalRawTime ?? segment.endTime)).toFixed(3)}s max ${segment.maxMotion.toFixed(3)}`).join(", ")}
        </span>
      )}
      {debug.samples.length > 0 && (
        <MotionSparkline
          samples={debug.samples}
          threshold={debug.threshold}
          candidates={result.candidates ?? []}
        />
      )}
    </div>
  );
}

function MotionSparkline({
  samples,
  threshold,
  candidates,
}: {
  samples: Array<{ time: number; smoothedMotionScore: number }>;
  threshold: number;
  candidates: DetectionCandidate[];
}) {
  const max = Math.max(threshold, ...samples.map((sample) => sample.smoothedMotionScore), 0.001);
  const firstTime = samples[0]?.time ?? 0;
  const lastTime = samples[samples.length - 1]?.time ?? firstTime + 1;
  const timeSpan = Math.max(0.001, lastTime - firstTime);
  const points = samples
    .map((sample, index) => {
      const x = samples.length <= 1 ? 0 : (index / (samples.length - 1)) * 100;
      const y = 28 - (sample.smoothedMotionScore / max) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className="motion-graph full-span" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Motion curve">
      <line x1="0" x2="100" y1={28 - (threshold / max) * 26} y2={28 - (threshold / max) * 26} />
      <polyline points={points} />
      {candidates
        .filter((candidate) =>
          candidate.kind.includes("Earliest Visible Motion") ||
          candidate.kind.includes("Committed Launch") ||
          candidate.kind.includes("Largest Early Motion Spike") ||
          candidate.kind.includes("Possible preload")
        )
        .slice(0, 5)
        .map((candidate) => {
          const x = clamp(((candidate.rawTime - firstTime) / timeSpan) * 100, 0, 100);
          return (
            <line
              key={`${candidate.rawTime}-${candidate.kind}`}
              className={`candidate-marker ${motionMarkerClass(candidate.kind)}`}
              x1={x}
              x2={x}
              y1="1"
              y2="29"
            />
          );
        })}
    </svg>
  );
}

function marker(id: TimestampMarker["id"], label: string): TimestampMarker {
  return {
    id,
    label,
    rawTime: null,
    climbTime: null,
    source: "Not set",
    confidence: "None",
  };
}

function getTimestamp(timestamps: TimestampMarker[], id: TimestampMarker["id"]) {
  return timestamps.find((item) => item.id === id) ?? marker(id, id);
}

function buildAudioStartResult(audio: AudioStartResult): StartSignalDetectionResult {
  const rawTime = audio.rawTime ?? 0;
  return {
    detected: audio.found,
    rawTime: audio.rawTime,
    confidence: audio.confidence,
    reason: audio.reason,
    threshold: 0,
    candidates: audio.found ? [{
      rawTime,
      confidence: audio.confidence,
      reason: audio.reason,
      score: audio.sequence?.length ?? 0,
      kind: "Final countdown beep",
      method: "Audio countdown detection",
      persistenceFrames: audio.sequence?.length,
    }] : [],
    debug: {
      zoneExists: false,
      detectionMethod: "Audio countdown detection",
      framesSampled: audio.segments.length,
      maxColorDistance: 0,
      threshold: 0,
      detectedCrossings: [],
      detectedRawTime: audio.rawTime,
      selectedCandidateTime: audio.rawTime,
      selectedCandidateReason: audio.reason,
      samples: [],
    },
  };
}

function startSourceForResult(result: StartSignalDetectionResult): TimestampSource {
  return result.debug.detectionMethod?.startsWith("Fused")
    ? "Fused start detection"
    : result.debug.detectionMethod === "Motion-based start estimate"
      ? "Motion-based estimate"
      : "Start light detection";
}

function startSourceForCandidate(candidate: DetectionCandidate): TimestampSource {
  return candidate.method?.startsWith("Start fusion")
    ? "Fused start detection"
    : candidate.method === "Motion-based start estimate"
      ? "Motion-based estimate"
      : "Start light detection";
}

function recalculateTimestampClimbs(timestamps: TimestampMarker[]): TimestampMarker[] {
  const startRaw = getTimestamp(timestamps, "startSignal").rawTime;
  return timestamps.map((item) => {
    if (item.rawTime === null) {
      return { ...item, climbTime: null };
    }
    if (item.id === "startSignal") {
      return { ...item, climbTime: 0 };
    }
    return {
      ...item,
      climbTime: startRaw === null ? null : roundTime(item.rawTime - startRaw),
    };
  });
}

function normalizeZone(zone: NormalizedZone): NormalizedZone {
  return {
    ...zone,
    x1: Math.min(zone.x1, zone.x2),
    y1: Math.min(zone.y1, zone.y2),
    x2: Math.max(zone.x1, zone.x2),
    y2: Math.max(zone.y1, zone.y2),
  };
}

function omitZone(zones: Partial<Record<ZoneId, NormalizedZone>>, zoneId: ZoneId) {
  const next = { ...zones };
  delete next[zoneId];
  return next;
}

function zoneLabel(zoneId: ZoneId) {
  return ZONES.find((zone) => zone.id === zoneId)?.label ?? zoneId;
}

function zoneArea(zone: NormalizedZone) {
  return Math.abs(zone.x2 - zone.x1) * Math.abs(zone.y2 - zone.y1);
}

function rgbDistance(rgbA: RGB, rgbB: RGB) {
  return roundTime(Math.sqrt((rgbA.r - rgbB.r) ** 2 + (rgbA.g - rgbB.g) ** 2 + (rgbA.b - rgbB.b) ** 2));
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function formatTime(value: number | null) {
  return value === null ? "Not set" : `${value.toFixed(3)}s`;
}

function formatOptionalTime(value: number | undefined) {
  return value === undefined ? "n/a" : `${value.toFixed(3)}s`;
}

function diff(valueA: number | null, valueB: number | null) {
  if (valueA === null || valueB === null) {
    return null;
  }
  return roundTime(valueA - valueB);
}

async function captureCandidatePreviewFrames(video: HTMLVideoElement, rawTime: number): Promise<CandidatePreviewFrames> {
  try {
    const captureAt = async (time: number) => {
      await seekTo(video, clamp(time, 0, Math.max(0, video.duration - 0.001)));
      return captureFrame(video).dataUrl;
    };

    return {
      before: await captureAt(rawTime - 0.1),
      exact: await captureAt(rawTime),
      after: await captureAt(rawTime + 0.1),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown preview capture error.",
    };
  }
}

function movementCandidateKey(candidate: DetectionCandidate) {
  return `${candidate.rawTime.toFixed(3)}-${candidate.kind}`;
}

function movementDefinitionLabel(definition: FirstMovementDefinition) {
  return definition === "committed" ? "Committed Launch" : "Earliest Visible Motion";
}

function motionMarkerClass(kind: string) {
  if (kind.includes("Committed Launch")) {
    return "committed";
  }
  if (kind.includes("Largest Early Motion Spike")) {
    return "largest";
  }
  if (kind.includes("Possible preload")) {
    return "preload";
  }
  return "earliest";
}

function buildSplitMap(splitRows: Array<{ label: string; value: number | null }>) {
  return Object.fromEntries(splitRows.map((row) => [row.label, row.value]));
}

function exportCandidates(candidates: DetectionCandidate[], acceptedMarker: TimestampMarker) {
  return candidates.map((candidate) => {
    const accepted = acceptedMarker.rawTime !== null && Math.abs(acceptedMarker.rawTime - candidate.rawTime) <= 0.02;
    return {
      candidateRawTime: candidate.rawTime,
      candidateType: candidate.kind,
      score: candidate.score,
      confidence: candidate.confidence,
      reason: candidate.reason,
      accepted,
      rejected: !accepted,
    };
  });
}

function parseOptionalNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : null;
}

function formatExportTime(value: number | null | undefined) {
  return value === null || value === undefined ? "Not set" : `${value.toFixed(3)}s`;
}

function markdownTimestampRow(label: string, markerValue: TimestampMarker) {
  return `| ${label} | ${formatExportTime(markerValue.rawTime)} | ${formatExportTime(markerValue.climbTime)} | ${markerValue.source} | ${markerValue.confidence} | ${formatExportTime(markerValue.offsetApplied ?? null)} |\n`;
}

function markdownSplitRow(label: string, splits: Record<string, number | null>) {
  return `| ${label} | ${formatExportTime(splits[label])} |\n`;
}

function yamlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function formatRgb(rgb?: RGB) {
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "not set";
}

function downloadTextFile(fileName: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function writeFileToDirectory(directoryHandle: any, fileName: string, content: string) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function isDatasetExport(value: unknown): value is any {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.appVersion === "string" && Boolean(candidate.session) && Boolean(candidate.acceptedTimestamps);
}

function datasetToSavedSession(dataset: any): SavedAnalysisSession {
  const session = dataset.session ?? {};
  const video = dataset.video ?? {};
  const zonesFromDataset = dataset.zones ?? {};
  const settings = dataset.settings ?? {};
  const timestamps = timestampsFromDataset(dataset.acceptedTimestamps ?? []);

  return {
    id: session.sessionId || createSessionId(),
    version: 1,
    name: session.sessionName || "Imported ClimbIQ session",
    climberName: session.climberName || "",
    date: session.date || todayDateString(),
    location: session.location || session.gym || "",
    attemptType: session.attemptType || "Training",
    notes: session.notes || dataset.athleteNotes || "",
    createdAt: dataset.exportTimestamp || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    videoFileName: video.fileName || "",
    videoMetadata: video.fileName
      ? {
          fileName: video.fileName,
          duration: Number(video.duration) || 0,
          videoWidth: Number(video.videoWidth) || 0,
          videoHeight: Number(video.videoHeight) || 0,
          metadataLoaded: false,
        }
      : null,
    zones: {
      startLight: zonesFromDataset.startLightZone ?? undefined,
      startBody: zonesFromDataset.startBodyZone ?? undefined,
      hold10: zonesFromDataset.hold10Zone ?? undefined,
      finishLight: zonesFromDataset.finishLightZone ?? undefined,
    },
    startLightCalibration: {
      beforeStartRGB: dataset.calibration?.beforeStartRGB ?? undefined,
      afterStartRGB: dataset.calibration?.afterStartRGB ?? undefined,
      calibrationFrameBeforeTime: dataset.calibration?.calibrationFrameBeforeTime ?? undefined,
      calibrationFrameAfterTime: dataset.calibration?.calibrationFrameAfterTime ?? undefined,
      colorDelta: dataset.calibration?.colorDelta ?? undefined,
    },
    settings: {
      startSearchStart: Number(settings.startSearchStart) || 0,
      startSearchEnd: Number(settings.startSearchEnd) || 8,
      startSensitivity: settings.startSensitivity ?? "medium",
      startLightVisibility: settings.startLightVisibility ?? "clear",
      startDetectionProfile: settings.startDetectionProfile ?? "auto",
      reactionTimeOffset: Number(settings.reactionTimeOffset) || 0.2,
      startSignalOffset: Number(settings.startSignalOffset) || 0,
      movementSensitivity: settings.movementSensitivity ?? "medium",
      firstMovementDefinition: settings.firstMovementDefinition ?? "earliest",
      committedLaunchMinDelay: Number(settings.committedLaunchMinDelay) || 0.1,
      firstMovementOffset: Number(settings.firstMovementOffset) || 0,
      officialTotalTime: video.officialTotalTime !== null && video.officialTotalTime !== undefined ? String(video.officialTotalTime) : settings.officialTotalTime ?? "",
    },
    timestamps,
    splitCalculations: dataset.splitCalculations ?? {},
    biomechanics: sanitizeBiomechanicsSession(dataset.biomechanics),
  };
}

function timestampsFromDataset(values: any[]): TimestampMarker[] {
  const next = INITIAL_TIMESTAMPS.map((item) => ({ ...item }));
  for (const value of values) {
    const markerId = value.markerId as TimestampMarker["id"];
    const existing = next.find((item) => item.id === markerId);
    if (!existing) {
      continue;
    }
    existing.rawTime = typeof value.acceptedRawTime === "number" ? value.acceptedRawTime : null;
    existing.climbTime = typeof value.climbTime === "number" ? value.climbTime : null;
    existing.detectedRawTime = typeof value.detectedRawTime === "number" ? value.detectedRawTime : null;
    existing.offsetApplied = typeof value.offsetApplied === "number" ? value.offsetApplied : 0;
    existing.source = value.source ?? "Not set";
    existing.confidence = value.confidence ?? "None";
    existing.note = value.note ?? "";
  }
  return recalculateTimestampClimbs(next);
}

function mergeTimestampDefaults(values: TimestampMarker[]) {
  return INITIAL_TIMESTAMPS.map((defaultMarker) => ({
    ...defaultMarker,
    ...values.find((item) => item.id === defaultMarker.id),
  }));
}

function createDefaultBiomechanicsSession(): BiomechanicsSession {
  return {
    version: 1,
    settings: { ...DEFAULT_BIOMECHANICS_SETTINGS },
  };
}

function compactBiomechanicsSession(session: BiomechanicsSession): BiomechanicsSession {
  const sanitized = sanitizeBiomechanicsSession(session);
  if (!sanitized.result) {
    return sanitized;
  }
  return {
    ...sanitized,
    result: {
      ...sanitized.result,
      frames: sanitized.result.frames.map((frame) => ({ ...frame, landmarks: [] })),
    },
  };
}

function sanitizeBiomechanicsSession(value: unknown): BiomechanicsSession {
  const fallback = createDefaultBiomechanicsSession();
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const candidate = value as any;
  const settings = {
    sampleFps: [5, 10, 15].includes(Number(candidate.settings?.sampleFps))
      ? Number(candidate.settings.sampleFps)
      : fallback.settings.sampleFps,
    minVisibility: boundedNumber(candidate.settings?.minVisibility, 0.2, 0.9, fallback.settings.minVisibility),
    minMassCoverage: boundedNumber(candidate.settings?.minMassCoverage, 0.8, 1, fallback.settings.minMassCoverage),
    smoothingWindowSeconds: boundedNumber(
      candidate.settings?.smoothingWindowSeconds,
      0.1,
      0.35,
      fallback.settings.smoothingWindowSeconds,
    ),
    anthropometricModel: "athletevision-published-male-reference" as const,
  };

  const calibrationCandidate = candidate.calibration as WallCalibration | undefined;
  const calibration = validateWallCalibration(calibrationCandidate).valid ? calibrationCandidate : undefined;
  const resultCandidate = candidate.result;
  if (!calibration || !resultCandidate || typeof resultCandidate !== "object") {
    return { version: 1, settings, calibration };
  }

  const startRawTime = finiteNumber(resultCandidate.startRawTime);
  const endRawTime = finiteNumber(resultCandidate.endRawTime);
  if (startRawTime === undefined || endRawTime === undefined || startRawTime < 0 || endRawTime <= startRawTime) {
    return { version: 1, settings, calibration };
  }

  const frames = Array.isArray(resultCandidate.frames)
    ? (resultCandidate.frames as unknown[])
        .slice(0, 450)
        .map((frame) => sanitizeBiomechanicsFrame(frame, settings.minMassCoverage))
        .filter((frame): frame is BiomechanicsFrame => Boolean(frame))
    : [];
  if (!frames.length) {
    return { version: 1, settings, calibration };
  }
  const recomputed = applyTrajectoryKinematics(frames, settings, calibration);
  const result: BiomechanicsResult = {
    version: 1,
    createdAt: typeof resultCandidate.createdAt === "string" ? resultCandidate.createdAt : new Date().toISOString(),
    method: "MediaPipe Pose Landmarker",
    model: "Pose Landmarker Full",
    modelVersion: "float16/1",
    coordinateSystem: "calibrated-wall-plane",
    startRawTime,
    endRawTime,
    identityZone: sanitizeBiomechanicsIdentityZone(resultCandidate.identityZone),
    settings,
    frames: recomputed.frames,
    metrics: recomputed.metrics,
    warnings: recomputed.warnings,
  };
  return { version: 1, settings, calibration, result };
}

function sanitizeBiomechanicsFrame(value: unknown, minMassCoverage: number): BiomechanicsFrame | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as any;
  const rawTime = finiteNumber(candidate.rawTime);
  const climbTime = finiteNumber(candidate.climbTime);
  if (rawTime === undefined || climbTime === undefined || rawTime < 0) {
    return null;
  }
  const landmarks = Array.isArray(candidate.landmarks)
    ? candidate.landmarks.slice(0, 33).flatMap((landmark: any) => {
        const index = Number(landmark?.index);
        const x = finiteNumber(landmark?.x);
        const y = finiteNumber(landmark?.y);
        const z = finiteNumber(landmark?.z);
        const visibility = finiteNumber(landmark?.visibility);
        if (!Number.isInteger(index) || index < 0 || index > 32 || x === undefined || y === undefined || z === undefined ||
          visibility === undefined || x < -0.25 || x > 1.25 || y < -0.25 || y > 1.25 || visibility < 0 || visibility > 1) {
          return [];
        }
        return [{ index, x, y, z, visibility }];
      })
    : [];
  const imageCom = sanitizeNormalizedPoint(candidate.imageCom);
  const wallCom = sanitizeWallPoint(candidate.wallCom);
  const massCoverage = boundedNumber(candidate.massCoverage, 0, 1, 0);
  const meanVisibility = boundedNumber(candidate.meanVisibility, 0, 1, 0);
  const valid = Boolean(candidate.valid && imageCom && wallCom && massCoverage >= minMassCoverage);
  const poseSelected = typeof candidate.poseSelected === "boolean"
    ? candidate.poseSelected
    : landmarks.length > 0 || valid;
  const poseDetected = typeof candidate.poseDetected === "boolean"
    ? candidate.poseDetected
    : poseSelected;
  const poseCandidateCount = Number.isInteger(candidate.poseCandidateCount)
    ? Math.max(0, Math.min(2, Number(candidate.poseCandidateCount)))
    : poseDetected ? 1 : 0;
  return {
    rawTime,
    climbTime,
    poseDetected,
    poseSelected,
    poseCandidateCount,
    landmarks,
    imageCom,
    wallCom,
    massCoverage,
    meanVisibility,
    valid,
    warning: typeof candidate.warning === "string" ? candidate.warning.slice(0, 500) : undefined,
  };
}

function sanitizeNormalizedPoint(value: any) {
  const x = finiteNumber(value?.x);
  const y = finiteNumber(value?.y);
  return x !== undefined && y !== undefined && x >= -0.25 && x <= 1.25 && y >= -0.25 && y <= 1.25
    ? { x, y }
    : undefined;
}

function sanitizeWallPoint(value: any) {
  const xMeters = finiteNumber(value?.xMeters);
  const yMeters = finiteNumber(value?.yMeters);
  return xMeters !== undefined && yMeters !== undefined && xMeters >= -10 && xMeters <= 10 && yMeters >= -10 && yMeters <= 30
    ? { xMeters, yMeters }
    : undefined;
}

function sanitizeBiomechanicsIdentityZone(value: any): NormalizedZone | undefined {
  if (!value || value.id !== "startBody") {
    return undefined;
  }
  const x1 = finiteNumber(value.x1);
  const y1 = finiteNumber(value.y1);
  const x2 = finiteNumber(value.x2);
  const y2 = finiteNumber(value.y2);
  if ([x1, y1, x2, y2].some((coordinate) => coordinate === undefined || coordinate < 0 || coordinate > 1)) {
    return undefined;
  }
  return { id: "startBody", label: "Start Body Zone", x1: x1!, y1: y1!, x2: x2!, y2: y2! };
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = finiteNumber(value);
  return number === undefined || number < min || number > max ? fallback : number;
}

function videoMetadataMatches(actual: VideoMetadata, expected: VideoMetadata): boolean {
  if (actual.fileName !== expected.fileName) {
    return false;
  }
  const dimensionsMatch = !expected.videoWidth || !expected.videoHeight ||
    (actual.videoWidth === expected.videoWidth && actual.videoHeight === expected.videoHeight);
  const durationTolerance = Math.max(0.1, Math.abs(expected.duration) * 0.005);
  const durationMatches = !expected.duration || Math.abs(actual.duration - expected.duration) <= durationTolerance;
  return dimensionsMatch && durationMatches;
}

function normalizedZonesEqual(left?: NormalizedZone, right?: NormalizedZone): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.id === right.id &&
    Math.abs(left.x1 - right.x1) < 1e-6 &&
    Math.abs(left.y1 - right.y1) < 1e-6 &&
    Math.abs(left.x2 - right.x2) < 1e-6 &&
    Math.abs(left.y2 - right.y2) < 1e-6;
}

function readSavedSessions(): SavedAnalysisSession[] {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isSavedAnalysisSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function writeSavedSessions(sessions: SavedAnalysisSession[]) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function isSavedAnalysisSession(value: unknown): value is SavedAnalysisSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedAnalysisSession>;
  return (
    candidate.version === 1 &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Boolean(candidate.settings) &&
    Array.isArray(candidate.timestamps)
  );
}

function createSessionId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "climbiq-session";
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export default App;
