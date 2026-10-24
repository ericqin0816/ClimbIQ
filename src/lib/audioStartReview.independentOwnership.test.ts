import { afterEach, describe, expect, it, vi } from "vitest";
import { findAudioStartReview } from "./audioStartReview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const original = new File(["same metadata"], "same-name.mp4", { lastModified: 123 });
  const state = { file: original, key: "blob:exact-source", generation: 9, window: "0:4" };
  return { original, state, options: { file: original, sourceKey: state.key, sourceGeneration: state.generation,
    searchStart: 0, searchEnd: 4,
    isCurrentSource: (file: File, key: string, generation: number) =>
      file === state.file && key === state.key && generation === state.generation && state.window === "0:4" } };
}
function decoded(): AudioBuffer {
  return { sampleRate: 8_000, numberOfChannels: 1, length: 32_000, getChannelData: () => new Float32Array(32_000) } as unknown as AudioBuffer;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("independent manual audio ownership review", () => {
  it("rejects a same-name, same-size replacement during file I/O before creating a decoder", async () => {
    const test = setup(), bytes = deferred<ArrayBuffer>(), Constructor = vi.fn();
    vi.spyOn(test.original, "arrayBuffer").mockReturnValue(bytes.promise);
    vi.stubGlobal("window", { AudioContext: Constructor });
    const pending = findAudioStartReview(test.options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    test.state.file = new File(["same metadata"], "same-name.mp4", { lastModified: 123 });
    expect(test.state.file.size).toBe(test.original.size);
    bytes.resolve(new ArrayBuffer(1));
    await rejected;
    expect(Constructor).not.toHaveBeenCalled();
  });

  it("honors a changed caller window while the exact File and URL remain unchanged", async () => {
    const test = setup(), bytes = deferred<ArrayBuffer>(), Constructor = vi.fn();
    vi.spyOn(test.original, "arrayBuffer").mockReturnValue(bytes.promise);
    vi.stubGlobal("window", { AudioContext: Constructor });
    const pending = findAudioStartReview(test.options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    test.state.window = "3:7";
    bytes.resolve(new ArrayBuffer(1));
    await rejected;
    expect(Constructor).not.toHaveBeenCalled();
  });

  it("absorbs a decoder's late rejection after cancellation and closes only its owned context", async () => {
    const test = setup(), decoding = deferred<AudioBuffer>(), controller = new AbortController();
    const close = vi.fn(async () => undefined), decode = vi.fn(() => decoding.promise);
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { close, decodeAudioData: decode }; }) });
    const pending = findAudioStartReview({ ...test.options, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    decoding.reject(new Error("Decoder failed after owner cancelled"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledOnce();
  });

  it("checks ownership after progress callbacks before starting the decoder", async () => {
    const test = setup(), controller = new AbortController(), close = vi.fn(async () => undefined), decode = vi.fn(async () => decoded());
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { close, decodeAudioData: decode }; }) });
    await expect(findAudioStartReview({ ...test.options, signal: controller.signal, onProgress: () => controller.abort() }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(decode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not publish an otherwise finished result after a window changes during held cleanup", async () => {
    const test = setup(), cleanup = deferred<void>(), close = vi.fn(() => cleanup.promise);
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { close, decodeAudioData: async () => decoded() }; }) });
    const pending = findAudioStartReview(test.options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    test.state.window = "3:7";
    cleanup.resolve();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });
});
