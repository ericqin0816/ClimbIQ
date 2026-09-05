/** Match user feedback to exact source bytes; never borrow labels by filename alone. */
export function assessUserVideoReference(reference, outcome, sha256, fullWorkflow) {
  const errors = [];
  if (!reference.sourceSha256 || reference.sourceSha256 !== sha256) {
    return { referenceId: reference.id, matched: false, errors: ["User reference source checksum does not match the tested video."] };
  }
  const parse = value => typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  const start = parse(outcome.start?.rawTime), finish = parse(outcome.finish?.rawTime);
  const total = Number.isFinite(start) && Number.isFinite(finish) ? finish - start : null;
  if (fullWorkflow) for (const expected of reference.requiredHoldMarkers ?? []) {
    const marker = outcome.routeMarkers?.find(marker => marker.holdId === expected.holdId);
    if (!marker || !Number.isFinite(marker.x) || !Number.isFinite(marker.y) ||
        Math.hypot(marker.x - expected.x, marker.y - expected.y) > expected.radius) {
      errors.push(`User-corrected Hold ${expected.holdId} is missing or outside its reference region.`);
    }
  }
  return { referenceId: reference.id, matched: true, errors,
    referenceSource: reference.referenceSource,
    expectedTotalSeconds: reference.expectedTotalSeconds,
    measuredTotalSeconds: total === null ? null : Math.round(total * 1000) / 1000,
    signedTotalErrorSeconds: total === null ? null : Math.round((total - reference.expectedTotalSeconds) * 1000) / 1000,
    interpretation: "Total-only user reference; does not independently validate either raw boundary or establish a general accuracy bound." };
}
