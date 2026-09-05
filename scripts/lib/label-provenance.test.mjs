import { describe, expect, it } from "vitest";
import { boundaryReviewOutcome, independentBoundaryLabel } from "./label-provenance.mjs";

const labelReview = { status: "confirmed", independentOfDetector: true, reviewerId: "test-reviewer", method: "independent frame/audio annotation", reviewedAt: "2026-09-05", rawTime: 7.1 };
describe("independent label provenance", () => {
  it("does not promote legacy correctness flags or unexplained manual times to ground truth", () => {
    expect(independentBoundaryLabel({ rawTime: 7.1, reviewedCorrect: true })).toBeNull();
    expect(independentBoundaryLabel({ manualRawTime: 7.1 })).toBeNull();
  });
  it("requires confirmed independent review with an identifiable method and date", () => {
    for (const changes of [{ status: "disputed" }, { independentOfDetector: false }, { reviewerId: "" }, { method: "" }, { reviewedAt: "unknown" }, { rawTime: NaN }]) {
      expect(independentBoundaryLabel({ labelReview: { ...labelReview, ...changes } })).toBeNull();
    }
    expect(independentBoundaryLabel({ labelReview })?.rawTime).toBe(7.1);
  });
  it("scores only independently labeled observations against an explicit tolerance", () => {
    expect(boundaryReviewOutcome({ rawTime: 7.2, labelReview })).toBe("within-tolerance");
    expect(boundaryReviewOutcome({ rawTime: 7.21, labelReview })).toBe("outside-tolerance");
    expect(boundaryReviewOutcome({ rawTime: 7.1, reviewedCorrect: true })).toBe("unverified");
  });
});
