import { parseMarkerTime } from "./video-robustness.mjs";

export function analysisFailureFromOutcome(outcome) {
  return typeof outcome?.status === "string" && /^(?:Quick Analyze|Reviewed-start analysis) stopped(?:[.:]|$)/i.test(outcome.status.trim())
    ? outcome.status.trim() : undefined;
}

export function evaluateKnownVideoFailure(testCase, outcome, mediaSha256) {
  if (!testCase?.id || !["start", "finish"].includes(testCase.boundary) ||
      !Number.isFinite(testCase.rejectedRawTime) || testCase.rejectedRawTime < 0 ||
      !Number.isFinite(testCase.toleranceSeconds) || testCase.toleranceSeconds < 0 ||
      !/^[a-f0-9]{64}$/i.test(testCase.sha256 ?? "")) throw new Error("Malformed known-video failure case.");
  const base = { caseId: testCase.id, fileName: testCase.fileName, isIndependentAccuracyLabel: false };
  if (typeof mediaSha256 !== "string" || mediaSha256.toLowerCase() !== testCase.sha256.toLowerCase()) {
    return { ...base, status: "media-mismatch", failed: true, reason: "The test recording does not match the recorded failure fingerprint." };
  }
  if (!outcome || outcome.workflow?.error || analysisFailureFromOutcome(outcome)) return { ...base, status: "workflow-error", failed: true, reason: "The video workflow did not complete." };
  if (typeof outcome.status !== "string" || !outcome.status.trim()) return { ...base, status: "unreadable-status", failed: true,
    reason: "Analysis status is missing; an unreadable result is not a verified refusal." };
  const markerText = outcome[testCase.boundary]?.rawTime;
  const acceptedRawTime = parseMarkerTime(markerText);
  if (acceptedRawTime === null && markerText !== "Not set") return { ...base, status: "unreadable-boundary", failed: true,
    reason: "The boundary state could not be read; missing UI output is not a verified refusal." };
  const repeated = acceptedRawTime !== null && Math.abs(acceptedRawTime - testCase.rejectedRawTime) <= testCase.toleranceSeconds + 1e-9;
  return { ...base, status: repeated ? "known-failure-recurred" : acceptedRawTime === null ? "guard-held" : "different-output-needs-review",
    failed: repeated, acceptedRawTime, rejectedRawTime: testCase.rejectedRawTime,
    reason: repeated ? testCase.evidence : acceptedRawTime === null ? "The known false boundary was not accepted."
      : "A different boundary was accepted; this failure test cannot establish whether the new output is correct." };
}
