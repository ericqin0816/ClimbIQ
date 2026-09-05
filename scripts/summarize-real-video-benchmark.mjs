import { readFile } from "node:fs/promises";
import { boundaryReviewOutcome } from "./lib/label-provenance.mjs";

const path = new URL("../benchmarks/real-video-results.json", import.meta.url);
const benchmark = JSON.parse(await readFile(path, "utf8"));
const publicPath = new URL("../benchmarks/public-broadcast-results.json", import.meta.url);
const publicBenchmark = JSON.parse(await readFile(publicPath, "utf8"));
const trials = benchmark.trials ?? [];
const acceptedStarts = trials.filter((trial) => trial.start?.status === "accepted");
const reviewedStarts = trials.filter((trial) => trial.start?.status === "review");
const knownFalseAcceptedStarts = acceptedStarts.filter((trial) => boundaryReviewOutcome(trial.start) === "outside-tolerance");
const knownCorrectAcceptedStarts = acceptedStarts.filter((trial) => boundaryReviewOutcome(trial.start) === "within-tolerance");
const labeledAcceptedStarts = knownFalseAcceptedStarts.length + knownCorrectAcceptedStarts.length;
const acceptedFinishes = trials.filter((trial) => trial.finish?.status === "accepted");
const reviewFinishes = trials.filter((trial) => trial.finish?.status === "review");
const knownFalseAcceptedFinishes = acceptedFinishes.filter((trial) => boundaryReviewOutcome(trial.finish) === "outside-tolerance");
const knownCorrectAcceptedFinishes = acceptedFinishes.filter((trial) => boundaryReviewOutcome(trial.finish) === "within-tolerance");
const labeledAcceptedFinishes = knownFalseAcceptedFinishes.length + knownCorrectAcceptedFinishes.length;
const comTrials = trials.filter((trial) => Number.isFinite(trial.com?.usableFrames) && Number.isFinite(trial.com?.requestedFrames));
const usableFrames = comTrials.reduce((sum, trial) => sum + trial.com.usableFrames, 0);
const requestedFrames = comTrials.reduce((sum, trial) => sum + trial.com.requestedFrames, 0);
const repeatedComRuns = trials.flatMap((trial) => trial.com?.repeatUsableFramesAt10Fps ?? []);

const report = {
  benchmarkVersion: benchmark.version,
  capturedAt: benchmark.capturedAt,
  videos: trials.length,
  interpretation: "Observed acceptance is not accuracy. Correct/false counts and intervals require independent label provenance and use a 0.100 s comparison policy. Zero labeled errors with zero labels is not evidence of correctness.",
  independentLabelToleranceSeconds: 0.1,
  start: {
    accepted: acceptedStarts.length,
    review: reviewedStarts.length,
    automaticAcceptanceRate: trials.length ? acceptedStarts.length / trials.length : null,
    reviewRate: trials.length ? reviewedStarts.length / trials.length : null,
    knownCorrectAccepted: knownCorrectAcceptedStarts.length,
    knownFalseAccepted: knownFalseAcceptedStarts.length,
    unverifiedAccepted: acceptedStarts.length - labeledAcceptedStarts,
    reviewedAcceptancePrecision: labeledAcceptedStarts
      ? knownCorrectAcceptedStarts.length / labeledAcceptedStarts
      : null,
    reviewedAcceptancePrecisionWilson95: wilsonInterval(
      knownCorrectAcceptedStarts.length,
      labeledAcceptedStarts,
    ),
  },
  finish: {
    accepted: acceptedFinishes.length,
    review: reviewFinishes.length,
    automaticAcceptanceRateAmongAcceptedStarts: acceptedStarts.length
      ? acceptedFinishes.length / acceptedStarts.length
      : null,
    knownCorrectAccepted: knownCorrectAcceptedFinishes.length,
    knownFalseAccepted: knownFalseAcceptedFinishes.length,
    unverifiedAccepted: acceptedFinishes.length - labeledAcceptedFinishes,
    reviewedAcceptancePrecisionWilson95: wilsonInterval(
      knownCorrectAcceptedFinishes.length,
      labeledAcceptedFinishes,
    ),
    independentlyConfirmedCorrectReviewCandidates: reviewFinishes.filter((trial) => boundaryReviewOutcome(trial.finish) === "within-tolerance").length,
    independentlyConfirmedFalseReviewCandidates: reviewFinishes.filter((trial) => boundaryReviewOutcome(trial.finish) === "outside-tolerance").length,
    unverifiedReviewCandidates: reviewFinishes.filter((trial) => boundaryReviewOutcome(trial.finish) === "unverified").length,
    disputedLegacyLabels: reviewFinishes.filter((trial) => trial.finish?.labelReview?.status === "disputed").length,
  },
  com: {
    evaluatedVideos: comTrials.length,
    usableFrames,
    requestedFrames,
    usableFrameRate: requestedFrames ? usableFrames / requestedFrames : null,
    repeatedRunRange: repeatedComRuns.length
      ? { minimumUsableFrames: Math.min(...repeatedComRuns), maximumUsableFrames: Math.max(...repeatedComRuns) }
      : null,
  },
  hold10: {
    available: trials.filter((trial) => trial.hold10?.status === "available").length,
    reviewCandidates: trials.filter((trial) => trial.hold10?.status === "review-candidate").length,
    unavailable: trials.filter((trial) => trial.hold10?.status === "unavailable").length,
  },
  publicBroadcastResearch: summarizePublicBroadcast(publicBenchmark),
};

console.log(JSON.stringify(report, null, 2));

if (knownFalseAcceptedStarts.length || knownFalseAcceptedFinishes.length) {
  process.exitCode = 1;
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) {
    return null;
  }
  const estimate = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (estimate + zSquared / (2 * total)) / denominator;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + zSquared / (4 * total)) / total) / denominator;
  return {
    lower: roundRate(Math.max(0, center - margin)),
    upper: roundRate(Math.min(1, center + margin)),
    successes,
    total,
  };
}

function roundRate(value) {
  return Math.round(value * 1000) / 1000;
}

function summarizePublicBroadcast(research) {
  const publicTrials = research.trials ?? [];
  const accepted = publicTrials.filter((trial) => trial.start?.status === "accepted");
  const reviewed = publicTrials.filter((trial) => trial.start?.status === "review");
  const comparedReactions = publicTrials.filter((trial) =>
    Number.isFinite(trial.start?.measuredReactionSeconds) && Number.isFinite(trial.start?.officialReactionSeconds),
  );
  return {
    source: research.source?.url,
    videos: publicTrials.length,
    divisions: [...new Set(publicTrials.map((trial) => trial.division).filter(Boolean))],
    acceptedStarts: accepted.length,
    reviewOnlyStarts: reviewed.length,
    knownFalseAcceptedStarts: accepted.filter((trial) => trial.start?.reviewedCorrect === false).length,
    manuallyConfirmedFalseReviewCandidates: reviewed.filter((trial) => trial.start?.reviewedCorrect === false).length,
    unverifiedReviewCandidates: reviewed.filter((trial) => trial.start?.reviewedCorrect == null).length,
    reactionCrossChecks: comparedReactions.map((trial) => ({
      id: trial.id,
      measuredSeconds: trial.start.measuredReactionSeconds,
      officialSeconds: trial.start.officialReactionSeconds,
      absoluteErrorSeconds: Math.abs(trial.start.measuredReactionSeconds - trial.start.officialReactionSeconds),
    })),
    falseFinishReviewBoundariesAfterSceneCutGuard: publicTrials.filter((trial) =>
      trial.finish?.status === "false-review-boundary",
    ).length,
  };
}
