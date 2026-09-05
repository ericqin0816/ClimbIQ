import { ChangeEvent, CSSProperties, DragEvent, lazy, PointerEvent, Suspense, useEffect, useMemo, useRef, useState } from "react";
import "./components/SessionWorkflow.css";
import TimestampReviewPanel from "./components/TimestampReviewPanel";
import { readDecodedVideoFrameTime, sourceFrameStepTarget } from "./lib/decodedVideoFrame";
import { summarizeSourceSampleTiming } from "./lib/sourceSampleTiming";
import { useVideoFramePresentation } from "./lib/useVideoFramePresentation";
import { resolvePresentedFrameTime } from "./lib/videoFramePresentation";
import {
  resolveAutomaticPoseFinishBoundary,
  trimBiomechanicsResultAtFinish,
} from "./lib/biomechanicsFinish";
import { selectBiomechanicsResultCoveringRange } from "./lib/biomechanicsFreshness";
import {
  compactBiomechanicsSession,
  createDefaultBiomechanicsSession,
  sanitizeBiomechanicsSession,
} from "./lib/biomechanicsSession";
import { assessCameraStability, assessSceneContinuity } from "./lib/cameraStability";
import { assessStartLightArtifacts } from "./lib/startArtifactAudit";
import { detectFirstMovement } from "./lib/detectFirstMovement";
import { detectFinishSignal } from "./lib/detectFinishSignal";
import { yamlNumber, yamlString } from "./lib/exportFormatting";
import { calculateHold10PhaseSplits } from "./lib/hold10Splits";
import { detectAutomaticStartLight, type GreenBlueLaneCandidate } from "./lib/detectAutomaticStartLight";
import { detectAudioStartSignal, type AudioStartResult } from "./lib/detectAudioStartSignal";
import { detectMotionBasedStartEstimate } from "./lib/detectMotionBasedStartEstimate";
import { detectStartSignal } from "./lib/detectStartSignal";
import { detectHoldContact } from "./lib/holdContact";
import { resolveOfficialFinishRawTime } from "./lib/officialTime";
import { canAutomaticallyAcceptMovement } from "./lib/movementAcceptance";
import { sanitizeStartLightCalibration, sanitizeVideoMetadata, sanitizeZoneMap } from "./lib/sessionEvidenceIntegrity";
import { estimateHold10HeightPassage } from "./lib/hold10HeightEstimate";
import type { Hold10SecondPassResult } from "./lib/hold10SecondPass";
import type { Hold10TargetResolution } from "./lib/holdTarget";
import { resolveHold10Target } from "./lib/holdTarget";
import { analyzePoseVideo, PoseAnalysisCancelledError } from "./lib/poseAnalysis";
import { analyzeRouteSplits } from "./lib/routeSplits";
import { resolveStartSearchWindow, sanitizeAnalysisSessionSettings } from "./lib/analysisSettings";
import {
  alignStandardSpeedRouteWithFallback,
  type RouteAlignmentResult,
} from "./lib/routeAlignment";
import { fuseStartEvidence, type FusedStartDecision, type StartEvidence } from "./lib/startSignalFusion";
import { assessAutomaticStartBodyAudit } from "./lib/startBodyAudit";
import { deriveAutomaticStartBodyZone, resolveAnalysisBodyZone } from "./lib/startRegion";
import { applyTimestampAcceptance, clearMarkerTimestamp, recalculateTimestampClimbs, sanitizeTimestampSequence, sanitizeAcceptanceMode, timestampAcceptanceAudit } from "./lib/timestampIntegrity";
import { captureFrame, captureVideoPixels, clamp, hasUsableVideoMetadata, roundTime, sampleFrameAt, sampleZoneOpponentColor, seekTo } from "./lib/videoFrameSampler";
import { getVideoUiState } from "./lib/videoUiState";
import {
  createSessionLibraryBackup,
  isSessionLibraryBackup,
  mergeSessionLibraries,
} from "./lib/sessionLibrary";
import { resolveNewVideoSessionName, validateVideoFile } from "./lib/videoFileSelection";
import { inferAutomaticWallCalibration, validateWallCalibration } from "./lib/wallCalibration";
import type {
  Confidence,
  BiomechanicsSession,
  BiomechanicsResult,
  WallCalibration,
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
  ZoneId,
} from "./types";

const ZONES: Array<{ id: ZoneId; label: string; tone: string }> = [
  { id: "startLight", label: "Start Light Zone", tone: "#7dd3fc" },
  { id: "startBody", label: "Start Body Zone", tone: "#f0abfc" },
  { id: "hold10", label: "Hold 10 Zone", tone: "#facc15" },
];

const INITIAL_TIMESTAMPS: TimestampMarker[] = [
  marker("startSignal", "Start Signal"),
  marker("firstMovement", "Earliest Visible Motion"),
  marker("committedLaunch", "Committed Launch"),
  marker("firstHold", "First Hold"),
  marker("hold10", "Hold 10"),
  marker("finishPad", "Finish Pad"),
];

const APP_VERSION = "0.27.0";
const SESSION_STORAGE_KEY = "climbiq.analysisSessions.v1";
const AttemptComparisonPanel = lazy(() => import("./components/AttemptComparisonPanel"));
const Hold10SecondPassPanel = lazy(() => import("./components/Hold10SecondPassPanel"));
const BiomechanicsPanel = lazy(async () => {
  const module = await import("./components/BiomechanicsPanel");
  return { default: module.BiomechanicsPanel };
});
const PoseVideoOverlay = lazy(async () => {
  const module = await import("./components/BiomechanicsPanel");
  return { default: module.PoseVideoOverlay };
});
const DETECTOR_DERIVED_START_SOURCES = new Set<TimestampSource>([
  "Start light detection",
  "Fused start detection",
  "Motion-based estimate",
]);
const MOVEMENT_MARKER_IDS: TimestampMarker["id"][] = ["firstMovement", "committedLaunch"];

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

interface FusedStartEvidenceOutcome {
  decision: FusedStartDecision;
  automaticStart: StartSignalDetectionResult | null;
  audioReason: string;
  analysisBodyZone?: NormalizedZone;
  analysisLightZone?: NormalizedZone;
  analysisLightCalibration?: StartLightCalibration;
  analysisLaneCandidates?: AnalysisLaneCandidate[];
}

interface PendingAutomaticAnalysisContext {
  analysisBodyZone?: NormalizedZone;
  analysisLightZone?: NormalizedZone;
  analysisLightCalibration?: StartLightCalibration;
  analysisLaneCandidates?: AnalysisLaneCandidate[];
}

interface AnalysisLaneCandidate {
  zone: NormalizedZone;
  calibration: StartLightCalibration;
  label: string;
  startRawTime: number;
  score: number;
}

interface AutomaticFinishOutcome {
  rawTime: number;
  zone: NormalizedZone;
  calibration: StartLightCalibration;
  confidence: Confidence;
  accepted: boolean;
}

interface TimestampReviewTarget {
  label: string;
  suggestedRawTime: number;
  confidence?: Confidence;
  acceptLabel: string;
  onAccept: (rawTime: number, frameTimeNote?: string) => void;
  secondPassBasis?: Hold10SecondPassResult;
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
  const pendingAutomaticContextRef = useRef<PendingAutomaticAnalysisContext | null>(null);
  const automaticLaneCandidatesRef = useRef<AnalysisLaneCandidate[]>([]);
  const videoDragDepthRef = useRef(0);
  const reviewSeekRequestRef = useRef<number | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [videoLoadError, setVideoLoadError] = useState("");
  const [videoDropActive, setVideoDropActive] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [reviewFrameReady, setReviewFrameReady] = useState(true);
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
  const [startSearchEnd, setStartSearchEnd] = useState(12);
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
  const [finishResult, setFinishResult] = useState<StartSignalDetectionResult | null>(null);
  const [finishRunning, setFinishRunning] = useState(false);
  const [finishStatus, setFinishStatus] = useState("");
  const [timestamps, setTimestamps] = useState<TimestampMarker[]>(INITIAL_TIMESTAMPS);
  const [timestampStatus, setTimestampStatus] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [sessionName, setSessionName] = useState("Untitled climb analysis");
  const [climberName, setClimberName] = useState("");
  const [attemptDate, setAttemptDate] = useState(todayDateString());
  const [attemptLocation, setAttemptLocation] = useState("");
  const [attemptType, setAttemptType] = useState("Training");
  const [sessionNotes, setSessionNotes] = useState("");
  const [savedSessions, setSavedSessions] = useState<SavedAnalysisSession[]>(readSavedSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState("");
  const [libraryStatus, setLibraryStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [obsidianFolderName, setObsidianFolderName] = useState("");
  const [biomechanics, setBiomechanics] = useState<BiomechanicsSession>(createDefaultBiomechanicsSession());
  const [biomechanicsRunning, setBiomechanicsRunning] = useState(false);
  const [autoAnalysisRunning, setAutoAnalysisRunning] = useState(false);
  const [autoAnalysisStatus, setAutoAnalysisStatus] = useState("");
  const [startEvidenceStatus, setStartEvidenceStatus] = useState("");
  const [timestampReview, setTimestampReview] = useState<TimestampReviewTarget | null>(null);
  const [routeAlignment, setRouteAlignment] = useState<RouteAlignmentResult | null>(null);
  const [hold10SecondPass, setHold10SecondPass] = useState<{
    sourceResult: BiomechanicsResult; calibration: WallCalibration; targetKey: string; result: Hold10SecondPassResult;
  } | null>(null);
  const [secondPassRunning, setSecondPassRunning] = useState(false);
  const [secondPassStatus, setSecondPassStatus] = useState("");
  const secondPassAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      autoAnalysisAbortRef.current?.abort();
      secondPassAbortRef.current?.abort();
      if (reviewSeekRequestRef.current !== null) window.cancelAnimationFrame(reviewSeekRequestRef.current);
      if (previousObjectUrl.current) {
        URL.revokeObjectURL(previousObjectUrl.current);
        previousObjectUrl.current = null;
      }
    };
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
    const rawTime = metadata?.duration === undefined ? undefined : resolveOfficialFinishRawTime({
      startRawTime: startSignalRaw,
      videoDuration: metadata.duration,
      officialTotalSeconds: official,
    });
    if (rawTime === undefined) {
      return null;
    }
    return {
      rawTime: roundTime(rawTime),
      climbTime: roundTime(official),
    };
  }, [metadata?.duration, officialTotalTime, startSignalRaw]);
  const officialTimeError = useMemo(() => {
    if (!officialTotalTime.trim()) return "";
    const official = Number(officialTotalTime);
    if (!Number.isFinite(official) || official <= 0) {
      return "Official total time must be a positive number.";
    }
    if (startSignalRaw !== null && metadata?.duration && startSignalRaw + official > metadata.duration + 0.001) {
      return `Official total extends past the ${metadata.duration.toFixed(3)}s video. Check the value or load the complete attempt.`;
    }
    return "";
  }, [metadata?.duration, officialTotalTime, startSignalRaw]);

  const acceptedFinishRawTime = useMemo(
    () => getTimestamp(timestamps, "finishPad").rawTime,
    [timestamps],
  );
  const detectedFinishRawTime = finishResult?.detected && finishResult.rawTime !== undefined &&
      startSignalRaw !== null && finishResult.rawTime > startSignalRaw
    ? finishResult.rawTime
    : null;
  // Official timing is authoritative when supplied. Otherwise a verified but
  // still-unaccepted light result can safely bound pose analysis and prevent
  // a full-video descent trace while the user reviews the exact frame.
  const analysisFinishFallbackRawTime = finishSuggestion?.rawTime ?? detectedFinishRawTime;
  const freshBiomechanicsResult = useMemo(
    () => selectBiomechanicsResultCoveringRange(biomechanics.result, {
      startRawTime: startSignalRaw,
      endRawTime: acceptedFinishRawTime ?? analysisFinishFallbackRawTime,
      identityZone: zones.startBody,
    }),
    [acceptedFinishRawTime, analysisFinishFallbackRawTime, biomechanics.result, startSignalRaw, zones.startBody],
  );
  const finishTrimmedBiomechanics = useMemo(
    () => freshBiomechanicsResult && biomechanics.calibration
      ? trimBiomechanicsResultAtFinish(freshBiomechanicsResult, biomechanics.calibration, {
          acceptedFinishRawTime: acceptedFinishRawTime ?? analysisFinishFallbackRawTime,
        })
      : null,
    [acceptedFinishRawTime, analysisFinishFallbackRawTime, biomechanics.calibration, freshBiomechanicsResult],
  );
  const effectiveBiomechanicsResult = finishTrimmedBiomechanics?.result ?? freshBiomechanicsResult;

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
      { label: "Start to Hold 10", value: diff(hold10, start) },
      { label: "First Hold to Hold 10", value: diff(hold10, firstHold) },
      { label: "Hold 10 to Finish", value: diff(finish, hold10) },
      { label: "Movement Time", value: diff(finish, firstMovement) },
      { label: "Launch-to-Finish Time", value: diff(finish, committedLaunch) },
      { label: "Calculated Total Time", value: diff(finish, start) },
    ];
  }, [timestamps]);
  const displayedStartSearchWindow = metadata?.metadataLoaded
    ? resolveStartSearchWindow({ startSearchStart, startSearchEnd }, metadata.duration)
    : null;

  const routeSplitAnalysis = useMemo(
    () => effectiveBiomechanicsResult
      ? analyzeRouteSplits(effectiveBiomechanicsResult, 15, biomechanics.calibration?.confidence ?? "High")
      : null,
    [biomechanics.calibration?.confidence, effectiveBiomechanicsResult],
  );

  const hold10Target = useMemo(
    () => resolveHold10Target({
      manualZone: zones.hold10,
      calibration: biomechanics.calibration,
      visualAlignment: routeAlignment,
    }),
    [biomechanics.calibration, routeAlignment, zones.hold10],
  );
  const hold10ImageOverride = hold10Target.source === "manual-zone"
    ? hold10Target.imagePoint
    : undefined;
  // The digitized template is only a registration prior. It is too compressed
  // to time a real hand contact without visual alignment or a manual zone.
  const hold10WallTarget = hold10Target.source === "standard-template"
    ? null
    : hold10Target.wallTarget;

  const hold10Contact = useMemo(
    () => effectiveBiomechanicsResult && hold10WallTarget
      ? detectHoldContact(effectiveBiomechanicsResult, biomechanics.calibration, hold10WallTarget, { holdLabel: "Hold 10", observedRouteHolds: hold10Target.observedRouteHolds,
        allowApproximateEdgeProjection: hold10Target.allowApproximateEdgeProjection })
      : null,
    [biomechanics.calibration, effectiveBiomechanicsResult, hold10WallTarget, hold10Target.observedRouteHolds, hold10Target.allowApproximateEdgeProjection],
  );
  const hold10HeightEstimate = useMemo(
    () => effectiveBiomechanicsResult && !hold10Contact?.detected
      ? estimateHold10HeightPassage(effectiveBiomechanicsResult, biomechanics.calibration)
      : null,
    [biomechanics.calibration, effectiveBiomechanicsResult, hold10Contact?.detected],
  );

  const activeHold10SecondPass = hold10SecondPass && hold10SecondPass.sourceResult === effectiveBiomechanicsResult &&
    hold10SecondPass.calibration === biomechanics.calibration && hold10SecondPass.targetKey === JSON.stringify(hold10Target)
    ? hold10SecondPass.result : undefined;

  const startFinalRaw = startResult?.rawTime !== undefined ? Math.max(0, roundTime(startResult.rawTime + startSignalOffset)) : undefined;
  const movementFinalRaw = movementResult?.rawTime !== undefined ? Math.max(0, roundTime(movementResult.rawTime + firstMovementOffset)) : undefined;
  const movementFinalClimb =
    movementFinalRaw !== undefined && startSignalRaw !== null ? roundTime(movementFinalRaw - startSignalRaw) : movementResult?.climbTime;
  const calibrationReady = Boolean(
    startLightCalibration.beforeStartRGB &&
    startLightCalibration.afterStartRGB &&
    startLightCalibration.colorDelta !== undefined,
  );
  const hasCalibrationSamples = Boolean(
    startLightCalibration.beforeStartRGB ||
    startLightCalibration.afterStartRGB ||
    startLightCalibration.calibrationFrameBeforeTime !== undefined ||
    startLightCalibration.calibrationFrameAfterTime !== undefined,
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
  const videoAnalysisRunning = frameTestRunning || startRunning || movementRunning || movementPreviewRunning || finishRunning || biomechanicsRunning || autoAnalysisRunning || secondPassRunning;
  const visibleTimestampReview = timestampReview && (!timestampReview.secondPassBasis || timestampReview.secondPassBasis === activeHold10SecondPass) ? timestampReview : null;
  const framePresentation = useVideoFramePresentation(videoRef, videoUrl,
    !videoAnalysisRunning && (Boolean(visibleTimestampReview) || typeof globalThis.VideoFrame === "function"));
  const decodedReviewTime = resolvePresentedFrameTime({ src: videoUrl ?? "", currentTime, seeking: !reviewFrameReady }, framePresentation);
  const nativeFrameStepsAvailable = decodedReviewTime !== undefined && framePresentation.status === "available" && framePresentation.durationSeconds !== undefined;

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
    cancelPendingReviewSeek();
    pendingAutomaticContextRef.current = null;
    automaticLaneCandidatesRef.current = [];
    setFrameDebug(null);
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setFinishResult(null);
    setFinishStatus("");
    setTimestampStatus("");
    setMovementPreviewFrames({});
    setMovementPreviewRunning(false);
    setStartSearchStart(0);
    setStartSearchEnd(12);
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
    pendingAutomaticContextRef.current = null;
    setZones({});
    setBiomechanics(createDefaultBiomechanicsSession());
    setRouteAlignment(null);
    setBiomechanicsRunning(false);
    setStartEvidenceStatus("");
    setTimestampReview(null);
    setTimestamps(INITIAL_TIMESTAMPS);
    setActiveSessionId(null);
    setSessionName(resolveNewVideoSessionName(sessionName, metadata?.fileName, fileName));
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

    // Retain the File in app state/refs, then clear the native control so the
    // same clip can be selected again after a decode or metadata error.
    event.target.value = "";
    selectVideoFile(file);
  }

  function handleVideoDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (videoAnalysisRunning) return;
    videoDragDepthRef.current += 1;
    setVideoDropActive(true);
  }

  function handleVideoDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = videoAnalysisRunning ? "none" : "copy";
    }
  }

  function handleVideoDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    videoDragDepthRef.current = Math.max(0, videoDragDepthRef.current - 1);
    if (videoDragDepthRef.current === 0) {
      setVideoDropActive(false);
    }
  }

  function handleVideoDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    videoDragDepthRef.current = 0;
    setVideoDropActive(false);
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active analysis to finish before replacing the video.");
      return;
    }

    const files = [...event.dataTransfer.files];
    if (files.length !== 1) {
      setVideoLoadError(files.length > 1
        ? "Drop one video at a time so each analysis stays tied to the correct recording."
        : "No video file was found in that drop.");
      return;
    }
    selectVideoFile(files[0]);
  }

  function selectVideoFile(file: File) {
    cancelPendingReviewSeek();
    const validationError = validateVideoFile(file);
    if (validationError) {
      setVideoLoadError(validationError);
      setSessionStatus(validationError);
      return;
    }

    setVideoLoadError("");
    setHold10SecondPass(null);
    setSecondPassStatus("");

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
    setCurrentTime(0);
    setJumpInput("");
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
    setFinishResult(null);
    setFinishStatus("");
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
    if (!hasUsableVideoMetadata(video)) {
      const reason = "This file does not contain usable finite video metadata. Try converting it to an H.264 MP4.";
      setVideoLoadError(reason);
      setMetadata((current) => current ? { ...current, metadataLoaded: false } : null);
      setSessionStatus(reason);
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
      setStartSearchEnd(Math.min(12, video.duration));
      setSessionStatus("The selected video does not match the loaded session metadata. Saved analysis was detached to prevent incorrect overlays.");
    } else if (expected) {
      setSessionStatus(`Matching video attached to "${sessionName}". Saved zones, timestamps, and biomechanics were preserved.`);
    } else {
      setStartSearchEnd(Math.min(12, video.duration));
    }
  }

  async function stepVideo(delta: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.pause();
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

  function reviewTimestamp(target: TimestampReviewTarget) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.pause();
    cancelPendingReviewSeek();
    const source = video.src;
    setTimestampReview(target);
    setReviewFrameReady(false);
    reviewSeekRequestRef.current = window.requestAnimationFrame(() => {
      reviewSeekRequestRef.current = null;
      if (videoRef.current !== video || video.src !== source) return;
      document.getElementById("video-review")?.scrollIntoView({ behavior: "instant", block: "start" });
      video.currentTime = clamp(target.suggestedRawTime, 0, Math.max(0, video.duration - 0.001));
      setCurrentTime(video.currentTime);
      setReviewFrameReady(!video.seeking);
    });
  }

  function acceptReviewedTimestamp() {
    const video = videoRef.current;
    if (!visibleTimestampReview || !video || !video.paused || video.seeking || videoAnalysisRunning) return;
    const decodedTime = resolvePresentedFrameTime(video, framePresentation);
    const frameDurationNote = decodedTime !== undefined && framePresentation.status === "available" && framePresentation.durationSeconds !== undefined
      ? ` Source frame duration ${framePresentation.durationSeconds.toFixed(6)}s; not an event-error bound.` : "";
    visibleTimestampReview.onAccept(decodedTime ?? video.currentTime, decodedTime !== undefined
      ? `Used browser presented-frame timestamp ${decodedTime.toFixed(6)}s (cursor ${video.currentTime.toFixed(6)}s).${frameDurationNote}`
      : `Frame timestamp unavailable; used paused cursor ${video.currentTime.toFixed(6)}s.`);
    closeTimestampReview();
  }

  function cancelPendingReviewSeek() {
    if (reviewSeekRequestRef.current !== null) window.cancelAnimationFrame(reviewSeekRequestRef.current);
    reviewSeekRequestRef.current = null;
  }

  function stepSourceFrame(direction: -1 | 1) {
    const video = videoRef.current;
    if (!video || videoAnalysisRunning) return;
    video.pause();
    const frame = readDecodedVideoFrameTime(video);
    const target = frame ? sourceFrameStepTarget(frame, video.duration, direction) : undefined;
    if (target === undefined) {
      stepVideo(direction * 0.03);
      setVideoRestoreStatus("Native frame duration unavailable; moved the approximate cursor by 0.03s.");
    } else {
      jumpTo(target);
      setVideoRestoreStatus("");
    }
  }

  function closeTimestampReview() {
    cancelPendingReviewSeek();
    setTimestampReview(null);
  }

  async function calculateHold10SecondPass(video: HTMLVideoElement, broad: BiomechanicsResult,
    calibration: WallCalibration, target: Hold10TargetResolution, signal?: AbortSignal,
    onProgress?: (message: string) => void) {
    try {
      const { runHold10SecondPass } = await import("./lib/hold10SecondPass");
      if (signal?.aborted) throw new PoseAnalysisCancelledError();
      const result = await runHold10SecondPass({ video, broad, calibration, target, signal, onProgress });
      if (signal?.aborted) throw new PoseAnalysisCancelledError();
      if (result) {
        setHold10SecondPass({ sourceResult: broad, calibration, targetKey: JSON.stringify(target), result });
        setSecondPassStatus("");
      } else {
        setSecondPassStatus("A continuous Hold 10 candidate and nearby athlete track are needed for a closer scan.");
      }
    } catch (error) {
      if (signal?.aborted || error instanceof PoseAnalysisCancelledError) throw error;
      setSecondPassStatus(`The closer scan could not finish. Broad-pass timing was kept. ${error instanceof Error ? error.message : "Try again."}`);
    }
  }

  async function refineCurrentHold10() {
    if (videoAnalysisRunning || secondPassAbortRef.current || !videoRef.current || !effectiveBiomechanicsResult || !biomechanics.calibration) return;
    const controller = new AbortController();
    secondPassAbortRef.current = controller;
    setSecondPassRunning(true);
    setSecondPassStatus("Preparing a closer Hold 10 scan…");
    try {
      await runNamedVideoTask("Hold 10 second pass", async () => {
        let target = hold10Target;
        // Registered silhouettes are transient video evidence. Rebuild them
        // after reattaching a saved recording instead of silently reverting a
        // previously identified hold to a generic height estimate.
        if (target.source === "standard-template" && !routeAlignment) {
          setSecondPassStatus("Rechecking the visible route for this saved analysis…");
          const alignment = await locateVisibleRouteHolds(effectiveBiomechanicsResult.startRawTime,
            effectiveBiomechanicsResult.endRawTime, biomechanics.calibration!, controller.signal);
          if (controller.signal.aborted) throw new PoseAnalysisCancelledError();
          target = resolveHold10Target({ manualZone: zones.hold10, calibration: biomechanics.calibration, visualAlignment: alignment });
        }
        await calculateHold10SecondPass(videoRef.current!, effectiveBiomechanicsResult,
          biomechanics.calibration!, target, controller.signal, setSecondPassStatus);
      },
        "Hold 10 inspection finished. Video position restored.");
    } catch {
      setSecondPassStatus(controller.signal.aborted ? "Closer scan cancelled. Existing timing was kept." : "Closer scan stopped.");
    } finally {
      secondPassAbortRef.current = null;
      setSecondPassRunning(false);
    }
  }

  function reviewRefinedHold10(rawTime: number) {
    const evidence = activeHold10SecondPass?.evidence;
    if (!evidence || videoAnalysisRunning) return;
    reviewTimestamp({ label: evidence.kind === "contact-candidate" ? "Hold 10 contact candidate — second pass" : "Possible Hold 10 — second pass",
      secondPassBasis: activeHold10SecondPass,
      suggestedRawTime: rawTime, confidence: "Low", acceptLabel: "Set Hold 10",
      onAccept: (time, frameTimeNote) => acceptTimestamp("hold10", time, "Manual", "Medium", {
        frameReviewed: true,
        detectedRawTime: evidence.candidateRawTime,
        offsetApplied: roundTime(time - evidence.candidateRawTime),
        note: `${evidence.reason} Broad cursor ${evidence.coarseRawTime.toFixed(3)}s; second-pass cursor ${evidence.candidateRawTime.toFixed(3)}s. Accepted after reviewing the full video. ${frameTimeNote ?? ""}`,
      }),
    });
  }

  async function runWithVideoRestore<T>(
    video: HTMLVideoElement,
    work: () => Promise<T>,
    completeMessage: string,
    taskName = "video analysis",
  ): Promise<T> {
    const previousTask = videoTaskQueueRef.current;
    cancelPendingReviewSeek();
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
      pendingAutomaticContextRef.current = null;
      if (draftZone.id === "startLight") {
        invalidateStartLightDependents("Start-light region changed. Its colors will be learned again on the next analysis.");
      }
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

    // A zone auto-located by a previous run routes through the shared fused pipeline;
    // only a zone the user drew themselves (with a non-auto profile) uses the manual path.
    const userDrawnLightZone = zones.startLight && !zones.startLight.label.startsWith("Auto-detected")
      ? zones.startLight
      : undefined;
    const searchWindow = resolveStartSearchWindow({ startSearchStart, startSearchEnd }, video.duration);
    pendingAutomaticContextRef.current = null;
    setStartRunning(true);
    let reviewSeekTarget: number | null = null;
    try {
      await runWithVideoRestore(
        video,
        async () => {
          if (resolvedStartProfile === "motion") {
            setStartResult(await detectMotionBasedStartEstimate({
              video,
              zone: zones.startBody,
              searchStart: searchWindow.start,
              searchEnd: searchWindow.end,
              reactionOffset: reactionTimeOffset,
              sensitivity: startSensitivity,
            }));
            return;
          }
          if (userDrawnLightZone && startDetectionProfile !== "auto") {
            setStartResult(await detectStartSignal({
              video,
              zone: userDrawnLightZone,
              searchStart: searchWindow.start,
              searchEnd: searchWindow.end,
              sensitivity: startSensitivity,
              lightVisibility: startLightVisibility,
              profile: resolvedStartProfile,
              calibration: startLightCalibration,
              colorSamplingMode: calibrationReady ? "opponent" : "average",
            }));
            return;
          }

          // Same fused light/beep/motion pipeline as Quick Analyze, so both buttons
          // always produce the same start time.
          const {
            decision,
            automaticStart,
            audioReason,
            analysisBodyZone,
            analysisLightZone,
            analysisLightCalibration,
            analysisLaneCandidates,
          } = await gatherFusedStartEvidence(
            video,
            undefined,
            setVideoRestoreStatus,
          );
          setStartEvidenceStatus(`${decision.reason} Audio: ${audioReason}`);
          if (!decision.found || decision.rawTime === undefined || !automaticStart) {
            pendingAutomaticContextRef.current = null;
            setStartResult(null);
            setAutoAnalysisStatus("Start could not be confirmed. Review the video, then open the marker editor to set the exact frame.");
            return;
          }
          setStartResult(automaticStart);
          if (decision.autoAccept) {
            const acceptedStart = Math.max(0, roundTime(decision.rawTime + startSignalOffset));
            const startAudit = await auditAutomaticStartCandidate(
              video,
              acceptedStart,
              analysisBodyZone,
            );
            setStartResult({
              ...automaticStart,
              debug: { ...automaticStart.debug, sceneContinuity: startAudit.scene },
            });
            setMovementResult(startAudit.movement);
            setStartEvidenceStatus(`${decision.reason} ${startAudit.reason} Audio: ${audioReason}`);
            if (!startAudit.safeToAutoAccept) {
              pendingAutomaticContextRef.current = {
                analysisBodyZone,
                analysisLightZone,
                analysisLightCalibration,
                analysisLaneCandidates,
              };
              setSuggestedStartRawTime(decision.rawTime);
              reviewSeekTarget = decision.rawTime;
              setAutoAnalysisStatus(`Start cues need review. ${startAudit.reason}`);
              return;
            }
            pendingAutomaticContextRef.current = null;
            acceptTimestamp(
              "startSignal",
              acceptedStart,
              startSourceForResult(automaticStart),
              automaticStart.confidence,
              {
                detectedRawTime: decision.rawTime,
                offsetApplied: startSignalOffset,
                note: `Automatically accepted by start detection. ${automaticStart.reason}`,
              },
            );
            setSuggestedStartRawTime(null);
            setAutoAnalysisStatus(`Start Signal accepted at ${acceptedStart.toFixed(3)}s. ${decision.reason}`);
          } else {
            pendingAutomaticContextRef.current = {
              analysisBodyZone,
              analysisLightZone,
              analysisLightCalibration,
              analysisLaneCandidates,
            };
            setSuggestedStartRawTime(decision.rawTime);
            reviewSeekTarget = decision.rawTime;
            setAutoAnalysisStatus(
              `Start evidence needs review at ${decision.rawTime.toFixed(3)}s. Open “Review suggested start,” step to the exact frame, then accept the frame on screen.`,
            );
          }
        },
        "Start detection complete. Video restored to previous position.",
      );
      if (reviewSeekTarget !== null) {
        jumpTo(reviewSeekTarget);
      }
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
    const searchWindow = resolveStartSearchWindow({ startSearchStart, startSearchEnd }, video.duration);
    try {
      await runWithVideoRestore(
        video,
        async () => {
          const result = await detectMotionBasedStartEstimate({
            video,
            zone: zones.startBody,
            searchStart: searchWindow.start,
            searchEnd: searchWindow.end,
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
      sample = await sampleZoneOpponentColor(video, video.currentTime, zone);
    } catch (error) {
      setCalibrationStatus(error instanceof Error ? `Calibration sample failed: ${error.message}` : "Calibration sample failed.");
      return;
    }
    pendingAutomaticContextRef.current = null;
    automaticLaneCandidatesRef.current = [];
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
    const acceptedStart = getTimestamp(timestamps, "startSignal");
    const lightDerivedStart = acceptedStart.source === "Start light detection" || acceptedStart.source === "Fused start detection";
    if (lightDerivedStart) {
      clearTimestamp("startSignal");
      setAutoAnalysisStatus("The accepted Start used the old light calibration, so Start and all dependent timing were cleared.");
    } else {
      invalidateStartDetectorSuggestion("Start-light calibration changed. Run the analysis again to generate a matching suggestion.");
      clearFinishDependents();
    }
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

  async function runAutomaticFinishDetection() {
    const video = videoRef.current;
    if (!video || !metadata?.metadataLoaded || startSignalRaw === null) {
      setFinishStatus("Accept a Start Signal before finding the finish automatically.");
      return;
    }
    setFinishRunning(true);
    setFinishResult(null);
    setFinishStatus("Watching the selected lane light for its finish reversal…");
    try {
      await runWithVideoRestore(
        video,
        () => detectAndMaybeAcceptFinish(
          video,
          startSignalRaw,
          zones.startLight,
          startLightCalibration,
          "Accepted by automatic finish detection.",
          undefined,
          setFinishStatus,
          automaticLaneCandidatesRef.current,
        ),
        "Automatic finish detection complete. Video restored to previous position.",
        "finish detection",
      );
    } catch (error) {
      setFinishStatus(error instanceof Error ? `Finish detection stopped: ${error.message}` : "Finish detection stopped.");
    } finally {
      setFinishRunning(false);
    }
  }

  /**
   * Shared start-evidence pipeline used by both Quick Analyze and the Start Timing
   * card's "Find start automatically" button so they always agree: lane-light
   * discovery, saved-zone fallback, audio beep detection, motion estimate, and fusion.
   */
  async function gatherFusedStartEvidence(
    video: HTMLVideoElement,
    signal: AbortSignal | undefined,
    onStatus: (message: string) => void,
  ): Promise<FusedStartEvidenceOutcome> {
    automaticLaneCandidatesRef.current = [];
    const searchWindow = resolveStartSearchWindow({ startSearchStart, startSearchEnd }, video.duration);
    const searchStart = searchWindow.start;
    // Honor an absolute search end so timing resets and later races cannot
    // become Start candidates. A full-event video can still target one attempt
    // by entering that attempt's source-time range in the advanced controls.
    const searchEnd = searchWindow.end;
    onStatus("Listening for two matching beeps and the different-pitch start beep…");
    const audioStart: AudioStartResult = videoFileRef.current
      ? await detectAudioStartSignal({
          file: videoFileRef.current,
          searchStart,
          searchEnd,
          signal,
        })
      : {
          found: false,
          confidence: "None" as Confidence,
          reason: "The original local video file is unavailable for audio analysis.",
          segments: [],
        };
    onStatus(audioStart.found && audioStart.rawTime !== undefined
      ? `Start-beep pattern found near ${audioStart.rawTime.toFixed(3)}s. Scanning both lanes for faint lights…`
      : "Audio pattern was inconclusive. Scanning both lanes for faint lights…");
    const trustedBodyZone = zones.startBody && !zones.startBody.label.startsWith("Automatic lane")
      ? zones.startBody
      : undefined;
    const automaticLight = await detectAutomaticStartLight({
      video,
      searchStart,
      searchEnd,
      startBodyZone: trustedBodyZone,
      expectedStartTime: audioStart.matchedPattern === "two-same-then-different" && audioStart.confidence === "High"
        ? audioStart.rawTime
        : undefined,
      signal,
      onProgress: (processed, total) => {
        onStatus(`Scanning lane lights: ${processed}/${total} frames…`);
      },
    });
    const automaticLaneCandidates = automaticLight.laneCandidates ?? [];
    const colorRecords: Array<{
      result: StartSignalDetectionResult;
      lane?: GreenBlueLaneCandidate;
      label: string;
      automaticVoteAllowed?: boolean;
      artifactReason?: string;
    }> = (automaticLight.laneResults ?? (automaticLight.result ? [automaticLight.result] : []))
      .map((result, index) => ({
        result,
        lane: automaticLaneCandidates[index],
        label: `automatic lane light ${index + 1}`,
      }))
      .filter((record) => record.result.detected && record.result.rawTime !== undefined);

    if (!colorRecords.some((record) => record.result.confidence !== "Low") && zones.startLight) {
      onStatus("Automatic light search was inconclusive. Checking the saved Start Light Zone…");
      const savedZoneResult = await detectStartSignal({
          video,
          zone: zones.startLight,
          searchStart,
          searchEnd,
          sensitivity: startSensitivity,
          lightVisibility: startLightVisibility,
          profile: calibrationReady ? "calibrated" : "auto",
          calibration: startLightCalibration,
          colorSamplingMode: calibrationReady ? "opponent" : "average",
          signal,
        });
      if (savedZoneResult.detected && savedZoneResult.rawTime !== undefined) {
        colorRecords.push({ result: savedZoneResult, lane: undefined, label: "saved start-light zone" });
      }
    }

    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    onStatus("Checking start-light candidates for camera cuts and screen graphics…");
    for (const record of colorRecords) {
      if (record.result.confidence === "Low" || record.result.rawTime === undefined) continue;
      if (signal?.aborted) throw new PoseAnalysisCancelledError();
      await seekTo(video, Math.max(searchStart, record.result.rawTime - 0.18));
      const before = captureVideoPixels(video);
      before.canvas.width = 1;
      await seekTo(video, Math.min(searchEnd, video.duration - 0.001, record.result.rawTime + 0.18));
      const after = captureVideoPixels(video);
      after.canvas.width = 1;
      const audit = assessStartLightArtifacts(before.imageData, after.imageData,
        record.result.debug.normalizedZone ?? record.lane?.zone, Boolean(record.lane));
      if (!audit.usableForAutomaticVote) {
        record.automaticVoteAllowed = false;
        record.artifactReason = audit.reason;
        record.result = { ...record.result,
          reason: `${record.result.reason} ${audit.reason}`,
          debug: { ...record.result.debug, sceneContinuity: audit.scene },
        };
      }
    }
    onStatus("Comparing lane lights, final beep, and body motion…");
    const motionProbeZone = trustedBodyZone ??
      (automaticLight.zone ? deriveAutomaticStartBodyZone(automaticLight.zone) : undefined);
    const exactAudioTime = audioStart.matchedPattern === "two-same-then-different" &&
        audioStart.confidence === "High"
      ? audioStart.rawTime
      : undefined;
    const motionStart = motionProbeZone
      ? await detectMotionBasedStartEstimate({
          video,
          zone: motionProbeZone,
          searchStart: exactAudioTime === undefined ? searchStart : Math.max(searchStart, exactAudioTime - 0.25),
          searchEnd: exactAudioTime === undefined ? searchEnd : Math.min(searchEnd, exactAudioTime + 0.9),
          reactionOffset: reactionTimeOffset,
          sensitivity: startSensitivity,
        })
      : null;

    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }

    const evidence: StartEvidence[] = colorRecords.map(({ result, label, automaticVoteAllowed, artifactReason }) => ({
      kind: "color",
      rawTime: result.rawTime!,
      confidence: result.confidence,
      reason: result.reason,
      label,
      automaticVoteAllowed, artifactReason,
    }));
    if (audioStart.found && audioStart.rawTime !== undefined) {
      evidence.push({
        kind: "audio",
        rawTime: audioStart.rawTime,
        confidence: audioStart.confidence,
        reason: audioStart.reason,
        label: "changed-pitch final start beep",
      });
    }
    if (motionStart?.detected && motionStart.rawTime !== undefined) {
      evidence.push({
        kind: "motion",
        rawTime: motionStart.rawTime,
        confidence: trustedBodyZone ? motionStart.confidence : "Low",
        reason: motionStart.reason,
        label: trustedBodyZone ? "body motion estimate" : "lane-localized body motion estimate",
      });
    }
    const decision = fuseStartEvidence(evidence);
    if (!decision.found || decision.rawTime === undefined) {
      return {
        decision,
        automaticStart: null,
        audioReason: audioStart.reason,
        analysisBodyZone: trustedBodyZone,
      };
    }

    const supportingColorLabels = new Set(
      decision.supportingEvidence
        .filter((item) => item.kind === "color")
        .map((item) => item.label),
    );
    const reviewColorRecords = colorRecords
      .filter((record) =>
        supportingColorLabels.has(record.label) ||
        (record.result.confidence !== "Low" && Math.abs(record.result.rawTime! - decision.rawTime!) <= 0.35),
      )
      .sort((left, right) =>
        Math.abs(left.result.rawTime! - decision.rawTime!) - Math.abs(right.result.rawTime! - decision.rawTime!) ||
        (right.lane?.score ?? 0) - (left.lane?.score ?? 0),
      );
    const supportingColorRecords = reviewColorRecords.filter(record => record.automaticVoteAllowed !== false);
    const closestColorRecord = supportingColorRecords[0];
    const analysisLaneCandidates = deduplicateAnalysisLaneCandidates(
      supportingColorRecords.flatMap((record): AnalysisLaneCandidate[] => {
        const zone = record.lane?.zone ??
          (record.label === "saved start-light zone" ? zones.startLight : undefined);
        const candidateCalibration = record.result.debug.calibration ?? record.lane?.calibration ??
          (record.label === "saved start-light zone" && calibrationReady ? startLightCalibration : undefined);
        if (!zone || !candidateCalibration?.beforeStartRGB || !candidateCalibration.afterStartRGB) {
          return [];
        }
        return [{
          zone,
          calibration: candidateCalibration,
          label: record.label,
          startRawTime: record.result.rawTime!,
          score: record.lane?.score ?? 0,
        }];
      }),
    );
    automaticLaneCandidatesRef.current = analysisLaneCandidates;
    // A discovered lane is safe to use for athlete tracking only when that
    // color cue actually supports the fused start decision. The detector may
    // still expose rejected candidates for diagnostics, but those candidates
    // must never steer first-movement or pose analysis.
    const analysisBodyZone = resolveAnalysisBodyZone(trustedBodyZone, closestColorRecord?.lane?.zone);
    const analysisLightZone = closestColorRecord?.lane?.zone ??
      (closestColorRecord?.label === "saved start-light zone" ? zones.startLight : undefined);
    const analysisLightCalibration = closestColorRecord?.result.debug.calibration ??
      closestColorRecord?.lane?.calibration ??
      (closestColorRecord?.label === "saved start-light zone" && calibrationReady ? startLightCalibration : undefined);
    if (closestColorRecord?.lane) {
      const selectedLane = closestColorRecord.lane;
      clearFinishDependents();
      setZones((current) => ({ ...current, startLight: selectedLane.zone }));
      setStartLightCalibration(analysisLightCalibration ?? selectedLane.calibration);
      setStartDetectionProfile("calibrated");
      setCalibrationStatus(
        `Verified ${closestColorRecord.label} near ${Math.round(((selectedLane.zone.x1 + selectedLane.zone.x2) / 2) * 100)}% across and ${Math.round(((selectedLane.zone.y1 + selectedLane.zone.y2) / 2) * 100)}% down the frame.`,
      );
    }
    const supportsMotion = decision.supportingEvidence.some((item) => item.kind === "motion");
    const baseResult = closestColorRecord?.result ?? reviewColorRecords[0]?.result ??
      (supportsMotion && motionStart?.detected ? motionStart : buildAudioStartResult(audioStart));
    const automaticStart: StartSignalDetectionResult = {
      ...baseResult,
      detected: true,
      rawTime: decision.rawTime,
      confidence: decision.confidence,
      reason: decision.reason,
      candidates: evidence.map((item) => ({
        rawTime: item.rawTime,
        confidence: item.automaticVoteAllowed === false ? "Low" : item.confidence,
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
    return {
      decision,
      automaticStart,
      audioReason: audioStart.reason,
      analysisBodyZone,
      analysisLightZone,
      analysisLightCalibration,
      analysisLaneCandidates,
    };
  }

  async function locateVisibleRouteHolds(
    startRawTime: number,
    endRawTime: number,
    calibration: NonNullable<BiomechanicsSession["calibration"]>,
    signal?: AbortSignal,
    identityZoneOverride?: NormalizedZone,
  ): Promise<RouteAlignmentResult> {
    const video = videoRef.current;
    if (!video) {
      throw new Error("Load the video before locating route holds.");
    }
    const duration = Math.max(0.001, endRawTime - startRawTime);
    const fractions = [0.04, 0.19, 0.36, 0.53, 0.7, 0.86, 0.96];
    const frames: ImageData[] = [];
    for (const fraction of fractions) {
      if (signal?.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      const time = clamp(startRawTime + duration * fraction, 0, Math.max(0, video.duration - 0.001));
      await seekTo(video, time);
      frames.push(captureVideoPixels(video).imageData);
    }
    const { result } = alignStandardSpeedRouteWithFallback(frames, calibration, {
      startBodyZone: identityZoneOverride ?? zones.startBody,
    });
    setRouteAlignment(result);
    return result;
  }

  async function auditAutomaticStartCandidate(
    video: HTMLVideoElement,
    acceptedStart: number,
    analysisBodyZone?: NormalizedZone,
    signal?: AbortSignal,
  ) {
    const movement = await detectFirstMovement({
      video,
      zone: analysisBodyZone,
      startSignalRawTime: acceptedStart,
      sensitivity: movementSensitivity,
      movementDefinition: firstMovementDefinition,
      committedLaunchMinDelay,
    });
    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    const bodyAudit = assessAutomaticStartBodyAudit(movement, acceptedStart);
    const beforeTime = Math.max(0, acceptedStart - 0.18);
    const afterTime = Math.min(Math.max(0, video.duration - 0.001), acceptedStart + 0.18);
    await seekTo(video, beforeTime);
    const before = captureVideoPixels(video).imageData;
    await seekTo(video, afterTime);
    const after = captureVideoPixels(video).imageData;
    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    const scene = assessSceneContinuity(before, after);
    const sceneSafe = !scene.assessable || scene.continuous;
    return {
      movement,
      safeToAutoAccept: bodyAudit.safeToAutoAccept && sceneSafe,
      reason: !sceneSafe ? scene.reason : bodyAudit.reason,
      bodyAudit,
      scene,
    };
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
    setFinishResult(null);
    setFinishStatus("");
    setMovementPreviewFrames({});
    setRouteAlignment(null);
    pendingAutomaticContextRef.current = null;
    let reviewSeekTarget: number | null = null;

    try {
      await runWithVideoRestore(
        video,
        async () => {
          const {
            decision,
            automaticStart,
            audioReason,
            analysisBodyZone,
            analysisLightZone,
            analysisLightCalibration,
            analysisLaneCandidates,
          } = await gatherFusedStartEvidence(
            video,
            abortController.signal,
            setAutoAnalysisStatus,
          );
          setStartEvidenceStatus(`${decision.reason} Audio: ${audioReason}`);
          if (!decision.found || decision.rawTime === undefined || !automaticStart) {
            pendingAutomaticContextRef.current = null;
            setAutoAnalysisStatus("Start could not be confirmed. Review the video, then open the marker editor to set the exact frame.");
            return;
          }
          setStartResult(automaticStart);
          if (!decision.autoAccept) {
            pendingAutomaticContextRef.current = {
              analysisBodyZone,
              analysisLightZone,
              analysisLightCalibration,
              analysisLaneCandidates,
            };
            setSuggestedStartRawTime(decision.rawTime);
            reviewSeekTarget = decision.rawTime;
            setAutoAnalysisStatus(
              `Start evidence needs review at ${decision.rawTime.toFixed(3)}s. Open “Review suggested start,” step to the exact frame, then accept the frame on screen.`,
            );
            return;
          }

          const acceptedStart = Math.max(0, roundTime(decision.rawTime + startSignalOffset));
          setAutoAnalysisStatus("Start cues found. Verifying that the selected athlete launches after them…");
          const startAudit = await auditAutomaticStartCandidate(
            video,
            acceptedStart,
            analysisBodyZone,
            abortController.signal,
          );
          const preflightMovement = startAudit.movement;
          setStartResult({
            ...automaticStart,
            debug: { ...automaticStart.debug, sceneContinuity: startAudit.scene },
          });
          setMovementResult(preflightMovement);
          setStartEvidenceStatus(`${decision.reason} ${startAudit.reason} Audio: ${audioReason}`);
          if (!startAudit.safeToAutoAccept) {
            pendingAutomaticContextRef.current = {
              analysisBodyZone,
              analysisLightZone,
              analysisLightCalibration,
              analysisLaneCandidates,
            };
            setSuggestedStartRawTime(decision.rawTime);
            reviewSeekTarget = decision.rawTime;
            setAutoAnalysisStatus(
              `Start cues need review before the timestamp can be accepted. ${startAudit.reason}`,
            );
            return;
          }
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

          pendingAutomaticContextRef.current = null;
          await continueAutomaticAnalysisAfterStart(
            video,
            acceptedStart,
            { analysisBodyZone, analysisLightZone, analysisLightCalibration, analysisLaneCandidates },
            "Automatically accepted by Quick Analyze.",
            abortController.signal,
            preflightMovement,
          );
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
    zoneOverride?: NormalizedZone,
    precomputed?: FirstMovementDetectionResult,
    finishRawTime?: number,
  ): Promise<boolean> {
    const automaticMovement = precomputed ?? await detectFirstMovement({
      video,
      zone: zoneOverride ?? zones.startBody,
      startSignalRawTime: acceptedStart,
      sensitivity: movementSensitivity,
      movementDefinition: firstMovementDefinition,
      committedLaunchMinDelay,
    });
    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    const finalRawTime = automaticMovement.rawTime === undefined
      ? Number.NaN
      : roundTime(automaticMovement.rawTime + firstMovementOffset);
    const correctedTimeOutOfRange = automaticMovement.rawTime !== undefined && (
      finalRawTime < acceptedStart + 0.1 - 1e-6 ||
      finalRawTime > video.duration + 0.001 ||
      (Number.isFinite(finishRawTime) && finalRawTime >= finishRawTime! - 0.001)
    );
    setMovementResult(correctedTimeOutOfRange ? {
      ...automaticMovement,
      reason: `${automaticMovement.reason} The configured offset moves the final marker outside the valid post-Start reaction/video range, so it requires review.`,
    } : automaticMovement);
    const accepted = canAutomaticallyAcceptMovement(
      automaticMovement,
      finalRawTime,
      acceptedStart,
      video.duration,
      finishRawTime,
    );
    if (accepted && automaticMovement.rawTime !== undefined) {
      const markerId = firstMovementDefinition === "committed" ? "committedLaunch" : "firstMovement";
      acceptTimestamp(
        markerId,
        finalRawTime,
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

  async function continueAutomaticAnalysisAfterStart(
    video: HTMLVideoElement,
    acceptedStart: number,
    context: PendingAutomaticAnalysisContext,
    notePrefix: string,
    signal?: AbortSignal,
    preflightMovement?: FirstMovementDetectionResult,
  ): Promise<void> {
    setAutoAnalysisStatus("Start found. Checking the verified lane light for the finish…");
    const automaticFinish = await detectAndMaybeAcceptFinish(
      video,
      acceptedStart,
      context.analysisLightZone,
      context.analysisLightCalibration,
      notePrefix,
      signal,
      setAutoAnalysisStatus,
      context.analysisLaneCandidates,
    );
    // If two lanes started together and only the fallback lane has a valid
    // finish, use that same lane to localize the athlete. A user-drawn body zone
    // remains authoritative.
    const trustedBodyZone = zones.startBody && !zones.startBody.label.startsWith("Automatic lane")
      ? zones.startBody
      : undefined;
    const analysisBodyZone = trustedBodyZone ??
      (automaticFinish ? deriveAutomaticStartBodyZone(automaticFinish.zone) : context.analysisBodyZone);
    // Persist the winning automatic lane so the result overlay and COM panel
    // use the same identity region. Automatic zones remain replaceable on the
    // next run; a genuinely user-drawn Start Body Zone stays authoritative.
    if (!trustedBodyZone && analysisBodyZone) {
      setZones((current) => ({ ...current, startBody: analysisBodyZone }));
    }

    setAutoAnalysisStatus("Start and lane identified. Detecting the first visible movement…");
    const automaticMovementAccepted = await detectAndMaybeAcceptFirstMovement(
      video,
      acceptedStart,
      notePrefix,
      signal,
      analysisBodyZone,
      preflightMovement,
      automaticFinish?.rawTime,
    );

    const officialDuration = Number(officialTotalTime);
    const poseFinishBoundary = resolveAutomaticPoseFinishBoundary({
      startRawTime: acceptedStart,
      videoDuration: video.duration,
      lightFinishRawTime: automaticFinish?.rawTime,
      lightFinishAccepted: automaticFinish?.accepted,
      officialTotalSeconds: officialDuration,
    });
    if (!poseFinishBoundary.ready || poseFinishBoundary.endRawTime === undefined) {
      setAutoAnalysisStatus(
        `Start and movement were analyzed, but COM was paused. ${poseFinishBoundary.reason} Review or set Finish Pad, then analyze center of mass.`,
      );
      return;
    }
    const boundaryStatusNote = poseFinishBoundary.source === "official-time"
      ? ` Official time bounded analysis at ${poseFinishBoundary.endRawTime.toFixed(3)}s raw; Finish remains unaccepted until it is reviewed.`
      : "";

    let analysisWallCalibration = biomechanics.calibration;
    const savedCalibrationValidation = validateWallCalibration(analysisWallCalibration);
    if (!savedCalibrationValidation.valid || analysisWallCalibration?.source === "automatic-approximate") {
      setAutoAnalysisStatus("Timing finished. Checking that the camera stayed fixed…");
      await seekTo(video, Math.min(video.duration - 0.001, Math.max(0, acceptedStart + 0.05)));
      if (signal?.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      const calibrationFrameTime = video.currentTime;
      const calibrationFrame = captureVideoPixels(video).imageData;
      await seekTo(video, Math.min(video.duration - 0.001, Math.max(0, poseFinishBoundary.endRawTime - 0.08)));
      if (signal?.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      const cameraStability = assessCameraStability(calibrationFrame, captureVideoPixels(video).imageData);
      if (cameraStability.assessable && !cameraStability.stable) {
        setBiomechanics((current) => current.calibration?.source === "automatic-approximate"
          ? { ...current, calibration: undefined, result: undefined }
          : current);
        setRouteAlignment(null);
        setAutoAnalysisStatus(
          `Timing finished${automaticMovementAccepted ? ", first movement was accepted" : "; first movement needs review"}, but center-of-mass and route splits were paused because the camera moved.${boundaryStatusNote} ${cameraStability.reason} Use a fixed-camera recording for trustworthy wall positions and Hold 10 timing.`,
        );
        return;
      }
      setAutoAnalysisStatus("Camera looks stable. Estimating the selected 3 m wall lane for center of mass…");
      const automaticCalibration = inferAutomaticWallCalibration({
        imageData: calibrationFrame,
        frameRawTime: calibrationFrameTime,
        identityZone: analysisBodyZone,
        laneLightZone: automaticFinish?.zone ?? context.analysisLightZone,
      });
      if (automaticCalibration.calibration) {
        analysisWallCalibration = automaticCalibration.calibration;
        setBiomechanics((current) => ({
          ...current,
          calibration: automaticCalibration.calibration,
          result: undefined,
        }));
      } else if (!savedCalibrationValidation.valid || analysisWallCalibration?.source === "automatic-approximate") {
        setBiomechanics((current) => current.calibration?.source === "automatic-approximate"
          ? { ...current, calibration: undefined, result: undefined }
          : current);
        setRouteAlignment(null);
        setAutoAnalysisStatus(
          `Timing finished${automaticMovementAccepted ? ", first movement was accepted" : "; first movement needs review"}${automaticFinish && !automaticFinish.accepted ? `; finish is bounded at ${automaticFinish.rawTime.toFixed(3)}s and still needs frame review` : ""}, but center of mass needs a full-wall view.${boundaryStatusNote} ${automaticCalibration.reason} You can mark four lane corners below as a fallback.`,
        );
        return;
      }
    }
    if (!analysisWallCalibration || !validateWallCalibration(analysisWallCalibration).valid) {
      setAutoAnalysisStatus("Timing finished, but no stable wall calibration was available for center-of-mass analysis.");
      return;
    }

    const poseEnd = poseFinishBoundary.endRawTime;
    if (poseEnd <= acceptedStart + 0.2) {
      throw new Error("The automatic pose range is too short. Check the accepted start and finish markers.");
    }

    setAutoAnalysisStatus("Timing finished. Registering the 20 visible route holds...");
    const locatedRoute = await locateVisibleRouteHolds(
      acceptedStart,
      poseEnd,
      analysisWallCalibration,
      signal,
      analysisBodyZone,
    );
    const routeSummary = locatedRoute.aligned
      ? ` ${locatedRoute.diagnostics.matchedHoldIds.length}/20 visible holds were registered to the video.`
      : ` Hold markers were hidden because visual registration was not trustworthy: ${locatedRoute.reason}`;

    const maxSafeFps = (poseEnd - acceptedStart) * biomechanics.settings.sampleFps > 450
      ? 5
      : biomechanics.settings.sampleFps;
    const automaticSettings = {
      ...biomechanics.settings,
      sampleFps: maxSafeFps,
      // Distant top-wall joints are often real but receive lower MediaPipe
      // visibility. These remain conservative enough to require the torso and
      // three quarters of modeled body mass.
      // Upper-wall athletes can occupy only a few dozen source pixels. Keep a
      // conservative torso/70%-mass floor while allowing lower-confidence
      // distant joints to maintain the climb path.
      minVisibility: Math.min(biomechanics.settings.minVisibility, 0.2),
      minMassCoverage: Math.min(biomechanics.settings.minMassCoverage, 0.7),
    };
    setBiomechanicsRunning(true);
    setAutoAnalysisStatus("Timing finished. Following the climber and calculating center of mass…");
    try {
      const poseResult = await analyzePoseVideo({
        video,
        startRawTime: acceptedStart,
        endRawTime: poseEnd,
        settings: automaticSettings,
        calibration: analysisWallCalibration,
        identityZone: analysisBodyZone,
        signal,
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
      await calculateHold10SecondPass(video, poseResult, analysisWallCalibration,
        resolveHold10Target({ manualZone: zones.hold10, calibration: analysisWallCalibration, visualAlignment: locatedRoute }),
        signal, setAutoAnalysisStatus);
      const selectedFrames = poseResult.metrics.selectedFrames ?? poseResult.metrics.detectedFrames;
      if (poseResult.metrics.validFrames > 0) {
        const finishReviewNote = automaticFinish && !automaticFinish.accepted
          ? ` Finish was bounded at ${automaticFinish.rawTime.toFixed(3)}s from verified light evidence and still needs frame review before it becomes an accepted time.`
          : "";
        setAutoAnalysisStatus(
          `Quick Analyze finished: ${poseResult.metrics.validFrames}/${poseResult.metrics.requestedFrames} usable COM frames${automaticMovementAccepted ? ", with start and first movement accepted." : "; first movement still needs review."}${routeSummary}${finishReviewNote}${boundaryStatusNote}`,
        );
      } else if (poseResult.metrics.detectedFrames === 0) {
        setAutoAnalysisStatus("Timing finished, but the pose scan still found no athlete. Recheck the wall corners and make the Start Body Zone surround the climber at the start.");
      } else {
        setAutoAnalysisStatus(`The athlete was tracked on ${selectedFrames} frames, but no frame had enough visible hips, knees, and shoulders for a reliable COM estimate.`);
      }
    } finally {
      setBiomechanicsRunning(false);
    }
  }

  function handleVideoLoadError() {
    const errorCode = videoRef.current?.error?.code;
    const reason = errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? "This browser cannot decode the selected video format. Try an H.264 MP4 or choose another clip."
      : "The selected video could not be opened. Try choosing the file again.";
    setVideoLoadError(reason);
    setSessionStatus(reason);
  }

  async function detectAndMaybeAcceptFinish(
    video: HTMLVideoElement,
    acceptedStart: number,
    lightZone: NormalizedZone | undefined,
    lightCalibration: StartLightCalibration | undefined,
    notePrefix: string,
    signal?: AbortSignal,
    onStatus?: (message: string) => void,
    laneCandidates: AnalysisLaneCandidate[] = [],
  ): Promise<AutomaticFinishOutcome | null> {
    const officialDuration = Number(officialTotalTime);
    const expectedFinishTime = resolveOfficialFinishRawTime({
      startRawTime: acceptedStart,
      videoDuration: video.duration,
      officialTotalSeconds: officialDuration,
    });
    const primaryCandidate: AnalysisLaneCandidate[] = lightZone
      ? [{
          zone: lightZone,
          calibration: lightCalibration ?? {},
          label: "selected lane light",
          startRawTime: acceptedStart,
          score: Number.MAX_SAFE_INTEGER,
        }]
      : [];
    const candidates = deduplicateAnalysisLaneCandidates([...primaryCandidate, ...laneCandidates]).slice(0, 3);
    if (!candidates.length) {
      const missing = await detectFinishSignal({
        video,
        zone: undefined,
        startSignalRawTime: acceptedStart,
        calibration: {},
        expectedFinishTime,
        signal,
      });
      setFinishResult(missing);
      setFinishStatus(missing.reason);
      return null;
    }

    let bestReview: { result: StartSignalDetectionResult; candidate: AnalysisLaneCandidate; rank: number } | null = null;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (candidateIndex > 0) {
        onStatus?.(`The first start-verified lane had no accepted finish. Checking lane ${candidateIndex + 1} of ${candidates.length}…`);
      }
      const result = await detectFinishSignal({
        video,
        zone: candidate.zone,
        startSignalRawTime: acceptedStart,
        calibration: candidate.calibration,
        expectedFinishTime,
        signal,
        onProgress: (phase, processed, total) => {
          onStatus?.(
            `${phase === "coarse" ? "Scanning" : "Refining"} finish lane ${candidateIndex + 1}/${candidates.length}: ${processed}/${total} frames…`,
          );
        },
      });
      if (signal?.aborted) {
        throw new PoseAnalysisCancelledError();
      }
      const agreesWithOfficial = expectedFinishTime === undefined ||
        (result.rawTime !== undefined && Math.abs(result.rawTime - expectedFinishTime) <= 0.45);
      const confidenceRank = result.confidence === "High" ? 3 : result.confidence === "Medium" ? 2 :
        result.confidence === "Low" ? 1 : 0;
      const reviewRank = (result.detected ? 10 : 0) + confidenceRank + (agreesWithOfficial ? 4 : 0) -
        (expectedFinishTime !== undefined && result.rawTime !== undefined
          ? Math.min(3, Math.abs(result.rawTime - expectedFinishTime))
          : 0);
      if (!bestReview || reviewRank > bestReview.rank) {
        bestReview = { result, candidate, rank: reviewRank };
      }

      if (result.detected && result.rawTime !== undefined && result.confidence === "High" && agreesWithOfficial) {
        setFinishResult(result);
        setZones((current) => ({ ...current, startLight: candidate.zone }));
        setStartLightCalibration(candidate.calibration);
        setStartDetectionProfile("calibrated");
        automaticLaneCandidatesRef.current = [
          candidate,
          ...candidates.filter((item) => item !== candidate),
        ];
        acceptTimestamp("finishPad", result.rawTime, "Finish light detection", result.confidence, {
          detectedRawTime: result.rawTime,
          note: `${notePrefix} ${result.reason}`,
        });
        const fallbackNote = candidateIndex > 0
          ? ` The initially selected lane had no valid finish, so ClimbIQ matched the other start-verified lane.`
          : "";
        setFinishStatus(
          `Finish accepted automatically at ${result.rawTime.toFixed(3)}s from the first verified return-color flash.${fallbackNote} ${result.reason}`,
        );
        return {
          rawTime: result.rawTime,
          zone: candidate.zone,
          calibration: candidate.calibration,
          confidence: result.confidence,
          accepted: true,
        };
      }
    }

    const review = bestReview!;

    // Angled phone recordings make the lower start sensor tiny and unreliable
    // after the athlete climbs away from it. When no lower-lane reversal is
    // strong enough to accept, independently search the broad upper band of
    // that same lane for the finish timing indicator. The upper search discovers
    // its own fixed patch, so perspective does not require the top and bottom
    // lights to share one x coordinate.
    // Keep this fallback anchored to the preferred start lane. A weak lower
    // review candidate in another lane is not strong enough evidence to switch
    // athlete identity before searching the angled upper wall.
    const upperLaneCandidate = candidates[0];
    onStatus?.("The lower lane light did not verify a finish. Searching the angled upper timing indicators…");
    const { detectTopFinishSignal } = await import("./lib/detectTopFinishSignal");
    const upperFinish = await detectTopFinishSignal({
      video,
      startSignalRawTime: acceptedStart,
      laneHintZone: upperLaneCandidate.zone,
      expectedFinishTime,
      signal,
      onProgress: (phase, processed, total) => {
        onStatus?.(
          `${phase === "coarse" ? "Scanning upper timing indicators" : "Refining upper finish"}: ${processed}/${total} frames…`,
        );
      },
    });
    if (signal?.aborted) {
      throw new PoseAnalysisCancelledError();
    }
    const upperAgreesWithOfficial = expectedFinishTime === undefined ||
      (upperFinish.result.rawTime !== undefined && Math.abs(upperFinish.result.rawTime - expectedFinishTime) <= 0.45);
    if (upperFinish.result.detected && upperFinish.result.rawTime !== undefined && upperFinish.zone) {
      setFinishResult(upperFinish.result);
      setZones((current) => ({ ...current, finishLight: upperFinish.zone }));
      automaticLaneCandidatesRef.current = [
        upperLaneCandidate,
        ...candidates.filter((item) => item !== upperLaneCandidate),
      ];
      if (upperFinish.result.confidence === "High" && upperAgreesWithOfficial) {
        acceptTimestamp("finishPad", upperFinish.result.rawTime, "Finish light detection", upperFinish.result.confidence, {
          detectedRawTime: upperFinish.result.rawTime,
          note: `${notePrefix} ${upperFinish.result.reason}`,
        });
        setFinishStatus(
          `Finish accepted automatically at ${upperFinish.result.rawTime.toFixed(3)}s from the perspective-aware upper timing indicator. ${upperFinish.result.reason}`,
        );
        return {
          rawTime: upperFinish.result.rawTime,
          // Keep the lower start-verified lane for athlete identity and wall
          // calibration; the separately saved finishLight zone is only timing.
          zone: upperLaneCandidate.zone,
          calibration: upperLaneCandidate.calibration,
          confidence: upperFinish.result.confidence,
          accepted: true,
        };
      }
      const reviewEvidenceLabel = upperFinish.result.debug.finishEvidenceKind === "physical-top-reach" ||
        upperFinish.result.debug.finishEvidenceKind === "upper-wall-presence" ? "Upper-wall motion" : "Upper timing indicator";
      setFinishStatus(
        upperAgreesWithOfficial
          ? `${reviewEvidenceLabel} suggests ${upperFinish.result.rawTime.toFixed(3)}s and needs frame review. ${upperFinish.result.reason}`
          : `${reviewEvidenceLabel} suggests ${upperFinish.result.rawTime.toFixed(3)}s, but the official-time cross-check suggests ${expectedFinishTime!.toFixed(3)}s. Review before accepting.`,
      );
      return {
        rawTime: upperFinish.result.rawTime,
        zone: upperLaneCandidate.zone,
        calibration: upperLaneCandidate.calibration,
        confidence: upperFinish.result.confidence,
        accepted: false,
      };
    }

    if (!review.result.detected && upperFinish.result.candidates?.length) {
      setFinishResult(upperFinish.result);
      setFinishStatus(upperFinish.result.reason);
      return null;
    }
    setFinishResult(review.result);
    setFinishStatus(review.result.reason);
    if (
      review.result.detected && review.result.rawTime !== undefined && expectedFinishTime !== undefined &&
      Math.abs(review.result.rawTime - expectedFinishTime) > 0.45
    ) {
      setFinishStatus(
        `Finish light suggests ${review.result.rawTime.toFixed(3)}s, but the official-time cross-check suggests ${expectedFinishTime.toFixed(3)}s. Review before accepting.`,
      );
    }
    if (review.result.detected && review.result.rawTime !== undefined) {
      automaticLaneCandidatesRef.current = [
        review.candidate,
        ...candidates.filter((item) => item !== review.candidate),
      ];
      return {
        rawTime: review.result.rawTime,
        zone: review.candidate.zone,
        calibration: review.candidate.calibration,
        confidence: review.result.confidence,
        accepted: false,
      };
    }
    return null;
  }

  async function acceptSuggestedStart(reviewedRawTime?: number, frameTimeNote?: string) {
    const video = videoRef.current;
    if (suggestedStartRawTime === null) {
      return;
    }
    const source = startResult ? startSourceForResult(startResult) : "Fused start detection";
    const confidence: Confidence = startResult && startResult.confidence !== "None" ? startResult.confidence : "Medium";
    const acceptedStart = reviewedRawTime === undefined
      ? Math.max(0, roundTime(suggestedStartRawTime + startSignalOffset))
      : Math.max(0, roundTime(reviewedRawTime));
    const pendingContext = pendingAutomaticContextRef.current ?? {
      analysisBodyZone: zones.startBody,
      analysisLightZone: zones.startLight,
      analysisLightCalibration: calibrationReady ? startLightCalibration : undefined,
      analysisLaneCandidates: automaticLaneCandidatesRef.current,
    };
    acceptTimestamp("startSignal", acceptedStart, source, confidence, {
      detectedRawTime: suggestedStartRawTime,
      offsetApplied: roundTime(acceptedStart - suggestedStartRawTime),
      note: `Suggested by Quick Analyze and accepted after review. ${frameTimeNote ?? ""}`,
      frameReviewed: reviewedRawTime !== undefined,
    });
    setSuggestedStartRawTime(null);
    if (!video) {
      setAutoAnalysisStatus(`Start accepted at ${acceptedStart.toFixed(3)}s.`);
      return;
    }
    const abortController = new AbortController();
    autoAnalysisAbortRef.current = abortController;
    setAutoAnalysisRunning(true);
    setAutoAnalysisStatus(`Start accepted at ${acceptedStart.toFixed(3)}s. Continuing lane-specific analysis…`);
    try {
      await runWithVideoRestore(
        video,
        () => continueAutomaticAnalysisAfterStart(
          video,
          acceptedStart,
          pendingContext,
          "Automatically detected after the reviewed start was accepted.",
          abortController.signal,
        ),
        "Reviewed-start analysis finished. Video restored to its previous position.",
        "reviewed-start analysis",
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        setAutoAnalysisStatus("Reviewed-start analysis cancelled. Accepted timing results were kept.");
      } else {
        setAutoAnalysisStatus(error instanceof Error ? `Reviewed-start analysis stopped: ${error.message}` : "Reviewed-start analysis stopped.");
      }
    } finally {
      pendingAutomaticContextRef.current = null;
      autoAnalysisAbortRef.current = null;
      setAutoAnalysisRunning(false);
      setBiomechanicsRunning(false);
    }
  }

  function acceptTimestamp(
    id: TimestampMarker["id"],
    rawTime: number,
    source: TimestampSource,
    confidence: Confidence,
    acceptanceMetadata?: { detectedRawTime?: number; offsetApplied?: number; note?: string; frameReviewed?: boolean },
  ) {
    if (id === "startSignal") {
      pendingAutomaticContextRef.current = null;
      clearFinishDependents(false);
      setSuggestedStartRawTime(null);
      setMovementResult(null);
      setRouteAlignment(null);
      setBiomechanics((current) => current.result ? { ...current, result: undefined } : current);
    }
    setTimestamps((current) => {
      const result = applyTimestampAcceptance(current, {
        id,
        rawTime,
        source,
        confidence,
        durationSeconds: metadata?.duration,
        detectedRawTime: acceptanceMetadata?.detectedRawTime,
        offsetApplied: acceptanceMetadata?.offsetApplied,
        note: acceptanceMetadata?.note,
        acceptanceMode: acceptanceMetadata?.frameReviewed ? "frame-review" : source === "Manual" || source === "Official total time" ? "manual-entry" : "automatic",
      });
      return result.timestamps;
    });
  }

  function acceptManualTimestamp(
    id: TimestampMarker["id"],
    rawTime: number,
    acceptanceMetadata?: { detectedRawTime?: number; offsetApplied?: number; note?: string; frameReviewed?: boolean },
  ) {
    const validation = applyTimestampAcceptance(timestamps, {
      id,
      rawTime,
      source: "Manual",
      confidence: "Medium",
      durationSeconds: metadata?.duration,
      detectedRawTime: acceptanceMetadata?.detectedRawTime,
      offsetApplied: acceptanceMetadata?.offsetApplied,
      note: acceptanceMetadata?.note,
    });
    if (!validation.accepted) {
      setTimestampStatus(validation.reason ?? "That timestamp could not be accepted.");
      return false;
    }
    setTimestampStatus("");
    acceptTimestamp(id, rawTime, "Manual", "Medium", acceptanceMetadata);
    return true;
  }

  function clearFinishDependents(clearMarker = true) {
    setFinishResult(null);
    setFinishStatus("");
    if (clearMarker) {
      clearTimestamp("finishPad");
    }
  }

  function invalidateStartDetectorSuggestion(message: string) {
    pendingAutomaticContextRef.current = null;
    automaticLaneCandidatesRef.current = [];
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setMovementPreviewFrames({});
    setStartEvidenceStatus("");
    const acceptedStart = getTimestamp(timestamps, "startSignal");
    const detectorDerived = DETECTOR_DERIVED_START_SOURCES.has(acceptedStart.source);
    if (detectorDerived) {
      setTimestamps((current) => clearMarkerTimestamp(current, "startSignal"));
      setFinishResult(null);
      setFinishStatus("");
      setRouteAlignment(null);
      setBiomechanics((current) => current.result ? { ...current, result: undefined } : current);
    }
    setAutoAnalysisStatus(`${message}${detectorDerived ? " Previous detector-derived Start and dependent timing were cleared." : ""}`);
  }

  function invalidateMovementSuggestion(message: string) {
    setMovementResult(null);
    setMovementPreviewFrames({});
    const hasDetectorMarker = MOVEMENT_MARKER_IDS.some((id) => getTimestamp(timestamps, id).source === "Body motion detection");
    if (hasDetectorMarker) {
      setTimestamps((current) => MOVEMENT_MARKER_IDS.reduce(
        (next, id) => getTimestamp(next, id).source === "Body motion detection"
          ? clearMarkerTimestamp(next, id)
          : next,
        current,
      ));
    }
    setAutoAnalysisStatus(`${message}${hasDetectorMarker ? " Previous detector-derived movement timing was cleared." : ""}`);
  }

  function handleStartSignalOffsetChange(value: number) {
    setStartSignalOffset(value);
    const acceptedStart = getTimestamp(timestamps, "startSignal");
    if (DETECTOR_DERIVED_START_SOURCES.has(acceptedStart.source)) {
      invalidateStartDetectorSuggestion("Start correction changed. Run the analysis again before accepting the corrected time.");
    }
  }

  function handleFirstMovementOffsetChange(value: number) {
    setFirstMovementOffset(value);
    const hasDetectorMarker = MOVEMENT_MARKER_IDS.some((id) => getTimestamp(timestamps, id).source === "Body motion detection");
    if (hasDetectorMarker) {
      setTimestamps((current) => MOVEMENT_MARKER_IDS.reduce(
        (next, id) => getTimestamp(next, id).source === "Body motion detection"
          ? clearMarkerTimestamp(next, id)
          : next,
        current,
      ));
      setAutoAnalysisStatus("Movement correction changed. Previous detector-derived movement timing was cleared; review the corrected suggestion again.");
    }
  }

  function invalidateStartLightDependents(message: string) {
    pendingAutomaticContextRef.current = null;
    automaticLaneCandidatesRef.current = [];
    setStartLightCalibration({});
    setCalibrationStatus(message);
    const acceptedStart = getTimestamp(timestamps, "startSignal");
    const lightDerivedStart = acceptedStart.source === "Start light detection" || acceptedStart.source === "Fused start detection";
    if (lightDerivedStart) {
      clearTimestamp("startSignal");
      setAutoAnalysisStatus("The accepted Start used the changed light evidence, so Start and all dependent timing were cleared.");
    } else {
      invalidateStartDetectorSuggestion("Start-light evidence changed. Run the analysis again to generate a matching suggestion.");
      clearFinishDependents();
    }
  }

  function clearTimestamp(id: TimestampMarker["id"]) {
    if (id === "startSignal") {
      pendingAutomaticContextRef.current = null;
      automaticLaneCandidatesRef.current = [];
      setStartResult(null);
      setSuggestedStartRawTime(null);
      setMovementResult(null);
      setFinishResult(null);
      setFinishStatus("");
      setRouteAlignment(null);
      setBiomechanics((current) => current.result ? { ...current, result: undefined } : current);
    } else if (id === "finishPad") {
      setFinishResult(null);
      setFinishStatus("");
      setRouteAlignment(null);
      setBiomechanics((current) => current.result ? { ...current, result: undefined } : current);
    }
    setTimestamps((current) => clearMarkerTimestamp(current, id));
  }

  function handleOfficialTotalTimeChange(value: string) {
    const officialFinishWasAccepted = getTimestamp(timestamps, "finishPad").source === "Official total time";
    if (officialFinishWasAccepted) {
      // The marker was calculated from the previous field value, so retaining
      // it would silently display an obsolete total and stale pose range.
      clearTimestamp("finishPad");
    }
    setOfficialTotalTime(value);
    setFinishResult(null);
    setFinishStatus(officialFinishWasAccepted
      ? "The previous official-time Finish Pad was cleared. Review and accept the updated suggestion."
      : "Official-time cross-check changed. Rerun automatic finish detection if you want it compared.");
  }

  function handleStartSearchWindowChange(boundary: "start" | "end", value: number) {
    if (boundary === "start") {
      setStartSearchStart(value);
    } else {
      setStartSearchEnd(value);
    }
    invalidateStartDetectorSuggestion("Start search window changed. Run the analysis again to generate a matching suggestion.");
  }

  function setTimestampFromInput(id: TimestampMarker["id"], value: string, mode: "raw" | "climb") {
    const parsed = parseOptionalNumber(value);
    if (parsed === null) {
      if (value.trim()) {
        setTimestampStatus("Enter a valid number for the timestamp.");
      }
      return;
    }

    const startRaw = getTimestamp(timestamps, "startSignal").rawTime ?? startResult?.rawTime;
    const rawTime = mode === "climb" && startRaw !== null && startRaw !== undefined ? startRaw + parsed : parsed;
    return acceptManualTimestamp(id, rawTime);
  }

  function buildDebugReport(): DetectionDebugReport {
    return {
      videoMetadata: metadata,
      zones,
      frameSamplingTest: frameDebug,
      startSignalDetection: startResult?.debug ?? null,
      firstMovementDetection: movementResult?.debug ?? null,
      finishSignalDetection: finishResult?.debug ?? null,
      acceptedTimestamps: timestamps,
    };
  }

  async function copyDebugReport() {
    const report = JSON.stringify(buildDebugReport(), null, 2);
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Copied");
      window.setTimeout(() => setCopyStatus(""), 1800);
    } catch {
      setCopyStatus("Copy failed. Use the JSON download instead.");
    }
  }

  function buildDetectionWarnings() {
    const warnings: string[] = [];
    if (startResult?.debug.failureReason) {
      warnings.push(startResult.debug.failureReason);
    }
    if (movementResult?.debug.failureReason) {
      warnings.push(movementResult.debug.failureReason);
    }
    if (finishResult?.debug.failureReason) {
      warnings.push(finishResult.debug.failureReason);
    }
    if (movementResult?.debug.movementAlreadyUnderway) {
      warnings.push("Movement appears to already be underway near Start Signal.");
    }
    if (movementResult?.debug.suspiciousFirstFrameDetection) {
      warnings.push("First Movement candidate occurred at the first sampled frame.");
    }
    if (startResult?.debug.sceneContinuity?.assessable && !startResult.debug.sceneContinuity.continuous) {
      warnings.push(startResult.debug.sceneContinuity.reason);
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
      ...timestampAcceptanceAudit(item),
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
        finishPad: exportCandidates(finishResult?.candidates ?? [], getTimestamp(timestamps, "finishPad")),
      },
      splitCalculations: splits,
      sourceFrameTimingAudit: effectiveBiomechanicsResult ? summarizeSourceSampleTiming(effectiveBiomechanicsResult.frames) : null,
      hold10PhaseAnalysis: {
        available: hold10PhaseSplits.available,
        startToHold10Seconds: hold10PhaseSplits.startToHold10Seconds ?? null,
        hold10ToFinishSeconds: hold10PhaseSplits.hold10ToFinishSeconds ?? null,
        bottomPhaseShare: hold10PhaseSplits.hold10Share ?? null,
        topPhaseShare: hold10PhaseSplits.hold10Share === undefined ? null : roundTime(1 - hold10PhaseSplits.hold10Share),
        slowerPhase: hold10PhaseSplits.slowerPhase ?? null,
        phaseDifferenceSeconds: hold10PhaseSplits.phaseDifferenceSeconds ?? null,
        confidence: hold10PhaseSplits.confidence,
        reason: hold10PhaseSplits.reason,
      },
      hold10SecondPassEvidence: activeHold10SecondPass?.evidence ?? null,
      detectionWarnings: buildDetectionWarnings(),
      automationAudit: {
        startEvidence: startEvidenceStatus || null,
        automaticAnalysis: autoAnalysisStatus || null,
        finishAnalysis: finishStatus || null,
      },
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
    const startToHold10 = splits["Start to Hold 10"];
    const hold10ToFinish = splits["Hold 10 to Finish"];
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
      `start_to_hold_10: ${yamlNumber(startToHold10)}\n` +
      `hold_10_to_finish: ${yamlNumber(hold10ToFinish)}\n` +
      `bottom_phase_share: ${yamlNumber(hold10PhaseSplits.hold10Share)}\n` +
      `top_phase_share: ${yamlNumber(hold10PhaseSplits.hold10Share === undefined ? null : roundTime(1 - hold10PhaseSplits.hold10Share))}\n` +
      `slower_phase: ${yamlString(hold10PhaseSplits.slowerPhase ?? "Not set")}\n` +
      `phase_difference: ${yamlNumber(hold10PhaseSplits.phaseDifferenceSeconds)}\n` +
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
      `- Start → Hold 10: ${formatExportTime(startToHold10)}\n` +
      `- Hold 10 → Finish: ${formatExportTime(hold10ToFinish)}\n` +
      `- Phase balance: ${hold10PhaseSplits.available
        ? `${(hold10PhaseSplits.hold10Share! * 100).toFixed(1)}% before / ${((1 - hold10PhaseSplits.hold10Share!) * 100).toFixed(1)}% after Hold 10; ${hold10PhaseSplits.slowerPhase === "balanced" ? "balanced" : `${hold10PhaseSplits.slowerPhase === "start-to-hold10" ? "bottom" : "top"} phase ${hold10PhaseSplits.phaseDifferenceSeconds!.toFixed(3)}s longer`}`
        : "Not set"}\n` +
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
      markdownSplitRow("Start to Hold 10", splits) +
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
    try {
      await navigator.clipboard.writeText(buildObsidianMarkdown());
      setExportStatus("Obsidian note copied.");
    } catch {
      setExportStatus("Clipboard access was blocked. Use Download report instead.");
    }
  }

  function downloadMarkdown() {
    const name = `${slugify(sessionName || "climbiq-attempt")}.md`;
    downloadTextFile(name, buildObsidianMarkdown(), "text/markdown");
    setExportStatus(`Downloaded ${name}.`);
  }

  async function copyDatasetJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildDatasetExport(), null, 2));
      setExportStatus("Dataset JSON copied.");
    } catch {
      setExportStatus("Clipboard access was blocked. Use Download data instead.");
    }
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
    const storageError = writeSavedSessions(next);
    if (storageError) {
      setSessionStatus(storageError);
      return;
    }
    setSavedSessions(next);
    setActiveSessionId(session.id);
    setSessionName(session.name);
    setSessionStatus(`Saved "${session.name}" locally.`);
  }

  function applySession(session: SavedAnalysisSession) {
    if (videoAnalysisRunning) {
      setSessionStatus("Wait for the active video analysis to finish before loading another session.");
      return;
    }
    // Review callbacks capture the marker/session that opened them. Closing
    // the review prevents a frame accepted for one climb from mutating the
    // session that is about to be loaded or duplicated.
    closeTimestampReview();
    const safeVideoMetadata = sanitizeVideoMetadata(session.videoMetadata);
    const currentVideoMatches = Boolean(
      videoUrl && metadata?.metadataLoaded && safeVideoMetadata && videoMetadataMatches(metadata, safeVideoMetadata),
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
    setZones(sanitizeZoneMap(session.zones));
    setStartLightCalibration(sanitizeStartLightCalibration(
      session.startLightCalibration,
      safeVideoMetadata?.duration,
    ));
    const safeSettings = sanitizeAnalysisSessionSettings(session.settings);
    setStartSearchStart(safeSettings.startSearchStart);
    setStartSearchEnd(safeSettings.startSearchEnd);
    setStartSensitivity(safeSettings.startSensitivity);
    setStartLightVisibility(safeSettings.startLightVisibility);
    setStartDetectionProfile(safeSettings.startDetectionProfile);
    setReactionTimeOffset(safeSettings.reactionTimeOffset);
    setStartSignalOffset(safeSettings.startSignalOffset);
    setMovementSensitivity(safeSettings.movementSensitivity);
    setFirstMovementDefinition(safeSettings.firstMovementDefinition);
    setCommittedLaunchMinDelay(safeSettings.committedLaunchMinDelay);
    setFirstMovementOffset(safeSettings.firstMovementOffset);
    setOfficialTotalTime(safeSettings.officialTotalTime);
    setTimestamps(sanitizeTimestampSequence(
      mergeTimestampDefaults(session.timestamps ?? []),
      safeVideoMetadata?.duration,
    ));
    setBiomechanics(sanitizeBiomechanicsSession(session.biomechanics));
    setRouteAlignment(null);
    pendingAutomaticContextRef.current = null;
    setStartResult(null);
    setSuggestedStartRawTime(null);
    setMovementResult(null);
    setFinishResult(null);
    setFinishStatus("");
    setFrameDebug(null);
    if (!currentVideoMatches) {
      setMetadata(safeVideoMetadata);
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
    const storageError = writeSavedSessions(next);
    if (storageError) {
      setSessionStatus(storageError);
      return;
    }
    setSavedSessions(next);
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
    const storageError = writeSavedSessions(next);
    if (storageError) {
      setSessionStatus(storageError);
      return;
    }
    setSavedSessions(next);
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
    const storageError = writeSavedSessions(next);
    if (storageError) {
      setSessionStatus(storageError);
      return;
    }
    setSavedSessions(next);
    applySession(duplicate);
    setSessionStatus(`Duplicated "${source.name}".`);
  }

  function exportCurrentSession() {
    const session = buildSessionSnapshot();
    downloadTextFile(
      `${slugify(session.name)}.climbiq-session.json`,
      JSON.stringify(session, null, 2),
      "application/json",
    );
    setSessionStatus(`Exported "${session.name}" as JSON.`);
  }

  function exportSessionLibrary() {
    if (savedSessions.length === 0) {
      setLibraryStatus("Save at least one analysis before exporting a library backup.");
      return;
    }

    const backup = createSessionLibraryBackup(savedSessions);
    downloadTextFile(
      `climbiq-library-${todayDateString()}.json`,
      JSON.stringify(backup, null, 2),
      "application/json",
    );
    setLibraryStatus(`Exported ${savedSessions.length} saved ${savedSessions.length === 1 ? "attempt" : "attempts"}.`);
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
      if (isSessionLibraryBackup(parsed)) {
        const importedSessions = parsed.sessions
          .filter(isSavedAnalysisSession)
          .map(sanitizeSavedSession);
        if (importedSessions.length === 0) {
          throw new Error("This ClimbIQ library backup does not contain any valid saved attempts.");
        }

        const merged = mergeSessionLibraries(savedSessions, importedSessions);
        const storageError = writeSavedSessions(merged.sessions);
        if (storageError) throw new Error(storageError);
        setSavedSessions(merged.sessions);
        const activeImportedCopy = activeSessionId
          ? importedSessions.find((session) => session.id === activeSessionId)
          : undefined;
        const activeCopyWasUpdated = Boolean(
          activeImportedCopy && merged.sessions.find((session) => session.id === activeSessionId) === activeImportedCopy,
        );
        if (activeCopyWasUpdated) {
          // Keep an analysis already open on screen intact. Detaching it means a
          // later Save creates a separate copy instead of silently overwriting
          // the newer session that just arrived from another computer.
          setActiveSessionId(null);
        }
        const summary = [
          `${merged.addedCount} added`,
          `${merged.updatedCount} updated`,
          `${merged.unchangedCount} already current`,
        ].join(", ");
        setLibraryStatus(`Library imported: ${summary}. Your local-only attempts were preserved.${activeCopyWasUpdated ? " The analysis already open on screen was left unchanged; load the imported copy when you are ready." : ""}`);
        setExportStatus(`Library imported: ${summary}.`);
        return;
      }

      const parsedSession = isDatasetExport(parsed) ? datasetToSavedSession(parsed) : parsed;
      if (!isSavedAnalysisSession(parsedSession)) {
        throw new Error("This file is not a ClimbIQ analysis session.");
      }

      const session = sanitizeSavedSession({
        ...parsedSession,
        id: parsedSession.id || createSessionId(),
        updatedAt: new Date().toISOString(),
      });
      const next = [session, ...savedSessions.filter((item) => item.id !== session.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      const storageError = writeSavedSessions(next);
      if (storageError) throw new Error(storageError);
      setSavedSessions(next);
      applySession(session);
      setSessionStatus(`Session imported. Reload the matching local video file if you want to review frames.`);
      setLibraryStatus(`Imported "${session.name}" and opened its saved results.`);
      setExportStatus(`Imported "${session.name}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Session import failed.";
      setSessionStatus(message);
      setLibraryStatus(message);
    } finally {
      event.target.value = "";
    }
  }

  const { hasSelectedVideo, hasLoadedVideo } = getVideoUiState(videoUrl, Boolean(metadata?.metadataLoaded));
  const acceptedMovementRawTime = getTimestamp(timestamps, "firstMovement").rawTime;
  const acceptedFinish = getTimestamp(timestamps, "finishPad");
  const acceptedStart = getTimestamp(timestamps, "startSignal");
  const acceptedHold10 = getTimestamp(timestamps, "hold10");
  const calculatedClimbTime =
    startSignalRaw !== null && acceptedFinish.rawTime !== null
      ? Math.max(0, acceptedFinish.rawTime - startSignalRaw)
      : null;
  const hold10PhaseSplits = calculateHold10PhaseSplits(
    acceptedStart.rawTime,
    acceptedHold10.rawTime,
    acceptedFinish.rawTime,
    acceptedHold10.confidence,
  );
  const acceptedReactionTime =
    startSignalRaw !== null && acceptedMovementRawTime !== null
      ? Math.max(0, acceptedMovementRawTime - startSignalRaw)
      : null;
  const completedWorkflowSteps = [
    hasLoadedVideo,
    startSignalRaw !== null,
    acceptedFinish.rawTime !== null,
    Boolean(effectiveBiomechanicsResult),
  ].filter(Boolean).length;
  const analysisStage = autoAnalysisRunning
    ? "Analyzing video"
    : effectiveBiomechanicsResult
      ? "Insights ready"
      : acceptedFinish.rawTime !== null
        ? "Timing ready"
        : startSignalRaw !== null
          ? "Start confirmed"
          : hasLoadedVideo
            ? "Ready to analyze"
            : "Waiting for a video";

  return (
    <main className="app-shell" id="top" data-app-version={APP_VERSION}>
      <a className="skip-link" href="#upload">Skip to analysis</a>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ClimbIQ home">
          <strong>ClimbIQ</strong>
        </a>
        <nav className="site-nav" aria-label="Primary navigation">
          <a href="#upload">Analyze</a>
          {hasSelectedVideo && <a href="#video-review">Review</a>}
          {hasSelectedVideo && <a href="#center-of-mass">Insights</a>}
          <span>Runs locally</span>
        </nav>
      </header>

      {!hasSelectedVideo && (
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-content">
            <p className="eyebrow">Speed climbing video analysis</p>
            <h1 id="hero-title">Analyze a speed-climbing run from video.</h1>
            <p className="hero-copy">
              Find the start, finish, first movement, center of mass, and route splits from one recording. No wearables or uploads required.
            </p>
            <div className="hero-actions">
              <a className="button-link primary hero-primary" href="#upload">Analyze a climb</a>
            </div>
          </div>
        </section>
      )}

      {hasSelectedVideo && (
        <nav className="workflow-nav" aria-label="Climb analysis workflow">
          <a className={hasLoadedVideo ? "complete" : ""} href="#upload"><span>{hasLoadedVideo ? "✓" : "1"}</span> Video</a>
          <a className={startSignalRaw !== null ? "complete" : ""} href="#review-tools"><span>{startSignalRaw !== null ? "✓" : "2"}</span> Review</a>
          <a className={acceptedFinish.rawTime !== null ? "complete" : ""} href="#results"><span>{acceptedFinish.rawTime !== null ? "✓" : "3"}</span> Results</a>
          <a className={effectiveBiomechanicsResult ? "complete" : ""} href="#center-of-mass"><span>{effectiveBiomechanicsResult ? "✓" : "4"}</span> Insights</a>
          <div className="workflow-progress" aria-label={`${completedWorkflowSteps} of 4 steps complete`}>
            <span style={{ width: `${completedWorkflowSteps * 25}%` }} />
          </div>
        </nav>
      )}

      <section className="layout-grid">
        <Card id="upload" title={hasSelectedVideo ? "Video" : "Upload a video"} className="full launch-card">
          <label
            className={`upload-dropzone${hasSelectedVideo ? " loaded" : ""}${videoDropActive ? " drag-active" : ""}`}
            onDragEnter={handleVideoDragEnter}
            onDragOver={handleVideoDragOver}
            onDragLeave={handleVideoDragLeave}
            onDrop={handleVideoDrop}
          >
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span className="upload-copy">
              <strong>{videoDropActive ? "Release to load this video" : hasSelectedVideo ? metadata?.fileName : "Drop in a speed-climbing video"}</strong>
              <small>{videoDropActive
                ? "One recording at a time"
                : hasSelectedVideo
                ? hasLoadedVideo ? "Ready to analyze · choose another video to replace it" : "Reading video details…"
                : "MOV, MP4, or any video your browser can play"}</small>
            </span>
            <span className="upload-action">{videoDropActive ? "Drop video" : hasSelectedVideo ? "Replace video" : "Choose video"}</span>
            <input aria-label={hasSelectedVideo ? "Replace video" : "Choose video"} type="file" accept="video/*" onChange={handleVideoUpload} disabled={videoAnalysisRunning} />
          </label>
          {!hasSelectedVideo && (
            <p className="muted recording-guidance">
              Best accuracy: use one unedited, fixed-camera attempt with the full selected lane, start lights, and finish area visible.
            </p>
          )}
          {metadata?.metadataLoaded && (
            <div className="video-meta-line" aria-label="Loaded video details">
              <span><i /> Ready</span>
              <span>{metadata.duration.toFixed(2)} seconds</span>
              <span>{metadata.videoWidth} × {metadata.videoHeight}</span>
              <span>Processed locally</span>
            </div>
          )}
          {videoLoadError && <p className="analysis-error upload-error" role="alert">{videoLoadError}</p>}
          <div className="quick-analysis-box">
            <div>
              <strong>{autoAnalysisRunning ? "Analyzing the run" : "Automatic analysis"}</strong>
              <p className="muted">
                Finds timing, first movement, the correct lane, athlete tracking, center of mass, and route splits.
              </p>
              {displayedStartSearchWindow && (
                <p className="muted">
                  Start search: {displayedStartSearchWindow.start.toFixed(1)}–{displayedStartSearchWindow.end.toFixed(1)}s video time. For a full meet, set one race window in Review &amp; advanced tools.
                </p>
              )}
            </div>
            <div className="button-row">
              <button
                className="primary analyze-button"
                onClick={runAutomaticAnalysis}
                disabled={!metadata?.metadataLoaded || videoAnalysisRunning}
              >
                {autoAnalysisRunning ? "Analyzing climb…" : hasLoadedVideo ? "Run full analysis" : hasSelectedVideo ? "Loading video…" : "Upload a video to begin"}
              </button>
              {autoAnalysisRunning && (
                <button onClick={() => autoAnalysisAbortRef.current?.abort()}>Cancel</button>
              )}
              {!autoAnalysisRunning && suggestedStartRawTime !== null && (
                <button
                  className="primary"
                  onClick={() => reviewTimestamp({
                    label: "Quick Analyze start",
                    suggestedRawTime: Math.max(0, roundTime(suggestedStartRawTime + startSignalOffset)),
                    confidence: startResult?.confidence ?? "Medium",
                    acceptLabel: "Accept start",
                    onAccept: (rawTime, frameTimeNote) => { void acceptSuggestedStart(rawTime, frameTimeNote); },
                  })}
                  disabled={videoAnalysisRunning}
                >
                  Review suggested start ({suggestedStartRawTime.toFixed(3)}s)
                </button>
              )}
            </div>
            {autoAnalysisStatus && <p className="status-message" aria-live="polite">{autoAnalysisStatus}</p>}
            {startEvidenceStatus && <p className="evidence-message">{startEvidenceStatus}</p>}
          </div>
        </Card>

        <Card title="Attempt comparison" className="full secondary-card comparison-card">
          <Suspense fallback={<p className="muted">Preparing saved attempt comparison…</p>}>
            <AttemptComparisonPanel sessions={savedSessions} />
          </Suspense>
          <div className="library-transfer">
            <div>
              <strong>Move saved attempts between computers</strong>
              <p className="muted">Export one library backup on your PC, then import it here. Newer copies update while attempts saved only on this Mac stay intact.</p>
            </div>
            <div className="button-row">
              <button onClick={exportSessionLibrary} disabled={savedSessions.length === 0 || videoAnalysisRunning}>
                Export saved library
              </button>
              <label className="file-button">
                Import session or library
                <input type="file" accept="application/json,.json" onChange={importSession} disabled={videoAnalysisRunning} />
              </label>
            </div>
            {libraryStatus && <p className="status-message" role="status">{libraryStatus}</p>}
          </div>
        </Card>

        {hasSelectedVideo && (
          <>
        <section className="run-summary full" aria-live="polite">
          <div className="run-summary-heading">
            <div>
              <h2>Results</h2>
              <p>{calculatedClimbTime === null
                ? "Run the analysis to calculate timing, tracking, and route splits."
                : `Timing is locked from ${acceptedStart.source.toLowerCase()} to ${acceptedFinish.source.toLowerCase()}.`}</p>
            </div>
            <span className={calculatedClimbTime === null ? "summary-status" : "summary-status ready"}>
              <i /> {calculatedClimbTime === null ? analysisStage : "Analysis ready"}
            </span>
          </div>
          <div className="summary-metrics">
            <div className="summary-primary-metric">
              <span>Total climb</span>
              <strong>{calculatedClimbTime === null ? "—" : calculatedClimbTime.toFixed(3)}<small>{calculatedClimbTime === null ? "" : "s"}</small></strong>
              <small>{acceptedFinish.confidence} confidence</small>
            </div>
            <div><span>First movement</span><strong>{acceptedReactionTime === null ? "—" : `${acceptedReactionTime.toFixed(3)}s`}</strong><small>after start</small></div>
            <div><span>Hold 10</span><strong>{acceptedHold10.climbTime === null ? "—" : `${acceptedHold10.climbTime.toFixed(3)}s`}</strong><small>{acceptedHold10.rawTime === null ? "awaiting contact" : "split time"}</small></div>
            <div><span>Tracking quality</span><strong>{effectiveBiomechanicsResult?.metrics.quality ?? "—"}</strong><small>{effectiveBiomechanicsResult ? "on-device pose" : "run COM analysis"}</small></div>
          </div>
          <div className="summary-footer">
            <p><strong>Review the analysis</strong><span>Check the video against the detected timestamps, then open insights for pace and center-of-mass details.</span></p>
          </div>
        </section>

        <Card title="Save this analysis" className="full secondary-card session-card">
          <div className="session-save-summary">
            <div><strong>{sessionName || "Current analysis"}</strong>
              <p className="muted">Save in this browser. Export your library to move saved attempts to another computer.</p>
            </div>
            <button className="primary" onClick={saveCurrentSession} disabled={videoAnalysisRunning}>Save Session</button>
          </div>
          {sessionStatus && <p className="status-message" role="status">{sessionStatus}</p>}
          <details className="session-details">
            <summary><span><strong>Session details & saved analyses</strong><small>Add an athlete name, notes, or reopen an earlier result.</small></span><span>Manage</span></summary>
            <div className="session-details-content">
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
            <button onClick={renameActiveSession} disabled={videoAnalysisRunning || !activeSessionId}>Rename Session</button>
            <button onClick={duplicateActiveSession} disabled={videoAnalysisRunning}>Duplicate Session</button>
            <button onClick={exportCurrentSession} disabled={videoAnalysisRunning}>Export current session</button>
          </div>
          <div className="session-load-row">
            <select aria-label="Load saved session" value={activeSessionId ?? ""} onChange={(event) => loadSelectedSession(event.target.value)} disabled={videoAnalysisRunning || savedSessions.length === 0}>
              <option value="">Load saved session</option>
              {savedSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} {session.videoFileName ? `- ${session.videoFileName}` : ""}
                </option>
              ))}
            </select>
            <button onClick={deleteActiveSession} disabled={videoAnalysisRunning || !activeSessionId}>Delete Session</button>
          </div>
          <SavedSessionsList sessions={savedSessions} activeSessionId={activeSessionId} onLoad={loadSelectedSession} disabled={videoAnalysisRunning} />
          <p className="muted">
            Sessions save zones, timing, compact biomechanics results, settings, and notes in this browser. Videos stay local and are not uploaded.
          </p>
            </div>
          </details>
        </Card>

        <Card id="video-review" title="Review the run" className="full video-review-card">
          <div className={`review-workspace${visibleTimestampReview ? " active" : ""}`}>
          <div className="review-player-area">
          <div className="video-viewport">
            <video
              key={videoUrl ?? "empty-video"}
              ref={videoRef}
              src={videoUrl ?? undefined}
              className="video-player"
              preload="metadata"
              controls={!videoAnalysisRunning}
              onLoadedMetadata={handleMetadataLoaded}
              onError={handleVideoLoadError}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onSeeking={() => { if (timestampReview) setReviewFrameReady(false); }}
              onPlay={() => { if (timestampReview) setReviewFrameReady(false); }}
              onPause={(event) => { setCurrentTime(event.currentTarget.currentTime); setReviewFrameReady(!event.currentTarget.seeking); }}
              onSeeked={(event) => {
                setCurrentTime(event.currentTarget.currentTime);
                setReviewFrameReady(event.currentTarget.paused);
              }}
            />
            <Suspense fallback={null}>
              <PoseVideoOverlay
                result={videoUrl && metadata?.metadataLoaded ? effectiveBiomechanicsResult : undefined}
                calibration={biomechanics.calibration}
                hold10ImageOverride={hold10ImageOverride}
                alignedRouteHolds={routeAlignment?.holds.length
                  ? routeAlignment.holds.filter((hold) => Boolean(hold.observedImage))
                  : undefined}
                currentTime={currentTime}
                videoWidth={metadata?.videoWidth ?? 0}
                videoHeight={metadata?.videoHeight ?? 0}
              />
            </Suspense>
            {autoAnalysisRunning && (
              <div className="video-analysis-overlay" aria-hidden="true">
                <span className="analysis-spinner" />
                <strong>Reading climb</strong>
                <small>{autoAnalysisStatus || "Synchronizing video signals…"}</small>
              </div>
            )}
          </div>
          <div className="player-controls">
            <button disabled={videoAnalysisRunning} onClick={() => (videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause())}>
              Play / pause
            </button>
            <span className="time-pill">Raw video time {currentTime.toFixed(3)}s</span>
            <button data-frame-step="previous" disabled={videoAnalysisRunning} onClick={() => nativeFrameStepsAvailable ? stepSourceFrame(-1) : stepVideo(-0.03)}
              aria-label={nativeFrameStepsAvailable ? "Previous source frame" : "Back 0.03 seconds (approximate)"}>{nativeFrameStepsAvailable ? "← Frame" : "-0.03s"}</button>
            <button data-frame-step="next" disabled={videoAnalysisRunning} onClick={() => nativeFrameStepsAvailable ? stepSourceFrame(1) : stepVideo(0.03)}
              aria-label={nativeFrameStepsAvailable ? "Next source frame" : "Forward 0.03 seconds (approximate)"}>{nativeFrameStepsAvailable ? "Frame →" : "+0.03s"}</button>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(-0.1)}>-0.10s</button>
            <button disabled={videoAnalysisRunning} onClick={() => stepVideo(0.1)}>+0.10s</button>
            <input
              className="small-input review-jump-field"
              value={jumpInput}
              aria-label="Jump to raw video time"
              onChange={(event) => setJumpInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && parseOptionalNumber(jumpInput) !== null) jumpTo(Number(jumpInput)); }}
              placeholder="Raw time"
              disabled={videoAnalysisRunning}
            />
            <button className="review-jump-action" disabled={videoAnalysisRunning || parseOptionalNumber(jumpInput) === null} onClick={() => jumpTo(Number(jumpInput))}>Jump</button>
          </div>
          </div>
          {visibleTimestampReview ? <TimestampReviewPanel
            label={visibleTimestampReview.label} confidence={visibleTimestampReview.confidence}
            suggestedRawTime={visibleTimestampReview.suggestedRawTime} currentTime={currentTime}
            decodedRawTime={decodedReviewTime} frameStatus={framePresentation.status}
            sourceFrameDurationSeconds={decodedReviewTime !== undefined && framePresentation.status === "available" ? framePresentation.durationSeconds : undefined}
            frameReady={reviewFrameReady} busy={videoAnalysisRunning} acceptLabel={visibleTimestampReview.acceptLabel}
            onReturn={() => reviewTimestamp(visibleTimestampReview)} onAccept={acceptReviewedTimestamp}
            onClose={closeTimestampReview}
          /> : null}
          </div>
          {routeAlignment && (
            <p className={routeAlignment.aligned || routeAlignment.holds.length ? "status-message" : "guidance"}>
              {routeAlignment.aligned
                ? `Route registered: ${routeAlignment.diagnostics.matchedHoldIds.length}/20 visible holds matched. Number markers now sit on the detected holds.`
                : routeAlignment.holds.length
                  ? `Partial route: ${routeAlignment.holds.length}/20 direct hold silhouettes matched. Uncertain markers and Hold 10 are hidden. ${routeAlignment.reason}`
                  : `Route markers hidden: ${routeAlignment.reason}`}
            </p>
          )}
          {activeHold10SecondPass && <Suspense fallback={<p className="muted">Preparing Hold 10 evidence…</p>}>
            <Hold10SecondPassPanel result={activeHold10SecondPass} disabled={videoAnalysisRunning} onReview={reviewRefinedHold10} />
          </Suspense>}
          {videoRestoreStatus && <p className="status-message">{videoRestoreStatus}</p>}
        </Card>

        <details className="advanced-workspace full" id="review-tools">
          <summary>
            <span><strong>Review & advanced tools</strong><small>Only open this when an automatic suggestion needs a closer look.</small></span>
            <span className="advanced-summary-action">Open controls</span>
          </summary>
          <div className="advanced-workspace-grid">
        <Card id="zones" title="Manual lane setup" className="full secondary-card">
          <details className="section-details">
            <summary>
              <span>Open manual zone setup</span>
              <small>Correct the athlete lane, start light, or projected Hold 10 only when automatic setup needs help.</small>
            </summary>
            <div className="section-details-content">
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
            <button
              disabled={videoAnalysisRunning}
              onClick={() => {
                pendingAutomaticContextRef.current = null;
                if (selectedZoneId === "startLight") {
                  invalidateStartLightDependents("Start-light region deleted; its learned colors and finish were cleared.");
                }
                setZones((current) => omitZone(current, selectedZoneId));
              }}
            >
              Delete selected zone
            </button>
            <button
              disabled={videoAnalysisRunning}
              onClick={() => {
                pendingAutomaticContextRef.current = null;
                invalidateStartLightDependents("All zones and lane-light calibration were cleared.");
                setZones({});
              }}
            >
              Clear all zones
            </button>
          </div>
          <p className="muted zone-helper">
            Zones are normally unnecessary. If two climbers are visible, draw one rough Start Body Zone around your climber so identity stays locked to that lane. Draw a Start Light Zone only if automatic sensor discovery fails. If the numbered route overlay places Hold 10 incorrectly, draw a small Hold 10 Zone over the real hold to correct contact timing.
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
            </div>
          </details>
        </Card>

        <Card id="timing" title="Start timing">
          <p className="muted">
            Quick Analyze searches the selected opening window, ignores upper-wall activity, and timestamps the first real blue-directed change near the floor instead of treating a climber covering green as the start. The later clear blue state verifies the faint onset. Exact octave-up audio anchors timing, and first movement is measured above the light spill inside the selected athlete lane.
          </p>
          <details className="help-details">
            <summary>Manual timing settings</summary>
          <div className="form-grid">
            <label>
              Ignore video before (seconds)
              <input type="number" min="0" value={startSearchStart} step="0.1" disabled={videoAnalysisRunning} onChange={(event) => handleStartSearchWindowChange("start", Number(event.target.value))} />
            </label>
            <label>
              Stop start search at video time (seconds)
              <input type="number" min="0.5" value={startSearchEnd} step="0.1" disabled={videoAnalysisRunning} onChange={(event) => handleStartSearchWindowChange("end", Number(event.target.value))} />
            </label>
            <label>
              Sensitivity
              <select
                disabled={videoAnalysisRunning}
                value={startSensitivity}
                onChange={(event) => {
                  setStartSensitivity(event.target.value as Sensitivity);
                  invalidateStartDetectorSuggestion("Start sensitivity changed. Run the analysis again to generate a matching suggestion.");
                }}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              Detection profile
              <select
                disabled={videoAnalysisRunning}
                value={startDetectionProfile}
                onChange={(event) => {
                  const value = event.target.value as StartDetectionProfile;
                  setStartDetectionProfile(value);
                  if (value === "blocked") {
                    setStartLightVisibility("blocked");
                    handleStartSignalOffsetChange(-0.1);
                  }
                  invalidateStartDetectorSuggestion("Start detection profile changed. Run the analysis again to generate a matching suggestion.");
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
                disabled={videoAnalysisRunning}
                value={startLightVisibility}
                onChange={(event) => {
                  const value = event.target.value as "clear" | "blocked";
                  setStartLightVisibility(value);
                  handleStartSignalOffsetChange(value === "blocked" ? -0.1 : 0);
                  invalidateStartDetectorSuggestion("Start-light visibility changed. Run the analysis again to generate a matching suggestion.");
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
                disabled={videoAnalysisRunning}
                value={startSignalOffset}
                onChange={(event) => handleStartSignalOffsetChange(Number(event.target.value))}
              />
            </label>
            <label>
              Estimated reaction time offset
              <input
                type="number"
                step="0.01"
                disabled={videoAnalysisRunning}
                value={reactionTimeOffset}
                onChange={(event) => {
                  setReactionTimeOffset(Number(event.target.value));
                  invalidateStartDetectorSuggestion("Reaction estimate changed. Run the analysis again to generate a matching suggestion.");
                }}
              />
            </label>
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
            {hasCalibrationSamples && (
              <button
                disabled={videoAnalysisRunning}
                onClick={() => {
                  invalidateStartLightDependents("Manual light calibration and dependent finish timing were cleared.");
                }}
              >
                Clear light calibration
              </button>
            )}
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
            offsetButtons={[-0.05, -0.1, -0.15]}
            onOffsetChange={handleStartSignalOffsetChange}
            onJumpCandidate={(candidate, delta = 0) => jumpTo(Math.max(0, roundTime(candidate.rawTime + startSignalOffset + delta)))}
            onReviewCandidate={(candidate) => reviewTimestamp({
              label: `Start signal backup (${candidate.kind})`,
              suggestedRawTime: Math.max(0, roundTime(candidate.rawTime + startSignalOffset)),
              confidence: candidate.confidence,
              acceptLabel: "Accept start",
              onAccept: (rawTime, frameTimeNote) => acceptTimestamp("startSignal", rawTime, startSourceForCandidate(candidate), candidate.confidence, {
                frameReviewed: true,
                detectedRawTime: candidate.rawTime,
                offsetApplied: roundTime(rawTime - candidate.rawTime),
                note: `${candidate.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
              }),
            })}
            getCandidateJumpTarget={(candidate) => Math.max(0, roundTime(candidate.rawTime + startSignalOffset))}
            onReview={() => startResult?.rawTime !== undefined && reviewTimestamp({
              label: "Suggested start signal",
              suggestedRawTime: Math.max(0, roundTime(startResult.rawTime + startSignalOffset)),
              confidence: startResult.confidence,
              acceptLabel: "Accept start",
              onAccept: (rawTime, frameTimeNote) => acceptTimestamp("startSignal", rawTime, startSourceForResult(startResult), startResult.confidence, {
                frameReviewed: true,
                detectedRawTime: startResult.rawTime!,
                offsetApplied: roundTime(rawTime - startResult.rawTime!),
                note: `${startResult.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
              }),
            })}
            onJump={(delta = 0) => jumpTo(startFinalRaw !== undefined ? Math.max(0, roundTime(startFinalRaw + delta)) : undefined)}
            onReject={() => {
              setStartResult(null);
              setSuggestedStartRawTime(null);
            }}
            emptyText="Start Signal not detected."
            defaultCandidateSource="Start light detection"
          />
        </Card>

        <Card title="First movement">
          <p className="muted">Quick Analyze runs this automatically after the color-defined start. Open settings only when manual tuning is needed.</p>
          <details className="help-details">
            <summary>Manual movement settings</summary>
          <label className="single-field">
            Sensitivity
            <select
              disabled={videoAnalysisRunning}
              value={movementSensitivity}
              onChange={(event) => {
                setMovementSensitivity(event.target.value as Sensitivity);
                invalidateMovementSuggestion("Movement sensitivity changed. Detect first movement again before reviewing a suggestion.");
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="single-field">
            First movement definition
            <select
              disabled={videoAnalysisRunning}
              value={firstMovementDefinition}
              onChange={(event) => {
                setFirstMovementDefinition(event.target.value as FirstMovementDefinition);
                invalidateMovementSuggestion("First-movement definition changed. Detect first movement again before reviewing a suggestion.");
              }}
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
              disabled={videoAnalysisRunning}
              value={committedLaunchMinDelay}
              onChange={(event) => {
                setCommittedLaunchMinDelay(Number(event.target.value));
                invalidateMovementSuggestion("Committed-launch delay changed. Detect first movement again before reviewing a suggestion.");
              }}
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
              disabled={videoAnalysisRunning}
              value={firstMovementOffset}
              onChange={(event) => handleFirstMovementOffsetChange(Number(event.target.value))}
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
            offsetButtons={[-0.03, -0.05, -0.1]}
            onOffsetChange={handleFirstMovementOffsetChange}
            onJumpCandidate={(candidate, delta = 0) => jumpTo(Math.max(0, roundTime(candidate.rawTime + firstMovementOffset + delta)))}
            onReviewCandidate={(candidate) => {
              const definition = movementDefinitionForCandidate(candidate);
              reviewTimestamp({
                label: `${movementDefinitionLabel(definition)} backup`,
                suggestedRawTime: Math.max(0, roundTime(candidate.rawTime + firstMovementOffset)),
                confidence: candidate.confidence,
                acceptLabel: `Accept ${movementDefinitionLabel(definition).toLowerCase()}`,
                onAccept: (rawTime, frameTimeNote) => acceptTimestamp(definition === "committed" ? "committedLaunch" : "firstMovement", rawTime, "Body motion detection", candidate.confidence, {
                  frameReviewed: true,
                  detectedRawTime: candidate.rawTime,
                  offsetApplied: roundTime(rawTime - candidate.rawTime),
                  note: `${candidate.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
                }),
              });
            }}
            getCandidateJumpTarget={(candidate) => Math.max(0, roundTime(candidate.rawTime + firstMovementOffset))}
            candidatePreviewFrames={movementPreviewFrames}
            defaultCandidateSource="Body motion detection"
            showMovementCandidateActions
            onReview={() => movementResult?.rawTime !== undefined && reviewTimestamp({
              label: `Suggested ${movementDefinitionLabel(firstMovementDefinition).toLowerCase()}`,
              suggestedRawTime: Math.max(0, roundTime(movementResult.rawTime + firstMovementOffset)),
              confidence: movementResult.confidence,
              acceptLabel: `Accept ${movementDefinitionLabel(firstMovementDefinition).toLowerCase()}`,
              onAccept: (rawTime, frameTimeNote) => acceptTimestamp(firstMovementDefinition === "committed" ? "committedLaunch" : "firstMovement", rawTime, "Body motion detection", movementResult.confidence, {
                frameReviewed: true,
                detectedRawTime: movementResult.rawTime!,
                offsetApplied: roundTime(rawTime - movementResult.rawTime!),
                note: `${movementResult.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
              }),
            })}
            onJump={(delta = 0) => jumpTo(movementFinalRaw !== undefined ? Math.max(0, roundTime(movementFinalRaw + delta)) : undefined)}
            onReject={() => setMovementResult(null)}
            emptyText="First Movement not detected."
          />
        </Card>

        <Card title="Finish timing">
          <p className="muted">
            ClimbIQ follows the same selected lane light for up to 30 seconds after the start. It learns the during-climb state, timestamps the first persistent switch to the opposite calibrated state, and verifies it afterward—whether the video shows blue → green or green → blue.
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={videoAnalysisRunning || startSignalRaw === null || !zones.startLight || !calibrationReady}
              onClick={runAutomaticFinishDetection}
            >
              {finishRunning ? "Finding finish…" : "Find finish automatically"}
            </button>
          </div>
          {finishStatus && <p className="status-line">{finishStatus}</p>}
          {finishResult?.detected && finishResult.rawTime !== undefined && startSignalRaw !== null && (
            <div className="suggestion-card" data-finish-evidence>
              <h3>{finishResult.debug.finishEvidenceKind === "physical-top-reach" || finishResult.debug.finishEvidenceKind === "upper-wall-presence"
                ? "Upper-wall motion for review" : "Finish review candidate"}</h3>
              <p>Raw video time: {finishResult.rawTime.toFixed(3)}s</p>
              <p>Climb time: {(finishResult.rawTime - startSignalRaw).toFixed(3)}s</p>
              <p>Confidence: {finishResult.confidence}</p>
              <p className="muted">{finishResult.reason}</p>
              <div className="button-row review-first-actions">
                <button
                  className="primary"
                  onClick={() => reviewTimestamp({
                    label: "Suggested finish",
                    suggestedRawTime: finishResult.rawTime!,
                    confidence: finishResult.confidence,
                    acceptLabel: "Accept finish",
                    onAccept: (rawTime, frameTimeNote) => acceptManualTimestamp("finishPad", rawTime, {
                      frameReviewed: true,
                      detectedRawTime: finishResult.rawTime,
                      offsetApplied: roundTime(rawTime - finishResult.rawTime!),
                      note: `${finishResult.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
                    }),
                  })}
                >
                  Review finish at video
                </button>
                <button onClick={() => setFinishResult(null)}>Dismiss</button>
              </div>
            </div>
          )}
          {!finishResult?.detected && Boolean(finishResult?.candidates?.length) && startSignalRaw !== null && (
            <details className="technical-details">
              <summary>Inspect unverified color changes</summary>
              <p className="muted">These are not verified finish events. Digits, clothing, and reflections can change color. Use the full video to locate actual pad contact.</p>
              <div className="button-row">
                {finishResult!.candidates!.slice(0, 5).map((candidate, index) => (
                  <button key={`${candidate.rawTime}-${index}`} disabled={videoAnalysisRunning} onClick={() => reviewTimestamp({
                    label: "Unverified color change — locate actual finish contact",
                    suggestedRawTime: candidate.rawTime,
                    confidence: "Low", acceptLabel: "Set manual finish",
                    onAccept: (rawTime, frameTimeNote) => acceptManualTimestamp("finishPad", rawTime, {
                      frameReviewed: true,
                      detectedRawTime: candidate.rawTime, offsetApplied: roundTime(rawTime - candidate.rawTime),
                      note: `Manually reviewed from an unverified color-change cursor, not a verified light event. ${frameTimeNote ?? ""}`,
                    }),
                  })}>Inspect {candidate.rawTime.toFixed(3)}s</button>
                ))}
              </div>
            </details>
          )}
          <hr />
          <label className="single-field">
            Official total time (optional cross-check)
            <input
              type="number"
              min="0.001"
              step="0.001"
              disabled={videoAnalysisRunning}
              value={officialTotalTime}
              placeholder="13.125"
              onChange={(event) => handleOfficialTotalTimeChange(event.target.value)}
            />
          </label>
          {startSignalRaw === null ? (
            <p className="muted">Set Start Signal first; an official time can still calculate a fallback Finish Pad.</p>
          ) : officialTimeError ? (
            <p className="error-message" role="alert">{officialTimeError}</p>
          ) : finishSuggestion ? (
            <div className="suggestion-card">
              <h3>Suggested Finish Pad</h3>
              <p>Climb time: {finishSuggestion.climbTime.toFixed(3)}s after Start Signal</p>
              <p>Raw video time: {finishSuggestion.rawTime.toFixed(3)}s</p>
              <p>Source: Calculated from official total time, not video-detected</p>
              <p>Confidence: High</p>
              <p className="muted">Jump target: {finishSuggestion.rawTime.toFixed(3)}s raw</p>
              <div className="button-row review-first-actions">
                <button
                  className="primary"
                  onClick={() => reviewTimestamp({
                    label: "Official-time finish",
                    suggestedRawTime: finishSuggestion.rawTime,
                    confidence: "High",
                    acceptLabel: "Accept finish",
                    onAccept: (rawTime, frameTimeNote) => acceptTimestamp("finishPad", rawTime, "Official total time", "High", {
                      frameReviewed: true,
                      detectedRawTime: finishSuggestion.rawTime,
                      offsetApplied: roundTime(rawTime - finishSuggestion.rawTime),
                      note: `Official-time finish reviewed against the video frame. ${frameTimeNote ?? ""}`,
                    }),
                  })}
                >
                  Review finish at video
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">Enter an official total time to calculate Finish Pad.</p>
          )}
        </Card>
          </div>
        </details>

        <Card id="results" title="Timing markers" className="full results-card">
          <details className="results-details">
            <summary>
              <span><strong>Review or edit exact timing markers</strong><small>Automatic results stay untouched unless you change them here.</small></span>
              <span>Open marker editor</span>
            </summary>
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
                  <tr key={`${item.id}:${videoUrl ?? "no-video"}:${activeSessionId ?? "draft"}`}>
                    <td>{item.label}</td>
                    <td>{formatTime(item.rawTime)}</td>
                    <td>{formatTime(item.climbTime)}</td>
                    <td>{item.source}</td>
                    <td>{item.confidence}</td>
                    <td>
                      <div className="table-actions">
                        {item.rawTime !== null && (
                          <>
                            <button
                              disabled={videoAnalysisRunning}
                              onClick={() => reviewTimestamp({
                                label: item.label,
                                suggestedRawTime: item.rawTime!,
                                confidence: item.confidence,
                                acceptLabel: "Update marker",
                                onAccept: (rawTime, frameTimeNote) => acceptManualTimestamp(item.id, rawTime, {
                                  frameReviewed: true,
                                  detectedRawTime: item.rawTime ?? undefined,
                                  offsetApplied: item.rawTime === null ? undefined : roundTime(rawTime - item.rawTime),
                                  note: `Accepted time reviewed and adjusted in the video player. ${frameTimeNote ?? ""}`,
                                }),
                              })}
                            >
                              Review
                            </button>
                            <button disabled={videoAnalysisRunning} onClick={() => clearTimestamp(item.id)}>Clear</button>
                          </>
                        )}
                        <button disabled={videoAnalysisRunning || !hasLoadedVideo} onClick={() => {
                          const video = videoRef.current;
                          if (!video || video.seeking || !video.paused) { setTimestampStatus("Pause the video and wait for the frame before setting a marker."); return; }
                          acceptManualTimestamp(item.id, video.currentTime, { note: "Set from the paused video cursor; a decoded-frame timestamp was not requested." });
                        }}>Set current</button>
                        <input
                          aria-label={`${item.label} raw video time`}
                          disabled={videoAnalysisRunning}
                          inputMode="decimal"
                          placeholder="Raw"
                          onBlur={(event) => { if (setTimestampFromInput(item.id, event.target.value, "raw")) event.currentTarget.value = ""; }}
                          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        />
                        <input
                          aria-label={`${item.label} climb time`}
                          inputMode="decimal"
                          placeholder="Climb"
                          disabled={videoAnalysisRunning || startSignalRaw === null}
                          onBlur={(event) => { if (setTimestampFromInput(item.id, event.target.value, "climb")) event.currentTarget.value = ""; }}
                          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {timestampStatus && <p className="error-message" role="alert">{timestampStatus}</p>}
          </details>
        </Card>

        <Card id="splits" title="Performance splits" className="full splits-card">
          {effectiveBiomechanicsResult && (
            <>
              <p className="muted">
                Wall halves and thirds come from upward center-of-mass progress. Hold 10 is timed separately only when a tracked hand settles near the projected Hold 10 marker.
              </p>
              <div className={hold10Contact?.detected ? "hold-contact-summary detected" : "hold-contact-summary"}>
                <div>
                  <strong>Hold 10 hand contact</strong>
                  <span>
                    {acceptedHold10.climbTime !== null
                      ? `Accepted at ${acceptedHold10.climbTime.toFixed(3)}s after start · ${acceptedHold10.source} · ${acceptedHold10.confidence} confidence`
                      : hold10Contact?.detected && hold10Contact.climbTime !== undefined
                        ? `${hold10Contact.climbTime.toFixed(3)}s after start · ${hold10Contact.hand} hand · ${hold10Contact.distanceMeters?.toFixed(2)} m from the projected hold center${hold10Contact.evidence?.contactScore === undefined ? "" : ` · ${hold10Contact.evidence.contactScore.toFixed(0)}/100 evidence`}`
                        : hold10HeightEstimate?.detected && hold10HeightEstimate.climbTime !== undefined
                          ? `Review estimate at ${hold10HeightEstimate.climbTime.toFixed(3)}s after start · ${hold10HeightEstimate.hand} hand crossed Hold 10 height`
                          : hold10HeightEstimate?.reason ?? hold10Contact?.reason ?? (hold10Target.source === "standard-template"
                            ? "Hold 10 timing is paused until the visible route aligns or you mark a manual Hold 10 zone."
                            : "Run center-of-mass analysis to check hand contact with Hold 10.")}
                  </span>
                  <small>{acceptedHold10.rawTime !== null
                    ? "The accepted contact frame drives the two race-phase splits below. Reopen it from the marker editor to adjust or clear it."
                    : hold10Target.source === "standard-template"
                    ? hold10HeightEstimate?.detected
                      ? "Height crossing is only a review aid; it is not treated as Hold 10 contact until you confirm the exact frame."
                      : "The generic diagram is used only as a search prior; ClimbIQ will not time contact from its unregistered position."
                    : hold10Target.reason}</small>
                </div>
                {acceptedHold10.rawTime === null && activeHold10SecondPass && (
                  <button disabled={videoAnalysisRunning} onClick={() => reviewRefinedHold10(activeHold10SecondPass.evidence.candidateRawTime)}>Review close-up evidence</button>
                )}
                {acceptedHold10.rawTime === null && !activeHold10SecondPass && hold10Contact?.detected && hold10Contact.rawTime !== undefined && (
                  <button onClick={() => reviewTimestamp({
                    label: "Detected Hold 10 hand contact",
                    suggestedRawTime: hold10Contact.rawTime!,
                    confidence: hold10Contact.confidence,
                    acceptLabel: "Set Hold 10",
                    onAccept: (rawTime, frameTimeNote) => acceptTimestamp("hold10", rawTime, "Manual", "Medium", {
                      frameReviewed: true,
                      detectedRawTime: hold10Contact.rawTime,
                      offsetApplied: roundTime(rawTime - hold10Contact.rawTime!),
                      note: `${hold10Contact.reason} Reviewed against the video frame. ${frameTimeNote ?? ""}`,
                    }),
                  })}>
                    Review Hold 10
                  </button>
                )}
                {acceptedHold10.rawTime === null && !activeHold10SecondPass && !hold10Contact?.detected && hold10HeightEstimate?.detected && hold10HeightEstimate.rawTime !== undefined && (
                  <button onClick={() => reviewTimestamp({
                    label: "Possible Hold 10 height passage",
                    suggestedRawTime: hold10HeightEstimate.rawTime!,
                    confidence: "Low",
                    acceptLabel: "Set Hold 10",
                    onAccept: (rawTime, frameTimeNote) => acceptTimestamp("hold10", rawTime, "Manual", "Medium", {
                      frameReviewed: true,
                      detectedRawTime: hold10HeightEstimate.rawTime,
                      offsetApplied: roundTime(rawTime - hold10HeightEstimate.rawTime!),
                      note: `${hold10HeightEstimate.reason} Confirmed manually against the contact frame. ${frameTimeNote ?? ""}`,
                    }),
                  })}>
                    Review possible Hold 10
                  </button>
                )}
              </div>
              {!activeHold10SecondPass && (hold10Contact?.detected || hold10HeightEstimate?.detected ||
                (hold10Target.source === "standard-template" && !routeAlignment && effectiveBiomechanicsResult.metrics.validFrames >= 3)) && (
                <div className="button-row"><button disabled={videoAnalysisRunning || !hasLoadedVideo} onClick={refineCurrentHold10}>Inspect Hold 10 more closely</button>
                  {secondPassRunning && <button onClick={() => secondPassAbortRef.current?.abort()}>Cancel closer scan</button>}
                </div>
              )}
              {secondPassStatus && <p className="status-message" role="status">{secondPassStatus}</p>}
              {finishTrimmedBiomechanics?.cutoff.source === "top-completion" && (
                <p className="status-message">
                  COM stopped at {finishTrimmedBiomechanics.cutoff.cutoffRawTime.toFixed(3)}s raw when the athlete completed the top. Post-finish descent is excluded from the path, speed, and splits.
                </p>
              )}
            </>
          )}
          {hold10PhaseSplits.available ? (
            <>
              <div className="split-grid hold10-phase-grid" aria-label="Hold 10 race phases">
                <Metric
                  label="Start → Hold 10"
                  value={`${hold10PhaseSplits.startToHold10Seconds!.toFixed(3)}s`}
                />
                <Metric
                  label="Hold 10 → Finish"
                  value={`${hold10PhaseSplits.hold10ToFinishSeconds!.toFixed(3)}s`}
                />
              </div>
              <p className="muted">
                Contact-defined race phases · {(hold10PhaseSplits.hold10Share! * 100).toFixed(1)}% before Hold 10 and {((1 - hold10PhaseSplits.hold10Share!) * 100).toFixed(1)}% after · {hold10PhaseSplits.slowerPhase === "balanced"
                  ? "phases are balanced within 0.050s"
                  : `${hold10PhaseSplits.slowerPhase === "start-to-hold10" ? "bottom phase" : "top phase"} took ${hold10PhaseSplits.phaseDifferenceSeconds!.toFixed(3)}s longer`} · {hold10PhaseSplits.confidence} Hold 10 confidence. These are separate from the wall-height halves below.
              </p>
            </>
          ) : (
            <p className="guidance">Start → Hold 10 and Hold 10 → Finish appear after Hold 10 hand contact is verified.</p>
          )}
          {routeSplitAnalysis?.available && ["Medium", "High"].includes(routeSplitAnalysis.confidence) ? (
            <>
              <div className="split-grid automatic-split-grid">
                {routeSplitAnalysis.halfway.climbTime !== undefined && effectiveBiomechanicsResult && (
                  <>
                    <Metric
                      label="Wall-height lower half"
                      value={`${routeSplitAnalysis.halfway.climbTime.toFixed(3)}s`}
                    />
                    <Metric
                      label="Wall-height upper half"
                      value={`${Math.max(0, effectiveBiomechanicsResult.endRawTime - effectiveBiomechanicsResult.startRawTime - routeSplitAnalysis.halfway.climbTime).toFixed(3)}s`}
                    />
                  </>
                )}
                {routeSplitAnalysis.sections.filter((section) => section.available).map((section) => (
                  <Metric
                    key={section.id}
                    label={section.label}
                    value={`${section.sectionTimeSeconds!.toFixed(3)}s`}
                  />
                ))}
              </div>
              {!routeSplitAnalysis.halfway.available && (
                <p className="muted">Wall-height halves unavailable: {routeSplitAnalysis.halfway.reason}</p>
              )}
              {routeSplitAnalysis.slowestSectionId && (
                <p className="status-message">
                  Slowest wall section: {routeSplitAnalysis.sections.find((section) => section.id === routeSplitAnalysis.slowestSectionId)?.label}. Open Center of Mass below to review that section in the video.
                </p>
              )}
            </>
          ) : routeSplitAnalysis?.available ? (
            <p className="guidance">Wall-section estimates are withheld here because overall COM tracking confidence is {routeSplitAnalysis.confidence.toLowerCase()}. Review the diagnostic section in Performance insights instead.</p>
          ) : (
            <p className="guidance">Run center-of-mass analysis to calculate wall-height halves and thirds automatically.</p>
          )}
          <details className="help-details">
            <summary>Manual and contact-based splits</summary>
            <div className="split-grid">
              {splitRows.map((row) => (
                <Metric key={row.label} label={row.label} value={row.value === null ? "Not set" : `${row.value.toFixed(3)}s`} />
              ))}
            </div>
          </details>
        </Card>

        <Card id="center-of-mass" title="Performance insights" className="full insights-card">
          <Suspense fallback={<p className="muted">Preparing on-device performance tools…</p>}>
            <BiomechanicsPanel
              key={`${videoUrl ?? "no-video"}:${activeSessionId ?? "unsaved-session"}`}
              videoRef={videoRef}
              metadata={metadata}
              currentTime={currentTime}
              startRawTime={startSignalRaw}
              finishRawTime={getTimestamp(timestamps, "finishPad").rawTime}
              fallbackFinishRawTime={analysisFinishFallbackRawTime}
              identityZone={zones.startBody}
              session={biomechanics}
              displayResult={effectiveBiomechanicsResult}
              finishCutoff={finishTrimmedBiomechanics?.cutoff}
              analysisBlocked={startRunning || movementRunning || movementPreviewRunning || frameTestRunning || autoAnalysisRunning || secondPassRunning || finishRunning}
              onSessionChange={(nextSession) => {
                if (nextSession.calibration !== biomechanics.calibration) {
                  setRouteAlignment(null);
                }
                setBiomechanics(nextSession);
              }}
              onRunningChange={setBiomechanicsRunning}
              onJump={jumpTo}
              runVideoTask={runNamedVideoTask}
              onLocateRoute={locateVisibleRouteHolds}
            />
          </Suspense>
        </Card>

        <Card id="export" title="Save & export" className="full secondary-card export-card">
          <p className="muted">
            Export a human-readable Obsidian note or machine-readable JSON dataset. Videos are not stored or uploaded.
          </p>
          <div className="button-row">
            <button className="primary" onClick={downloadMarkdown}>Download report</button>
            <button onClick={downloadDatasetJson}>Download data</button>
          </div>
          {exportStatus && <p className="status-message">{exportStatus}</p>}
          <details className="help-details">
            <summary>Copy and Obsidian options</summary>
            <div className="button-row compact-row">
              <button onClick={copyObsidianNote}>Copy Obsidian note</button>
              <button onClick={copyDatasetJson}>Copy JSON</button>
              <button onClick={chooseObsidianFolder}>Choose Obsidian folder</button>
              <button onClick={saveExportsToObsidianFolder}>Save report + data to folder</button>
              {obsidianFolderName && <span className="time-pill">Folder: {obsidianFolderName}</span>}
            </div>
            <p className="muted">
              Direct folder saving works only in supported desktop browsers. Downloads and copy buttons work everywhere.
            </p>
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
              <li>After analyzing a climb, download the report or copy the Obsidian note.</li>
              <li>Save the Markdown note into Attempts.</li>
              <li>Save the JSON export into Exports.</li>
              <li>Keep videos local. ClimbIQ only stores the video file name, not the actual video.</li>
            </ol>
          </details>
        </Card>
          </>
        )}

      </section>
      {autoAnalysisRunning && (
        <aside className="analysis-tray" aria-live="polite">
          <span className="analysis-spinner" aria-hidden="true" />
          <div><strong>ClimbIQ is analyzing your video</strong><small>{autoAnalysisStatus || "Finding the athlete, timing signals, and wall geometry…"}</small></div>
          <button onClick={() => autoAnalysisAbortRef.current?.abort()}>Cancel</button>
        </aside>
      )}
    </main>
  );
}

function Card({
  id,
  title,
  children,
  className = "",
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card ${className}`}>
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
  onJumpCandidate,
  onReview,
  onReviewCandidate,
  getCandidateJumpTarget,
  candidatePreviewFrames,
  defaultCandidateSource,
  showMovementCandidateActions = false,
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
  onJumpCandidate?: (candidate: DetectionCandidate, delta?: number) => void;
  onReview?: () => void;
  onReviewCandidate?: (candidate: DetectionCandidate) => void;
  getCandidateJumpTarget?: (candidate: DetectionCandidate) => number;
  candidatePreviewFrames?: Record<string, CandidatePreviewFrames>;
  defaultCandidateSource?: string;
  showMovementCandidateActions?: boolean;
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
          suggestedRawTime={result.rawTime}
          onJumpCandidate={onJumpCandidate}
          onReviewCandidate={onReviewCandidate}
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
      <div className="button-row review-first-actions">
        <button className="primary" onClick={onReview ?? (() => onJump(0))}>Review at video</button>
        <button onClick={onReject}>Reject</button>
      </div>
      <details className="candidate-advanced">
        <summary>Fine-tune this time</summary>
        <p className="muted">Preview nearby frames, or apply a small correction before accepting.</p>
        <div className="button-row compact-row">
          <button onClick={() => onJump(-0.1)}>Preview -0.10s</button>
          <button onClick={() => onJump(0)}>Preview exact</button>
          <button onClick={() => onJump(0.1)}>Preview +0.10s</button>
          {onOffsetChange && offsetButtons.map((buttonOffset) => (
            <button key={buttonOffset} onClick={() => onOffsetChange(buttonOffset)}>
              Correction {buttonOffset.toFixed(2)}s
            </button>
          ))}
          {onOffsetChange && <button onClick={() => onOffsetChange(0)}>Reset correction</button>}
        </div>
      </details>
      <CandidateList
        candidates={candidates}
        suggestedRawTime={result.rawTime}
        onJumpCandidate={onJumpCandidate}
        onReviewCandidate={onReviewCandidate}
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
  suggestedRawTime,
  onJumpCandidate,
  onReviewCandidate,
  getCandidateJumpTarget,
  candidatePreviewFrames,
  defaultCandidateSource = "Detection",
  showMovementCandidateActions = false,
}: {
  candidates: DetectionCandidate[];
  suggestedRawTime?: number;
  onJumpCandidate?: (candidate: DetectionCandidate, delta?: number) => void;
  onReviewCandidate?: (candidate: DetectionCandidate) => void;
  getCandidateJumpTarget?: (candidate: DetectionCandidate) => number;
  candidatePreviewFrames?: Record<string, CandidatePreviewFrames>;
  defaultCandidateSource?: string;
  showMovementCandidateActions?: boolean;
}) {
  if (!candidates.length) {
    return null;
  }

  const rankedCandidates = [...candidates].sort(compareReviewCandidates);
  const primaryCandidate = suggestedRawTime === undefined ? rankedCandidates[0] : undefined;
  const referenceTime = suggestedRawTime ?? primaryCandidate?.rawTime;
  const minimumBackupGap = showMovementCandidateActions ? 0.08 : 0.12;
  const backupCandidate = referenceTime === undefined
    ? undefined
    : rankedCandidates.find((candidate) =>
      candidate !== primaryCandidate &&
      Math.abs(candidate.rawTime - referenceTime) >= minimumBackupGap,
    );
  const visibleCandidates = [primaryCandidate, backupCandidate].filter(
    (candidate): candidate is DetectionCandidate => Boolean(candidate),
  );
  const hiddenCandidates = candidates.filter((candidate) => !visibleCandidates.includes(candidate));

  return (
    <div className="candidate-list">
      {visibleCandidates.length > 0 && (
        <>
          <h4>{suggestedRawTime === undefined ? "Best available options" : "Backup option"}</h4>
          {visibleCandidates.map((candidate, index) => (
            <CandidateRow
              key={`${candidate.rawTime}-${candidate.kind}-${index}`}
              candidate={candidate}
              compact
              label={primaryCandidate === candidate ? "Best available" : "Different timing"}
              onJumpCandidate={onJumpCandidate}
              onReviewCandidate={onReviewCandidate}
              getCandidateJumpTarget={getCandidateJumpTarget}
              candidatePreviewFrames={candidatePreviewFrames}
              defaultCandidateSource={defaultCandidateSource}
            />
          ))}
        </>
      )}
      {hiddenCandidates.length > 0 && (
        <details className="candidate-advanced">
          <summary>Advanced: {hiddenCandidates.length} technical detector result{hiddenCandidates.length === 1 ? "" : "s"}</summary>
          <p className="muted">These are supporting signals and near-duplicate timings. The automatic recommendation already considers them.</p>
          {hiddenCandidates.map((candidate, index) => (
            <CandidateRow
              key={`${candidate.rawTime}-${candidate.kind}-${index}`}
              candidate={candidate}
              onJumpCandidate={onJumpCandidate}
              onReviewCandidate={onReviewCandidate}
              getCandidateJumpTarget={getCandidateJumpTarget}
              candidatePreviewFrames={candidatePreviewFrames}
              defaultCandidateSource={defaultCandidateSource}
            />
          ))}
        </details>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  compact = false,
  label,
  onJumpCandidate,
  onReviewCandidate,
  getCandidateJumpTarget,
  candidatePreviewFrames,
  defaultCandidateSource,
}: {
  candidate: DetectionCandidate;
  compact?: boolean;
  label?: string;
  onJumpCandidate?: (candidate: DetectionCandidate, delta?: number) => void;
  onReviewCandidate?: (candidate: DetectionCandidate) => void;
  getCandidateJumpTarget?: (candidate: DetectionCandidate) => number;
  candidatePreviewFrames?: Record<string, CandidatePreviewFrames>;
  defaultCandidateSource: string;
}) {
  const jumpTarget = getCandidateJumpTarget?.(candidate) ?? candidate.rawTime;
  const previews = candidatePreviewFrames?.[movementCandidateKey(candidate)];

  return (
    <div className={`candidate-row${compact ? " compact-candidate" : ""}`}>
      <div>
        <strong>{label ? `${label}: ` : ""}{candidate.rawTime.toFixed(3)}s</strong>
        {candidate.climbTime !== undefined && <span>Climb {candidate.climbTime.toFixed(3)}s</span>}
        <span>{compact ? `${candidate.confidence} confidence · ${candidate.kind}` : `${candidate.kind} / score ${candidate.score.toFixed(3)} / ${candidate.confidence}`}</span>
        <span>Source: {candidate.method ?? defaultCandidateSource}</span>
        {!compact && (candidate.distanceToBefore !== undefined || candidate.distanceToAfter !== undefined) && (
          <span>
            Before {candidate.distanceToBefore?.toFixed(3) ?? "n/a"} / After {candidate.distanceToAfter?.toFixed(3) ?? "n/a"}
          </span>
        )}
        {!compact && candidate.detectedMovementRawTime !== undefined && (
          <span>
            First movement {candidate.detectedMovementRawTime.toFixed(3)}s / reaction offset {candidate.reactionOffset?.toFixed(2) ?? "n/a"}s
          </span>
        )}
        {!compact && candidate.persistenceFrames !== undefined && <span>Persistence: {candidate.persistenceFrames} sample{candidate.persistenceFrames === 1 ? "" : "s"}</span>}
        {candidate.suspiciousFirstFrame && (
          <span>Detection occurred very close to the first sampled frame. Verify this is real movement and not sampling noise.</span>
        )}
        {candidate.preloadFlag && <span>Possible preload / weight shift before committed launch.</span>}
        {candidate.method === "Motion-based start estimate" && (
          <span>Estimated from body motion, not light-detected. Review recommended.</span>
        )}
        {!compact && candidate.rgb && (
          <span className="inline-swatch"><ColorSwatch rgb={candidate.rgb} /> Candidate RGB {candidate.rgb.r}, {candidate.rgb.g}, {candidate.rgb.b}</span>
        )}
        <p>{candidate.reason}{candidate.boundaryRisk ? " Edge-of-window candidate." : ""}</p>
        {!compact && <span className="muted">Jump target: {jumpTarget.toFixed(3)}s raw</span>}
        {previews && <CandidatePreviewStrip previews={previews} />}
      </div>
      <div className="candidate-actions">
        {!compact && <button onClick={() => onJumpCandidate?.(candidate, -0.1)}>Jump -0.10s</button>}
        <button onClick={() => onReviewCandidate ? onReviewCandidate(candidate) : onJumpCandidate?.(candidate, 0)}>
          {compact ? "Review at video" : "Jump exact"}
        </button>
        {!compact && <button onClick={() => onJumpCandidate?.(candidate, 0.1)}>Jump +0.10s</button>}
      </div>
    </div>
  );
}

function compareReviewCandidates(left: DetectionCandidate, right: DetectionCandidate) {
  const confidenceDifference = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  const leftRisk = Number(Boolean(left.boundaryRisk)) + Number(Boolean(left.suspiciousFirstFrame));
  const rightRisk = Number(Boolean(right.boundaryRisk)) + Number(Boolean(right.suspiciousFirstFrame));
  if (leftRisk !== rightRisk) {
    return leftRisk - rightRisk;
  }

  return right.score - left.score;
}

function confidenceRank(confidence: Confidence) {
  return confidence === "High" ? 3 : confidence === "Medium" ? 2 : 1;
}

function movementDefinitionForCandidate(candidate: DetectionCandidate): FirstMovementDefinition {
  const kind = candidate.kind.toLowerCase();
  return kind.includes("committed") || kind.includes("largest early motion") ? "committed" : "earliest";
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
      <details className="technical-details">
        <summary>Technical detection details</summary>
        <div className="detection-summary">
          <span>Baseline RGB: {baseline}</span>
          <span>Method: {debug.detectionMethod ?? "Generic color-distance detection"}</span>
          <span>First crossing: {formatOptionalTime(debug.firstThresholdCrossingTime)}</span>
          <span>Strongest signal: {formatOptionalTime(debug.strongestSignalTime)}</span>
          <span>Selected: {formatOptionalTime(debug.selectedCandidateTime)}</span>
          {debug.selectedCandidateReason && <span>{debug.selectedCandidateReason}</span>}
        </div>
      </details>
    );
  }

  return (
    <details className="technical-details">
      <summary>Technical motion details</summary>
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
    </details>
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
      kind: "Changed-pitch final start beep",
      method: "Pitch-coded start audio detection",
      persistenceFrames: audio.sequence?.length,
    }] : [],
    debug: {
      zoneExists: false,
      detectionMethod: "Pitch-coded start audio detection",
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

function formatSignedTime(value: number) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(3)}s`;
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

function formatRgb(rgb?: RGB) {
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "not set";
}

function downloadTextFile(fileName: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive through the browser's download dispatch. Some
  // browsers can cancel a download when it is revoked in the same task.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  const sanitizedSettings = sanitizeAnalysisSessionSettings({
    ...settings,
    officialTotalTime: video.officialTotalTime !== null && video.officialTotalTime !== undefined
      ? String(video.officialTotalTime)
      : settings.officialTotalTime,
  });
  const timestamps = timestampsFromDataset(dataset.acceptedTimestamps ?? [], Number(video.duration) || undefined);

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
    zones: sanitizeZoneMap({
      startLight: zonesFromDataset.startLightZone ?? undefined,
      startBody: zonesFromDataset.startBodyZone ?? undefined,
      hold10: zonesFromDataset.hold10Zone ?? undefined,
      finishLight: zonesFromDataset.finishLightZone ?? undefined,
    }),
    startLightCalibration: sanitizeStartLightCalibration({
      beforeStartRGB: dataset.calibration?.beforeStartRGB ?? undefined,
      afterStartRGB: dataset.calibration?.afterStartRGB ?? undefined,
      calibrationFrameBeforeTime: dataset.calibration?.calibrationFrameBeforeTime ?? undefined,
      calibrationFrameAfterTime: dataset.calibration?.calibrationFrameAfterTime ?? undefined,
      colorDelta: dataset.calibration?.colorDelta ?? undefined,
    }, Number(video.duration) || undefined),
    settings: sanitizedSettings,
    timestamps,
    splitCalculations: dataset.splitCalculations ?? {},
    biomechanics: sanitizeBiomechanicsSession(dataset.biomechanics),
  };
}

function timestampsFromDataset(values: any[], durationSeconds?: number): TimestampMarker[] {
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
    existing.acceptanceMode = sanitizeAcceptanceMode(value.acceptanceMode);
  }
  return sanitizeTimestampSequence(next, durationSeconds);
}

function mergeTimestampDefaults(values: TimestampMarker[]) {
  return INITIAL_TIMESTAMPS.map((defaultMarker) => {
    const imported = values.find((item) => item?.id === defaultMarker.id);
    return {
      ...defaultMarker,
      ...imported,
      id: defaultMarker.id,
      label: defaultMarker.label,
    };
  });
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

function deduplicateAnalysisLaneCandidates(candidates: AnalysisLaneCandidate[]): AnalysisLaneCandidate[] {
  const unique: AnalysisLaneCandidate[] = [];
  for (const candidate of candidates) {
    const centerX = (candidate.zone.x1 + candidate.zone.x2) / 2;
    const centerY = (candidate.zone.y1 + candidate.zone.y2) / 2;
    const duplicate = unique.some((existing) => {
      const existingX = (existing.zone.x1 + existing.zone.x2) / 2;
      const existingY = (existing.zone.y1 + existing.zone.y2) / 2;
      return Math.hypot(centerX - existingX, centerY - existingY) < 0.035;
    });
    if (!duplicate) {
      unique.push(candidate);
    }
  }
  return unique;
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
    return parsed
      .filter(isSavedAnalysisSession)
      .map(sanitizeSavedSession)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function sanitizeSavedSession(session: SavedAnalysisSession): SavedAnalysisSession {
  const videoMetadata = sanitizeVideoMetadata(session.videoMetadata);
  return {
    ...session,
    videoMetadata,
    zones: sanitizeZoneMap(session.zones),
    startLightCalibration: sanitizeStartLightCalibration(
      session.startLightCalibration,
      videoMetadata?.duration,
    ),
    settings: sanitizeAnalysisSessionSettings(session.settings),
    timestamps: sanitizeTimestampSequence(
      mergeTimestampDefaults(session.timestamps),
      videoMetadata?.duration,
    ),
    biomechanics: sanitizeBiomechanicsSession(session.biomechanics),
  };
}

function writeSavedSessions(sessions: SavedAnalysisSession[]): string | null {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
    return null;
  } catch {
    return "The browser could not save this session locally. Export the session JSON so your analysis is not lost.";
  }
}

function isSavedAnalysisSession(value: unknown): value is SavedAnalysisSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedAnalysisSession>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
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
