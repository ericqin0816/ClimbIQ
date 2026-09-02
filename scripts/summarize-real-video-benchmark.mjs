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
    knownCorrectAccepted: knownCorrectAcceptedStarts.length,
    knownFalseAccepted: knownFalseAcceptedStarts.length,
    reviewedAcceptancePrecision: acceptedStarts.length
      ? knownCorrectAcceptedStarts.length / acceptedStarts.length
      : null,
  },
  finish: {
    accepted: acceptedFinishes.length,
    review: reviewFinishes.length,
    knownFalseAccepted: knownFalseAcceptedFinishes.length,
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
    knownFalseReviewCandidates: reviewed.filter((trial) => trial.start?.reviewedCorrect === false).length,
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
