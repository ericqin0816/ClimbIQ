import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoPreparer } from "./preparedVideo";

class CandidateVideo extends EventTarget {
  duration = 8;
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 0;
  error: { code: number } | null = null;
  src = "";
  muted = false;
  playsInline = false;
  preload = "";
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
  emit(type: string, readyState = this.readyState) {
    this.readyState = readyState;
    this.dispatchEvent(new Event(type));
  }
}

function fixture() {
  const video = new CandidateVideo();
  const context = { drawImage: vi.fn(), getImageData: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => "data:image/jpeg;base64,preview") };
  const createObjectUrl = vi.fn(() => "blob:candidate");
  const revokeObjectUrl = vi.fn();
  const prepare = createVideoPreparer({
    createVideo: () => video as unknown as HTMLVideoElement,
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    createObjectUrl,
    revokeObjectUrl,
    timeoutMs: 100,
  });
  const file = new File(["synthetic movie bytes"], "attempt.mp4", { type: "video/mp4" });
  return { video, context, canvas, createObjectUrl, revokeObjectUrl, prepare, file };
}

afterEach(() => vi.useRealTimers());

describe("detached video preparation", () => {
  it("waits for a decoded frame, preserves its dimensions, and bounds thumbnail memory", async () => {
    const { video, context, canvas, prepare, file, revokeObjectUrl } = fixture();
    const result = prepare(file);
    let resolved = false;
    void result.then(() => { resolved = true; });
    video.emit("loadedmetadata", 1);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(context.drawImage).not.toHaveBeenCalled();
    video.emit("loadeddata", 2);
    const prepared = await result;
    expect(prepared.metadata).toEqual({ fileName: file.name, duration: 8, videoWidth: 1920, videoHeight: 1080, metadataLoaded: true });
    expect(prepared.file).toBe(file);
    expect([canvas.width, canvas.height]).toEqual([240, 135]);
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(prepared.previewDataUrl).toBe("data:image/jpeg;base64,preview");
    expect(video.src).toBe("");
    expect(video.pause).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    prepared.dispose();
    prepared.dispose();
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:candidate");
  });

  it("does not upscale small video thumbnails or revoke a successful URL on later cancellation", async () => {
    const { video, canvas, prepare, file, revokeObjectUrl } = fixture();
    video.videoWidth = 80;
    video.videoHeight = 100;
    const controller = new AbortController();
    const result = prepare(file, { signal: controller.signal });
    video.emit("loadeddata", 2);
    const prepared = await result;
    controller.abort();
    expect([canvas.width, canvas.height]).toEqual([80, 100]);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    prepared.dispose();
  });

  it("rejects invalid files and an already cancelled selection before allocating a URL", async () => {
    const { prepare, file, createObjectUrl } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(prepare(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(prepare(new File([], "empty.mp4"))).rejects.toThrow("empty");
    await expect(prepare(new File(["hi"], "notes.txt"))).rejects.toThrow("video file");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("releases a cancelled candidate once and ignores a late decoded frame", async () => {
    const { video, prepare, file, revokeObjectUrl, context } = fixture();
    const controller = new AbortController();
    const result = prepare(file, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    video.emit("loadedmetadata", 1);
    controller.abort();
    video.emit("loadeddata", 2);
    await rejected;
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:candidate");
    expect(video.src).toBe("");
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it("rejects a decoder error after metadata without claiming the recording opened", async () => {
    const { video, prepare, file, revokeObjectUrl } = fixture();
    const result = prepare(file);
    const rejected = expect(result).rejects.toThrow("could not be decoded");
    video.emit("loadedmetadata", 1);
    video.error = { code: 3 };
    video.emit("error");
    await rejected;
    expect(video.src).toBe("");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });

  it("bounds a stalled decoder and clears its timeout after failure", async () => {
    vi.useFakeTimers();
    const { video, prepare, file, revokeObjectUrl } = fixture();
    const result = prepare(file);
    const rejected = expect(result).rejects.toThrow("took too long");
    video.emit("loadedmetadata", 1);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    video.emit("error");
    expect(vi.getTimerCount()).toBe(0);
    expect(video.src).toBe("");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });

  it.each(["duration", "videoWidth", "videoHeight"] as const)("refuses invalid %s before adopting a candidate", async field => {
    const { video, prepare, file, revokeObjectUrl } = fixture();
    video[field] = Number.NaN;
    const result = prepare(file);
    const rejected = expect(result).rejects.toThrow("no usable duration or video dimensions");
    video.emit("loadedmetadata", 1);
    await rejected;
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });

  it("does not adopt an unreadable canvas frame even when the decoder says ready", async () => {
    const { video, context, prepare, file, revokeObjectUrl } = fixture();
    context.getImageData.mockImplementation(() => { throw new Error("Cannot access decoded pixels"); });
    const result = prepare(file);
    const rejected = expect(result).rejects.toThrow("could not be decoded");
    video.emit("loadeddata", 2);
    await rejected;
    expect(video.src).toBe("");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });

  it("cleans up after a synchronous decoder failure without masking it with cleanup errors", async () => {
    const { video, prepare, file, revokeObjectUrl } = fixture();
    video.load.mockImplementation(() => { throw new Error("Unsupported decoder"); });
    video.pause.mockImplementation(() => { throw new Error("Decoder already closed"); });
    await expect(prepare(file)).rejects.toThrow("could not be decoded");
    expect(video.src).toBe("");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });
});
