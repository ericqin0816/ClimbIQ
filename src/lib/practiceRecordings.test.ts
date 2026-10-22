import { describe, expect, it } from "vitest";
import { createPracticeSession } from "./practiceRecordings";

describe("practice recording dates", () => {
  it.each([{ day: 22, hour: 23, expected: "2026-10-22" }, { day: 23, hour: 0, expected: "2026-10-23" }])(
    "uses the device's local training date at local hour $hour while retaining UTC timestamps", ({ day, hour, expected }) => {
      const instant = new Date(2026, 9, day, hour, 30, 0);
      const practice = createPracticeSession("a", instant);
      expect(practice.date).toBe(expected);
      expect(practice.createdAt).toBe(instant.toISOString());
      expect(practice.updatedAt).toBe(practice.createdAt);
      expect(practice.analysisBuild).toBeUndefined();
    });
});
