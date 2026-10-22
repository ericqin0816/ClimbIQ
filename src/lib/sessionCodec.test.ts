import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS_SESSION_SETTINGS } from "./analysisSettings";
import { datasetToSavedSession, decodeSavedSession, isSavedAnalysisSession, sanitizeSavedSession, todayDateString } from "./sessionCodec";

const legacySession = () => ({
  id: "legacy-attempt", version: 1, name: "Evening training", createdAt: "2026-10-22T21:00:00Z", updatedAt: "2026-10-22T21:00:00Z",
  settings: { ...DEFAULT_ANALYSIS_SESSION_SETTINGS }, timestamps: [],
});
const dataset = () => ({ appVersion: "0.30.0", session: {}, acceptedTimestamps: [] });

describe("saved session scalar boundaries", () => {
  it.each(["climberName", "date", "location", "attemptType", "notes", "videoFileName"])("rejects malformed %s before it can enter the saved library", field => {
    for (const value of [42, false, [], {}]) {
      const imported = { ...legacySession(), [field]: value };
      expect(isSavedAnalysisSession(imported)).toBe(false);
      expect(decodeSavedSession(imported)).toBeNull();
    }
  });

  it("normalizes missing legacy text while preserving explicitly empty strings and safe evidence", () => {
    const restored = decodeSavedSession(legacySession());
    expect(restored).toMatchObject({ climberName: "", location: "", attemptType: "Training", notes: "", zones: {}, videoMetadata: null });
    expect(restored?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(restored?.analysisBuild).toBeUndefined();
    expect(decodeSavedSession({ ...legacySession(), climberName: null, location: null, notes: null })).toMatchObject({ climberName: "", location: "", notes: "" });
    const withText = decodeSavedSession({ ...legacySession(), climberName: " Alex ", location: "", attemptType: "", notes: "Good start", videoFileName: "attempt.mp4" });
    expect(withText).toMatchObject({ climberName: " Alex ", location: "", attemptType: "", notes: "Good start", videoFileName: "attempt.mp4" });
    expect(() => [withText!.climberName, withText!.location, withText!.attemptType, withText!.notes].map(text => text.trim())).not.toThrow();
  });

  it("does not preserve unsupported properties or malformed numeric split values", () => {
    const restored = decodeSavedSession({ ...legacySession(), unexpected: { notes: 42 }, splitCalculations: { total: 8.3, missing: null, invalid: "7", nonfinite: Infinity } });
    expect(restored).not.toHaveProperty("unexpected");
    expect(restored?.splitCalculations).toEqual({ total: 8.3, missing: null });
  });

  it("preserves valid analysis provenance without assigning the importing build", () => {
    const analysisBuild = { schemaVersion: 1, appVersion: "0.29.0", commitSha: "a".repeat(40), workingTreeDirty: false };
    expect(decodeSavedSession({ ...legacySession(), analysisBuild })?.analysisBuild).toEqual(analysisBuild);
    expect(decodeSavedSession({ ...legacySession(), analysisBuild: { bad: true } })?.analysisBuild).toBeUndefined();
  });
});

describe("dataset text fields", () => {
  it.each(["sessionId", "sessionName", "climberName", "date", "location", "gym", "attemptType", "notes"])("rejects malformed dataset %s", field => {
    expect(() => datasetToSavedSession({ ...dataset(), session: { [field]: { invalid: true } } })).toThrow("must be text");
  });

  it("validates filename, note, and timestamp aliases instead of silently coercing objects", () => {
    expect(() => datasetToSavedSession({ ...dataset(), video: { fileName: 42 } })).toThrow("video filename must be text");
    expect(() => datasetToSavedSession({ ...dataset(), athleteNotes: [] })).toThrow("athlete notes must be text");
    expect(() => datasetToSavedSession({ ...dataset(), exportTimestamp: 42 })).toThrow("export timestamp must be text");
  });

  it("supports old aliases, tolerates invalid marker entries, and carries only the analysis build", () => {
    const analysisBuild = { schemaVersion: 1, appVersion: "0.29.0", commitSha: null, workingTreeDirty: null };
    const imported = datasetToSavedSession({ ...dataset(), session: { gym: "Local gym" }, athleteNotes: "Keep this", analysisBuild,
      exportBuild: { schemaVersion: 1, appVersion: "0.30.0", commitSha: "b".repeat(40), workingTreeDirty: false }, acceptedTimestamps: [null, 4] });
    expect(imported).toMatchObject({ name: "Imported ClimbIQ session", location: "Local gym", notes: "Keep this", analysisBuild });
    expect(sanitizeSavedSession(imported).climberName).toBe("");
    expect(datasetToSavedSession(dataset()).analysisBuild).toBeUndefined();
  });

  it("retains accepted source, review mode, and raw timing when converting dataset markers", () => {
    const imported = datasetToSavedSession({ ...dataset(), video: { fileName: "attempt.mp4", duration: 20, videoWidth: 1920, videoHeight: 1080 },
      acceptedTimestamps: [
        { markerId: "startSignal", acceptedRawTime: 1, source: "Manual", confidence: "High", acceptanceMode: "frame-review" },
        { markerId: "finishPad", acceptedRawTime: 9.5, source: "Finish light detection", confidence: "Medium", acceptanceMode: "automatic", note: "Detected finish", observationIntervalSeconds: .04 },
      ] });
    expect(imported.timestamps.find(marker => marker.id === "startSignal")).toMatchObject({ rawTime: 1, source: "Manual", confidence: "High", acceptanceMode: "frame-review" });
    expect(imported.timestamps.find(marker => marker.id === "finishPad")).toMatchObject({ rawTime: 9.5, source: "Finish light detection", confidence: "Medium", acceptanceMode: "automatic", note: "Detected finish", observationIntervalSeconds: .04 });
  });
});

describe("local recording date", () => {
  it.each([
    ["America/Chicago", "2026-10-23T01:30:00Z", "2026-10-22"],
    ["America/Chicago", "2026-10-23T05:30:00Z", "2026-10-23"],
    ["Pacific/Auckland", "2026-10-22T11:30:00Z", "2026-10-23"],
    ["Pacific/Auckland", "2026-10-22T10:30:00Z", "2026-10-22"],
  ])("uses the device calendar in %s at %s", (timeZone, instant, expected) => {
    // Run the actual formatter in a fresh timezone process; worker timezone
    // changes behave differently across platforms and must not affect other tests.
    const script = `const format = ${todayDateString.toString()}; process.stdout.write(format(new Date(process.argv[1])));`;
    const actual = execFileSync(process.execPath, ["-e", script, instant], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" });
    expect(actual).toBe(expected);
  });
});
