import { describe, expect, it } from "vitest";
import { resolveNewVideoSessionName, validateVideoFile } from "./videoFileSelection";

describe("validateVideoFile", () => {
  it("updates the generated title when uploading the next recording", () => {
    expect(resolveNewVideoSessionName("IMG_9199", "IMG_9199.MOV", "IMG_8903.MOV")).toBe("IMG_8903");
    expect(resolveNewVideoSessionName("Untitled climb analysis", undefined, "attempt.2.mp4")).toBe("attempt.2");
    expect(resolveNewVideoSessionName("  ", undefined, "attempt.mov")).toBe("attempt");
  });
  it("keeps a user-written session title", () => {
    expect(resolveNewVideoSessionName("Training with coach", "IMG_9199.MOV", "IMG_8903.MOV")).toBe("Training with coach");
  });
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
