import { describe, expect, it } from "vitest";
import { VIDEO_VARIATIONS, assessVideoVariation, buildVideoVariationArgs, parseMarkerTime, videoVariationName } from "./video-robustness.mjs";

const label = rawTime => ({ status: "confirmed", independentOfDetector: true, reviewerId: "unit-test-fixture", method: "synthetic fixture", reviewedAt: "2026-09-05", rawTime });
const trial = { start: { status: "accepted", rawTime: 7.13, labelReview: label(7.13) }, finish: { status: "accepted", rawTime: 17.48, labelReview: label(17.48) } };
const outcome = (start, finish) => ({ start: { rawTime: start }, finish: { rawTime: finish } });

describe("controlled video robustness assessment", () => {
  it("accounts for a known trim without changing the measured duration", () => {
    const result = assessVideoVariation(trial, VIDEO_VARIATIONS[5], outcome("5.130", "15.480"));
    expect(result.boundaries.start.status).toBe("consistent");
    expect(result.boundaries.finish.status).toBe("consistent");
    expect(result.durationDeltaSeconds).toBeCloseTo(0);
    expect(result.needsInvestigation).toBe(false);
  });
  it("distinguishes a safe missing boundary from a wrong accepted boundary", () => {
    const missing = assessVideoVariation(trial, VIDEO_VARIATIONS[0], outcome("Not set", "Not set"));
    expect(missing.boundaries.start.status).toBe("availability-loss");
    expect(missing.safetyRegression).toBe(false);
    const wrong = assessVideoVariation(trial, VIDEO_VARIATIONS[0], outcome("7.130", "19.0"));
    expect(wrong.boundaries.finish.status).toBe("timing-regression");
    expect(wrong.safetyRegression).toBe(true);
  });
  it("never treats a review-only candidate as a ground truth label", () => {
    const result = assessVideoVariation({ start: { status: "review", rawTime: 8.45 } }, VIDEO_VARIATIONS[0], outcome("8.45", "Not set"));
    expect(result.boundaries.start.status).toBe("unverified-acceptance");
    expect(result.boundaries.start.labeledTime).toBeNull();
  });
  it("reports an inaccurate review suggestion without calling it a wrong acceptance", () => {
    const result = assessVideoVariation({ ...trial, finish: { ...trial.finish, status: "review" } }, VIDEO_VARIATIONS[0], {
      ...outcome("7.130", "Not set"), finishStatus: "Upper timing indicator suggests 21.480s and needs frame review.",
    });
    expect(result.boundaries.finish.reviewDeltaSeconds).toBe(4);
    expect(result.needsInvestigation).toBe(true);
    expect(result.safetyRegression).toBe(false);
  });
  it("reports withheld tracking separately from accepted timing consistency", () => {
    const result = assessVideoVariation({ ...trial, com: { usableFrames: 42, requestedFrames: 52 }, hold10: { fullWorkflowRequiresRegisteredHold: true } }, VIDEO_VARIATIONS[0], {
      ...outcome("7.130", "17.480"), workflow: { validFrames: 0, requestedFrames: 0, secondPass: { available: false } },
    });
    expect(result.boundaries.finish.status).toBe("consistent");
    expect(result.analysis.trackingStatus).toBe("availability-loss");
    expect(result.analysis.hold10TargetStatus).toBe("availability-loss");
    expect(result.safetyRegression).toBe(false);
    expect(result.needsInvestigation).toBe(true);
  });
  it("uses a separately reviewed manual timestamp rather than a known wrong candidate", () => {
    const result = assessVideoVariation({ start: { status: "review", rawTime: 8.45, labelReview: label(8.9) } }, VIDEO_VARIATIONS[0], outcome("8.90", "Not set"));
    expect(result.boundaries.start.status).toBe("new-labeled-acceptance");
  });
  it("keeps source consistency distinct from unverified absolute accuracy", () => {
    const reference = { start: { status: "accepted", rawTime: 7.13, reviewedCorrect: true } };
    const same = assessVideoVariation(reference, VIDEO_VARIATIONS[0], outcome("7.13", "Not set"));
    expect(same.boundaries.start.sourceConsistency).toBe("consistent");
    expect(same.boundaries.start.status).toBe("unverified-acceptance");
    expect(same.boundaries.start.labeledTime).toBeNull();
    const changed = assessVideoVariation(reference, VIDEO_VARIATIONS[0], outcome("8.13", "Not set"));
    expect(changed.sourceTimingRegression).toBe(true);
    expect(changed.safetyRegression).toBe(false);
  });
  it("does not accept malformed or annotated marker text", () => {
    for (const text of ["Not set", "", "7.1 wrong", "Infinity", "-1", undefined]) expect(parseMarkerTime(text)).toBeNull();
    expect(parseMarkerTime("7.130s")).toBe(7.13);
  });
  it("rejects path traversal in filenames", () => {
    for (const name of ["../secret.mov", "dir/x.mov", "C:\\video.mov"]) expect(() => videoVariationName(name, VIDEO_VARIATIONS[0])).toThrow();
    expect(videoVariationName("IMG_9199.MOV", VIDEO_VARIATIONS[0])).toBe("IMG_9199--control-720.mp4");
  });
  it("strips metadata and selects only primary audio/video without overwriting", () => {
    const args = buildVideoVariationArgs("input.mov", "output.mp4", VIDEO_VARIATIONS[0]);
    expect(args).toContain("0:a:0?");
    expect(args).toContain("-n");
    expect(args.slice(args.indexOf("-map_metadata"), args.indexOf("-map_metadata") + 2)).toEqual(["-map_metadata", "-1"]);
    const silent = buildVideoVariationArgs("input.mov", "output.mp4", VIDEO_VARIATIONS[4]);
    expect(silent).toContain("-an");
    expect(silent).not.toContain("0:a:0?");
  });
});
