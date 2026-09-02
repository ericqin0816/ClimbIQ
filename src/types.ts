export type ZoneId = "startLight" | "startBody" | "hold10" | "finishLight";

export type Sensitivity = "low" | "medium" | "high";

export type Confidence = "High" | "Medium" | "Low" | "None";

export type StartDetectionProfile = "auto" | "calibrated" | "generic" | "blocked" | "motion" | "manual";

export type FirstMovementDefinition = "earliest" | "committed";

export type TimestampSource =
  | "Not set"
  | "Manual"
  | "Start light detection"
  | "Fused start detection"
  | "Motion-based estimate"
  | "Body motion detection"
  | "Finish light detection"
  | "Official total time"
  | "COM halfway estimate"
  | "Hold contact detection"
  | "Future / experimental";

export interface NormalizedZone {
  id: ZoneId;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface VideoMetadata {
  fileName: string;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  metadataLoaded: boolean;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface FrameSample {
  requestedTime: number;
  actualTime: number;
  averageRgb: RGB;
  success: boolean;
  error?: string;
}

export interface FrameSamplingDebug {
  videoElementFound: boolean;
  metadataLoaded: boolean;
  duration: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  framesRequested: number;
  framesSampled: number;
  canvasDrawSucceeded: boolean;
  pixelDataReadSucceeded: boolean;
  samples: FrameSample[];
  errors: string[];
}

export interface ZonePixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StartSignalDebug {
  zoneExists: boolean;
  normalizedZone?: NormalizedZone;
  pixelZone?: ZonePixelRect;
  framesSampled: number;
  baselineRgb?: RGB;
  calibration?: StartLightCalibration;
  detectionMethod?: string;
  maxColorDistance: number;
  threshold: number;
  detectedCrossings: Array<{ time: number; colorDistance: number }>;
  firstThresholdCrossingTime?: number;
  strongestSignalTime?: number;
  selectedCandidateTime?: number;
  selectedCandidateReason?: string;
  topCandidates?: DetectionCandidate[];
  detectedRawTime?: number;
  failureReason?: string;
  sceneContinuity?: {
    assessable: boolean;
    continuous: boolean;
    structuralChangeRatio: number;
    reason: string;
  };
  samples: Array<{
    time: number;
    averageRgb: RGB;
    colorDistance: number;
    smoothedColorDistance?: number;
    deltaFromPrevious?: number;
    distanceToBefore?: number;
    distanceToAfter?: number;
    afterScore?: number;
    greenScore: number;
    blueScore: number;
  }>;
}

export interface StartLightCalibration {
  beforeStartRGB?: RGB;
  afterStartRGB?: RGB;
  colorDelta?: number;
  calibrationFrameBeforeTime?: number;
  calibrationFrameAfterTime?: number;
}

export interface DetectionCandidate {
  rawTime: number;
  climbTime?: number;
  confidence: Confidence;
  reason: string;
  score: number;
  kind: string;
  method?: string;
  rgb?: RGB;
  distanceToBefore?: number;
  distanceToAfter?: number;
  detectedMovementRawTime?: number;
  reactionOffset?: number;
  suspiciousFirstFrame?: boolean;
  preloadFlag?: boolean;
  boundaryRisk?: boolean;
  persistenceFrames?: number;
}

export interface StartSignalDetectionResult {
  detected: boolean;
  rawTime?: number;
  confidence: Confidence;
  reason: string;
  threshold: number;
  debug: StartSignalDebug;
  candidates?: DetectionCandidate[];
}

export interface MotionSample {
  time: number;
  motionScore: number;
  smoothedMotionScore: number;
}

export interface FirstMovementDebug {
  zoneExists: boolean;
  normalizedZone?: NormalizedZone;
  pixelZone?: ZonePixelRect;
  startSignalRawTime?: number;
  searchWindowStart?: number;
  searchWindowEnd?: number;
  zoneAreaPercentage?: number;
  committedLaunchMinDelay?: number;
  sampleRateFps?: number;
  frameInterval?: number;
  firstSampledTimeAfterStart?: number;
  detectedTimeAfterStart?: number;
  earliestMotionThreshold?: number;
  committedLaunchThreshold?: number;
  framesSampled: number;
  baselineMotion?: number;
  maxMotion: number;
  fixedThreshold?: number;
  dynamicThreshold?: number;
  threshold: number;
  firstThresholdCrossingTime?: number;
  topMotionSpikes?: DetectionCandidate[];
  topMotionPeaks?: Array<{ rawTime: number; climbTime: number; motionScore: number }>;
  movementSegments?: Array<{
    startTime: number;
    endTime: number;
    duration: number;
    maxMotion: number;
    averageMotion: number;
    totalMotion: number;
  }>;
  selectedCandidateTime?: number;
  selectedCandidateKind?: string;
  suspiciousFirstFrameDetection?: boolean;
  movementAlreadyUnderway?: boolean;
  firstSampleMotion?: number;
  firstSampleToMaxRatio?: number;
  preStartMotionDetected?: boolean;
  detectedSpikes: Array<{ time: number; motionScore: number }>;
  detectedRawTime?: number;
  failureReason?: string;
  samples: MotionSample[];
}

export interface FirstMovementDetectionResult {
  detected: boolean;
  rawTime?: number;
  climbTime?: number;
  confidence: Confidence;
  reason: string;
  threshold: number;
  debug: FirstMovementDebug;
  candidates?: DetectionCandidate[];
}

export interface TimestampMarker {
  id: "startSignal" | "firstMovement" | "committedLaunch" | "firstHold" | "hold10" | "finishPad";
  label: string;
  rawTime: number | null;
  climbTime: number | null;
  detectedRawTime?: number | null;
  offsetApplied?: number;
  note?: string;
  source: TimestampSource;
  confidence: Confidence;
}

export interface AnalysisSessionSettings {
  startSearchStart: number;
  startSearchEnd: number;
  startSensitivity: Sensitivity;
  startLightVisibility: "clear" | "blocked";
  startDetectionProfile: StartDetectionProfile;
  reactionTimeOffset: number;
  startSignalOffset: number;
  movementSensitivity: Sensitivity;
  firstMovementDefinition: FirstMovementDefinition;
  committedLaunchMinDelay: number;
  firstMovementOffset: number;
  officialTotalTime: string;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface WallPoint {
  xMeters: number;
  yMeters: number;
}

export type WallCornerId = "bottomLeft" | "bottomRight" | "topRight" | "topLeft";

export interface WallCalibrationCorner {
  id: WallCornerId;
  label: string;
  image: NormalizedPoint;
  wall: WallPoint;
}

export interface WallCalibration {
  version: 1;
  frameRawTime: number;
  widthMeters: number;
  heightMeters: number;
  corners: WallCalibrationCorner[];
  staticCameraConfirmed: boolean;
  /** Manual corner marking or an approximate lane inferred from a video frame. */
  source?: "manual" | "automatic-approximate";
  /** Automatic calibration is intentionally never presented as manual-quality. */
  confidence?: "High" | "Medium" | "Low";
  reason?: string;
}

export interface PoseLandmarkPoint extends NormalizedPoint {
  index: number;
  z: number;
  visibility: number;
}

export interface BiomechanicsFrame {
  rawTime: number;
  climbTime: number;
  /** True when MediaPipe returned at least one pose before identity filtering. */
  poseDetected: boolean;
  /** True when a pose was safely associated with the climber for this frame. */
  poseSelected?: boolean;
  /** Raw pose candidates returned for this frame, before identity filtering. */
  poseCandidateCount?: number;
  landmarks: PoseLandmarkPoint[];
  imageCom?: NormalizedPoint;
  wallCom?: WallPoint;
  smoothedWallCom?: WallPoint;
  massCoverage: number;
  meanVisibility: number;
  velocityXMps?: number;
  velocityYMps?: number;
  speedMps?: number;
  verticalSpeedMps?: number;
  extrapolated?: boolean;
  valid: boolean;
  warning?: string;
}

export type BiomechanicsQuality = "High" | "Medium" | "Needs review";

export interface BiomechanicsMetrics {
  requestedFrames: number;
  /** Frames where the model found at least one person. */
  detectedFrames: number;
  /** Frames where a detected person was associated with the climber. */
  selectedFrames?: number;
  validFrames: number;
  /** Raw person-detection coverage before identity filtering. */
  detectionCoverage?: number;
  /** Safely selected climber coverage. */
  trackingCoverage: number;
  validCoverage: number;
  meanMassCoverage: number;
  averageSpeedMps?: number;
  peakSpeedMps?: number;
  verticalGainMeters?: number;
  pathLengthMeters?: number;
  pathEfficiency?: number;
  quality: BiomechanicsQuality;
}

export interface BiomechanicsSettings {
  sampleFps: number;
  minVisibility: number;
  minMassCoverage: number;
  smoothingWindowSeconds: number;
  anthropometricModel: "athletevision-published-male-reference";
}

export interface BiomechanicsResult {
  version: 1;
  createdAt: string;
  method: "MediaPipe Pose Landmarker";
  model: "Pose Landmarker Full";
  modelVersion: "float16/1";
  coordinateSystem: "calibrated-wall-plane";
  startRawTime: number;
  endRawTime: number;
  identityZone?: NormalizedZone;
  settings: BiomechanicsSettings;
  frames: BiomechanicsFrame[];
  metrics: BiomechanicsMetrics;
  warnings: string[];
}

export interface BiomechanicsSession {
  version: 1;
  calibration?: WallCalibration;
  settings: BiomechanicsSettings;
  result?: BiomechanicsResult;
}

export interface SavedAnalysisSession {
  id: string;
  version: 1;
  name: string;
  climberName: string;
  date: string;
  location: string;
  attemptType: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  videoFileName?: string;
  videoMetadata: VideoMetadata | null;
  zones: Partial<Record<ZoneId, NormalizedZone>>;
  startLightCalibration: StartLightCalibration;
  settings: AnalysisSessionSettings;
  timestamps: TimestampMarker[];
  splitCalculations?: Record<string, number | null>;
  biomechanics?: BiomechanicsSession;
}

export interface DetectionDebugReport {
  videoMetadata: VideoMetadata | null;
  zones: Partial<Record<ZoneId, NormalizedZone>>;
  frameSamplingTest: FrameSamplingDebug | null;
  startSignalDetection: StartSignalDebug | null;
  firstMovementDetection: FirstMovementDebug | null;
  finishSignalDetection: StartSignalDebug | null;
  acceptedTimestamps: TimestampMarker[];
}
