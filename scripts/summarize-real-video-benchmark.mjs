import { readFile } from "node:fs/promises";

const path = new URL("../benchmarks/real-video-results.json", import.meta.url);
const benchmark = JSON.parse(await readFile(path, "utf8"));
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
  },
  hold10: {
    available: trials.filter((trial) => trial.hold10?.status === "available").length,
    unavailable: trials.filter((trial) => trial.hold10?.status === "unavailable").length,
  },
};

console.log(JSON.stringify(report, null, 2));

if (knownFalseAcceptedStarts.length || knownFalseAcceptedFinishes.length) {
  process.exitCode = 1;
}
