/** Legacy “reviewedCorrect” booleans are observations, not auditable labels. */
export function independentBoundaryLabel(boundary) {
  const label = boundary?.labelReview;
  if (label?.status !== "confirmed" || label.independentOfDetector !== true ||
      typeof label.reviewerId !== "string" || !label.reviewerId.trim() ||
      typeof label.method !== "string" || !label.method.trim() ||
      typeof label.reviewedAt !== "string" || !Number.isFinite(Date.parse(label.reviewedAt)) ||
      !Number.isFinite(label.rawTime) || label.rawTime < 0) return null;
  return { rawTime: label.rawTime, reviewerId: label.reviewerId, method: label.method, reviewedAt: label.reviewedAt };
}

export function boundaryReviewOutcome(boundary, toleranceSeconds = 0.1) {
  const label = independentBoundaryLabel(boundary);
  if (!label || !Number.isFinite(boundary?.rawTime)) return "unverified";
  return Math.abs(boundary.rawTime - label.rawTime) <= toleranceSeconds + 1e-9 ? "within-tolerance" : "outside-tolerance";
}
