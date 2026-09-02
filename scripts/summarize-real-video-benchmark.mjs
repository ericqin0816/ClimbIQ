import { readFile } from "node:fs/promises";

const path = new URL("../benchmarks/real-video-results.json", import.meta.url);
const benchmark = JSON.parse(await readFile(path, "utf8"));
const publicPath = new URL("../benchmarks/public-broadcast-results.json", import.meta.url);
const publicBenchmark = JSON.parse(await readFile(publicPath, "utf8"));
const trials = benchmark.trials ?? [];
const acceptedStarts = trials.filter((trial) => trial.start?.status === "accepted");
const reviewedStarts = trials.filter((trial) => trial.start?.status === "review");
const knownFalseAcceptedStarts = acceptedStarts.filter((trial) => trial.start?.reviewedCorrect === false);
const knownCorrectAcceptedStarts = acceptedStarts.filter((trial) => trial.start?.reviewedCorrect === true);
const acceptedFinishes = trials.filter((trial) => trial.finish?.status === "accepted");
const reviewFinishes = trials.filter((trial) => trial.finish?.status === "review");
const knownFalseAcceptedFinishes = acceptedFinishes.filter((trial) => trial.finish?.reviewedCorrect === false);
const knownCorrectAcceptedFinishes = acceptedFinishes.filter((trial) => trial.finish?.reviewedCorrect === true);
const comTrials = trials.filter((trial) => Number.isFinite(trial.com?.usableFrames) && Number.isFinite(trial.com?.requestedFrames));
const usableFrames = comTrials.reduce((sum, trial) => sum + trial.com.usableFrames, 0);
const requestedFrames = comTrials.reduce((sum, trial) => sum + trial.com.requestedFrames, 0);
const repeatedComRuns = trials.flatMap((trial) => trial.com?.repeatUsableFramesAt10Fps ?? []);

const report = {
  benchmarkVersion: benchmark.version,
  capturedAt: benchmark.capturedAt,
  videos: trials.length,
  start: {
    accepted: acceptedStarts.length,
    review: reviewedStarts.length,
    automaticAcceptanceRate: trials.length ? acceptedStarts.length / trials.length : null,
    reviewRate: trials.length ? reviewedStarts.length / trials.length : null,
    knownCorrectAccepted: knownCorrectAcceptedStarts.length,
    knownFalseAccepted: knownFalseAcceptedStarts.length,
    reviewedAcceptancePrecision: acceptedStarts.length
      ? knownCorrectAcceptedStarts.length / acceptedStarts.length
      : null,
    reviewedAcceptancePrecisionWilson95: wilsonInterval(
      knownCorrectAcceptedStarts.length,
      acceptedStarts.length,
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
    reviewedAcceptancePrecisionWilson95: wilsonInterval(
      knownCorrectAcceptedFinishes.length,
      acceptedFinishes.filter((trial) => trial.finish?.reviewedCorrect != null).length,
    ),
    manuallyConfirmedCorrectReviewCandidates: reviewFinishes.filter((trial) => trial.finish?.reviewedCorrect === true).length,
    manuallyConfirmedFalseReviewCandidates: reviewFinishes.filter((trial) => trial.finish?.reviewedCorrect === false).length,
    unverifiedReviewCandidates: reviewFinishes.filter((trial) => trial.finish?.reviewedCorrect == null).length,
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
