import { describe, expect, it } from "vitest";
import { evaluateValidationStudy, parseLabelWorksheet } from "./validation-study.mjs";

const sha = "a".repeat(64);
function fixture() {
  const study = { version: 1, studyId: "unit-fixture", protocol: { appCommit: "123abcd", frozenAt: "2026-10-01T00:00:00Z", splitUnit: "climberAlias", endpointToleranceSeconds: .1 },
    clips: [{ clipId: "c1", attemptId: "a1", sourceSha256: sha, durationSeconds: 8, datasetSplit: "held-out", cohort: "fixed-phone", captureSessionId: "s1", climberAlias: "p1", gymAlias: "g1", capturePhoneModel: "phone1", lane: "left", consentConfirmed: true, primaryRunId: "r1" }],
    predictions: [{ runId: "r1", clipId: "c1", sourceSha256: sha, appCommit: "123abcd", startedAt: "2026-10-02T00:00:00Z", events: {
      start: { status: "accepted", rawTime: 1.15, evidenceSource: "start-light" }, hold10: { status: "review", rawTime: 3.8 }, finish: { status: "accepted", rawTime: 6.25, evidenceSource: "pad-contact" },
    } }], observations: [] };
  const labels = [];
  for (const [event, rawTime, source] of [["start", 1, "start-light"], ["finish", 6.2, "pad-contact"]]) {
    for (const person of ["one", "two", "adjudicator"]) labels.push({ labelId: `${event}-${person}`, studyId: study.studyId, clipId: "c1", sourceSha256: sha, event,
      reviewRole: person === "adjudicator" ? "adjudicator" : "reviewer", "labelReview.status": "confirmed", "labelReview.independentOfDetector": true,
      "labelReview.reviewerId": person, "labelReview.method": "independent source-frame inspection", "labelReview.reviewedAt": "2026-10-02T00:00:00Z", "labelReview.rawTime": rawTime,
      evidenceSource: source, adjudicationReference: person === "adjudicator" ? `${event}-one;${event}-two` : "" });
  }
  return { study, labels };
}

describe("independent validation report", () => {
  it("reports endpoint error, false acceptances, coverage, and correction time separately", () => {
    const { study, labels } = fixture();
    study.observations = [{ participantAlias: "p1", captureSessionId: "s1", correctionSeconds: 0, completedImportReviewSave: true, assistanceRequired: false, voluntaryReturn: null, trainingDecision: "Replay bottom phase" },
      { participantAlias: "p1", captureSessionId: "s2", correctionSeconds: null, voluntaryReturn: true }];
    const report = evaluateValidationStudy(study, labels);
    expect(report.endpoints.start.verifiedAutomaticError.absoluteMedianSeconds).toBeCloseTo(.15);
    expect(report.endpoints.start.falseAcceptances).toMatchObject({ numerator: 1, denominator: 1, fraction: 1 });
    expect(report.endpoints.finish.falseAcceptances.numerator).toBe(0);
    expect(report.endpoints.hold10.automaticCoverage).toMatchObject({ numerator: 0, denominator: 1, fraction: 0 });
    expect(report.endpoints.hold10.needsReview).toBe(1);
    expect(report.workflow.correctionSeconds).toEqual({ measured: 1, unmeasured: 1, median: 0, p95: 0 });
    expect(report.workflow.voluntaryReturn).toMatchObject({ numerator: 1, denominator: 1 });
    expect(report.status).toBe("insufficient-evidence");
    expect(report.readiness.zeroKnownHeldOutEndpointFalseAcceptances).toBeNull();
  });
  it("cannot score predictions using one reviewer, self-labels, or a different event definition", () => {
    for (const change of [labels => labels.splice(1, 1), labels => labels[1]["labelReview.independentOfDetector"] = false,
      labels => labels[2].adjudicationReference = "start-one"]) {
      const { study, labels } = fixture(); change(labels);
      const report = evaluateValidationStudy(study, labels);
      expect(report.endpoints.start.verifiedAutomaticError.count).toBe(0);
      expect(report.endpoints.start.automaticallyAcceptedWithoutComparableReference).toBe(1);
    }
    const { study, labels } = fixture(); study.predictions[0].events.start.evidenceSource = "body-movement";
    expect(evaluateValidationStudy(study, labels).endpoints.start.mismatchedDefinitions).toBe(1);
  });
  it("keeps missing runs and unobservable events in the automatic coverage denominator", () => {
    const { study, labels } = fixture(); study.predictions = [];
    const report = evaluateValidationStudy(study, labels);
    expect(report.endpoints.start).toMatchObject({ notRun: 1, automaticCoverage: { denominator: 1, numerator: 0 } });
    expect(report.endpoints.start.falseAcceptances.fraction).toBeNull();
  });
  it("rejects a split climber, split session, mismatched hash, wrong build, or duplicate run", () => {
    for (const alter of [
      study => study.clips.push({ ...study.clips[0], clipId: "c2", attemptId: "a2", datasetSplit: "development" }),
      study => { study.protocol.splitUnit = "captureSessionId"; study.clips.push({ ...study.clips[0], clipId: "c2", attemptId: "a2", climberAlias: "p2", datasetSplit: "development" }); },
      study => study.predictions[0].sourceSha256 = "b".repeat(64),
      study => study.predictions[0].appCommit = "abcdef0",
      study => study.predictions.push(study.predictions[0]),
    ]) {
      const { study, labels } = fixture(); alter(study);
      expect(() => evaluateValidationStudy(study, labels)).toThrow();
    }
  });
  it("never counts derivatives as additional independent attempts", () => {
    const { study, labels } = fixture();
    study.clips.push({ ...study.clips[0], clipId: "crop", parentClipId: "c1", primaryRunId: "crop-run", sourceSha256: "b".repeat(64) });
    const report = evaluateValidationStudy(study, labels);
    expect(report.counts).toMatchObject({ independentAttempts: 1, derivativesExcluded: 1, heldOutSupportedAttempts: 1 });
    study.clips[1].parentClipId = "unknown";
    expect(() => evaluateValidationStudy(study, labels)).toThrow(/parent/);
  });
  it("requires explicit permissions, frozen protocol, primary run, and original label identity", () => {
    for (const alter of [
      study => study.clips[0].consentConfirmed = false,
      study => study.protocol.appCommit = "",
      study => study.clips[0].primaryRunId = "",
      study => study.predictions[0].startedAt = "2026-09-01",
    ]) {
      const { study, labels } = fixture(); alter(study);
      expect(() => evaluateValidationStudy(study, labels)).toThrow();
    }
    const { study, labels } = fixture(); labels[0].sourceSha256 = "b".repeat(64);
    expect(() => evaluateValidationStudy(study, labels)).toThrow(/hash/);
  });
  it("an empty prepared study reports awaiting data, with no fabricated success", () => {
    const { study } = fixture(); study.clips = []; study.predictions = [];
    const report = evaluateValidationStudy(study, []);
    expect(report.status).toBe("awaiting-data");
    expect(report.endpoints.start.automaticCoverage.fraction).toBeNull();
    expect(report.endpoints.start.verifiedAutomaticError.absoluteMedianSeconds).toBeNull();
  });
});

describe("label worksheet parsing", () => {
  it("preserves quoted methods, blank times, false declarations, and real zero times", () => {
    const rows = parseLabelWorksheet('labelId,labelReview.rawTime,labelReview.method,labelReview.independentOfDetector\r\na,0,"frame, audio\nsecond line",true\r\nb,,"said ""uncertain""",false\r\n');
    expect(rows[0]).toMatchObject({ "labelReview.rawTime": 0, "labelReview.method": "frame, audio\nsecond line", "labelReview.independentOfDetector": true });
    expect(rows[1]).toMatchObject({ "labelReview.rawTime": null, "labelReview.method": 'said "uncertain"', "labelReview.independentOfDetector": false });
    expect(parseLabelWorksheet("labelId,clipId\n")).toEqual([]);
  });
  it.each(['a,a\n1,2', 'a,b\n1', 'a\n"unclosed', 'a\n"closed"extra', 'labelReview.rawTime\nNaN', 'labelReview.independentOfDetector\nyes'])("rejects malformed worksheet %s", input => {
    expect(() => parseLabelWorksheet(input)).toThrow();
  });
});
