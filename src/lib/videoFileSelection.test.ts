import { describe, expect, it } from "vitest";
import { validateVideoFile } from "./videoFileSelection";

describe("validateVideoFile", () => {
  it("accepts a normal browser video MIME type", () => {
    expect(validateVideoFile({ name: "attempt.mp4", type: "video/mp4", size: 120 })).toBeNull();
  });

  it("accepts videos whose browser omits or generalizes the MIME type", () => {
    expect(validateVideoFile({ name: "iphone-attempt.MOV", type: "", size: 120 })).toBeNull();
    expect(validateVideoFile({ name: "camera.webm", type: "application/octet-stream", size: 120 })).toBeNull();
  });

  it("rejects empty and clearly non-video files", () => {
    expect(validateVideoFile({ name: "empty.mov", type: "video/quicktime", size: 0 })).toContain("empty");
    expect(validateVideoFile({ name: "notes.json", type: "application/json", size: 120 })).toContain("video file");
  });
});
