import { independentBoundaryLabel } from "./label-provenance.mjs";

/** Variations preserve event time except for the explicitly recorded trim. */
export const VIDEO_VARIATIONS = Object.freeze([
  { id: "control-720", description: "720p H.264 control transcode", filter: "scale=720:-2", crf: 18, trimSeconds: 0 },
  { id: "compact-360", description: "360p with heavy compression", filter: "scale=360:-2", crf: 32, trimSeconds: 0 },
  { id: "dark-720", description: "Reduced exposure and gamma", filter: "scale=720:-2,eq=brightness=-0.035:gamma=0.65", crf: 20, trimSeconds: 0 },
  { id: "low-fps-720", description: "15 frames per second", filter: "scale=720:-2,fps=15", crf: 20, trimSeconds: 0 },
  { id: "silent-720", description: "No audio track", filter: "scale=720:-2", crf: 20, trimSeconds: 0, silent: true },
  { id: "trim-2s-720", description: "First two seconds removed", filter: "scale=720:-2", crf: 20, trimSeconds: 2 },
]);

export function videoVariationName(sourceName, variation) {
  if (!/^[\w.-]+\.(mov|mp4|m4v)$/i.test(sourceName) || sourceName.includes("..")) {
    throw new Error("Use a plain video filename, without path segments.");
  }
  if (!VIDEO_VARIATIONS.some(v => v.id === variation.id)) throw new Error("Unknown video variation.");
  return `${sourceName.replace(/\.[^.]+$/, "")}--${variation.id}.mp4`;
}

export function buildVideoVariationArgs(source, destination, variation) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", source,
    ...(variation.trimSeconds ? ["-ss", String(variation.trimSeconds)] : []),
    "-map", "0:v:0", ...(variation.silent ? ["-an"] : ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"]),
    // Explicit stream selection excludes auxiliary Apple audio/data streams;
    // strip camera/GPS metadata from all generated copies.
    "-map_metadata", "-1", "-map_chapters", "-1", "-vf", variation.filter,
    "-c:v", "libx264", "-preset", "fast", "-crf", String(variation.crf),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", destination,
  ];
}

export function parseMarkerTime(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s?$/.test(value.trim())) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

/** Never let an empty legacy assertion list hide a failed safety check. */
export function benchmarkFailureMessage(benchmark, exitCode) {
  if (exitCode === 0 && benchmark?.passed !== false) return undefined;
  const reasons = [
    ...(benchmark?.outcomes ?? []).map(outcome => outcome.workflow?.error),
    ...(benchmark?.assertions ?? []).flatMap(assertion => assertion.errors ?? []),
    ...(benchmark?.safetyAssertions ?? []).filter(assertion => assertion.failed).map(assertion => assertion.reason),
  ].filter(reason => typeof reason === "string" && reason.trim());
  return reasons.length ? reasons.join("; ") : `Workflow runner failed (exit ${exitCode}, passed=${benchmark?.passed ?? "unavailable"}).`;
}

/**
 * Metamorphic checks compare a transformed copy with the original observation.
 * A safe refusal is an availability loss, never a falsely accurate measurement.
 * Review-only source candidates are not ground truth and are not scored as such.
 */
export function assessVideoVariation(trial, variation, outcome, toleranceSeconds = 0.10) {
  const boundaries = {};
  for (const boundary of ["start", "finish"]) {
    const reference = trial[boundary];
    const observedTime = parseMarkerTime(outcome[boundary]?.rawTime);
    const referenceTime = Number.isFinite(reference?.rawTime)
      ? reference.rawTime - variation.trimSeconds : null;
    const independentLabel = independentBoundaryLabel(reference);
    const labeledTime = independentLabel ? independentLabel.rawTime - variation.trimSeconds : null;
    const sourceDeltaSeconds = observedTime !== null && referenceTime !== null ? observedTime - referenceTime : null;
    const sourceConsistency = reference?.status !== "accepted" || referenceTime === null ? "unbaselined"
      : observedTime === null ? "availability-loss"
        : Math.abs(sourceDeltaSeconds) <= toleranceSeconds + 1e-9 ? "consistent" : "source-timing-regression";
    const deltaSeconds = observedTime !== null && labeledTime !== null ? observedTime - labeledTime : null;
    const reviewText = boundary === "start" ? outcome.reviewStart : outcome.finishStatus;
    const reviewMatch = observedTime === null && typeof reviewText === "string"
      ? reviewText.match(boundary === "start" ? /\((\d+(?:\.\d+)?)s\)/ : /suggests\s+(\d+(?:\.\d+)?)s/) : null;
    const reviewTime = reviewMatch ? Number(reviewMatch[1]) : null;
    const reviewDeltaSeconds = reviewTime !== null && labeledTime !== null ? reviewTime - labeledTime : null;
    let status;
    if (observedTime === null) {
      status = reference?.status === "accepted" ? "availability-loss" : "remains-unaccepted";
    } else if (labeledTime === null || labeledTime < 0) {
      status = "unverified-acceptance";
    } else if (Math.abs(deltaSeconds) > toleranceSeconds + 1e-9) {
      status = "timing-regression";
    } else {
      status = reference?.status === "accepted" ? "consistent" : "new-labeled-acceptance";
    }
    boundaries[boundary] = { status, observedTime, referenceTime, labeledTime, deltaSeconds, reviewTime, reviewDeltaSeconds,
      sourceConsistency, sourceDeltaSeconds, labelStatus: reference?.labelReview?.status ?? "unverified" };
  }
  const start = boundaries.start;
  const finish = boundaries.finish;
  const observedDuration = start.observedTime !== null && finish.observedTime !== null
    ? finish.observedTime - start.observedTime : null;
  const referenceDuration = start.labeledTime !== null && finish.labeledTime !== null
    ? finish.labeledTime - start.labeledTime : null;
  let analysis;
  if (outcome.workflow && !outcome.workflow.error) {
    const referenceCoverage = trial.com?.requestedFrames > 0 && trial.com?.usableFrames >= 3
      ? trial.com.usableFrames / trial.com.requestedFrames : null;
    const observedCoverage = outcome.workflow.requestedFrames > 0
      ? outcome.workflow.validFrames / outcome.workflow.requestedFrames : 0;
    analysis = {
      referenceCoverage, observedCoverage,
      trackingStatus: referenceCoverage === null ? "unbaselined"
        : outcome.workflow.validFrames < 3 ? "availability-loss"
          : observedCoverage < referenceCoverage - 0.2 ? "coverage-loss" : "retained",
      hold10TargetStatus: trial.hold10?.fullWorkflowRequiresRegisteredHold
        ? outcome.workflow.secondPass?.targetSource === "visual-alignment" ? "retained" : "availability-loss"
        : "unbaselined",
    };
  }
  return {
    toleranceSeconds,
    boundaries,
    observedDuration,
    analysis,
    durationDeltaSeconds: observedDuration !== null && referenceDuration !== null ? observedDuration - referenceDuration : null,
    needsInvestigation: Object.values(boundaries).some(b => ["timing-regression", "unverified-acceptance", "availability-loss"].includes(b.status) || b.sourceConsistency === "source-timing-regression" ||
      b.reviewDeltaSeconds !== null && Math.abs(b.reviewDeltaSeconds) > toleranceSeconds + 1e-9) ||
      Boolean(analysis && (analysis.trackingStatus === "availability-loss" || analysis.trackingStatus === "coverage-loss" || analysis.hold10TargetStatus === "availability-loss")),
    safetyRegression: Object.values(boundaries).some(b => b.status === "timing-regression"),
    sourceTimingRegression: Object.values(boundaries).some(b => b.sourceConsistency === "source-timing-regression"),
  };
}
