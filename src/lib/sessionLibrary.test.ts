import { describe, expect, it } from "vitest";
import type { SavedAnalysisSession } from "../types";
import {
  createSessionLibraryBackup,
  isSessionLibraryBackup,
  mergeSessionLibraries,
} from "./sessionLibrary";

function session(id: string, updatedAt: string, name = id): SavedAnalysisSession {
  return {
    id,
    version: 1,
    name,
    climberName: "",
    date: "2026-09-02",
    location: "",
    attemptType: "Training",
    notes: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    videoMetadata: null,
    zones: {},
    startLightCalibration: {},
    settings: {
      startSearchStart: 0,
      startSearchEnd: 12,
      startSensitivity: "medium",
      startLightVisibility: "clear",
      startDetectionProfile: "auto",
      reactionTimeOffset: 0.2,
      startSignalOffset: 0,
      movementSensitivity: "medium",
      firstMovementDefinition: "earliest",
      committedLaunchMinDelay: 0.1,
      firstMovementOffset: 0,
      officialTotalTime: "",
    },
    timestamps: [],
  };
}

describe("session library backups", () => {
  it("creates a versioned portable envelope", () => {
    const sessions = [session("one", "2026-09-02T12:00:00.000Z")];
    const backup = createSessionLibraryBackup(sessions, "2026-09-02T13:00:00.000Z");

    expect(backup).toMatchObject({
      format: "climbiq-session-library",
      version: 1,
      exportedAt: "2026-09-02T13:00:00.000Z",
      sessions,
    });
    expect(isSessionLibraryBackup(backup)).toBe(true);
  });

  it("rejects unrelated and unsupported JSON envelopes", () => {
    expect(isSessionLibraryBackup(null)).toBe(false);
    expect(isSessionLibraryBackup({ format: "climbiq-session-library", version: 2, sessions: [] })).toBe(false);
    expect(isSessionLibraryBackup({ format: "something-else", version: 1, exportedAt: "now", sessions: [] })).toBe(false);
    expect(isSessionLibraryBackup({ format: "climbiq-session-library", version: 1, exportedAt: "now", sessions: {} })).toBe(false);
  });
});

describe("mergeSessionLibraries", () => {
  it("preserves local-only sessions and adds imported-only sessions", () => {
    const result = mergeSessionLibraries(
      [session("local", "2026-09-02T09:00:00.000Z")],
      [session("remote", "2026-09-02T10:00:00.000Z")],
    );

    expect(result.sessions.map((item) => item.id)).toEqual(["remote", "local"]);
    expect(result).toMatchObject({ addedCount: 1, updatedCount: 0, unchangedCount: 0 });
  });

  it("uses the newer copy when the same session exists on both computers", () => {
    const result = mergeSessionLibraries(
      [session("shared", "2026-09-02T09:00:00.000Z", "Mac copy")],
      [session("shared", "2026-09-02T11:00:00.000Z", "PC copy")],
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("PC copy");
    expect(result).toMatchObject({ addedCount: 0, updatedCount: 1, unchangedCount: 0 });
  });

  it("does not overwrite a newer local copy with an older backup", () => {
    const result = mergeSessionLibraries(
      [session("shared", "2026-09-02T12:00:00.000Z", "Mac copy")],
      [session("shared", "2026-09-02T08:00:00.000Z", "Old PC copy")],
    );

    expect(result.sessions[0].name).toBe("Mac copy");
    expect(result).toMatchObject({ addedCount: 0, updatedCount: 0, unchangedCount: 1 });
  });
});
