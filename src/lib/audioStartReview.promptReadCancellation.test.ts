import { afterEach, describe, expect, it, vi } from "vitest";
import { findAudioStartReview } from "./audioStartReview";

afterEach(() => vi.unstubAllGlobals());

describe("manual audio review cancellation during file I/O", () => {
  it("stops waiting before a held file read resolves and never opens a decoder", async () => {
    let release!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>(resolve => { release = resolve; });
    const file = new File([], "same-name.mp4");
    vi.spyOn(file, "arrayBuffer").mockReturnValue(bytes);
    const Constructor = vi.fn();
    vi.stubGlobal("window", { AudioContext: Constructor });
    const controller = new AbortController();
    let failure: Error | undefined;
    const pending = findAudioStartReview({ file, sourceKey: "blob:current", sourceGeneration: 1,
      searchStart: 0, searchEnd: 12, signal: controller.signal, isCurrentSource: () => true })
      .catch(error => { failure = error; });
    controller.abort();
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(failure?.name).toBe("AbortError");
      expect(Constructor).not.toHaveBeenCalled();
    } finally { release(new ArrayBuffer(0)); await pending; }
  });

  it("handles a late I/O rejection after cancellation without opening a decoder", async () => {
    let rejectRead!: (error: Error) => void;
    const bytes = new Promise<ArrayBuffer>((_, reject) => { rejectRead = reject; });
    const file = new File([], "replacement.mp4");
    vi.spyOn(file, "arrayBuffer").mockReturnValue(bytes);
    const Constructor = vi.fn();
    vi.stubGlobal("window", { AudioContext: Constructor });
    const controller = new AbortController();
    let failure: Error | undefined;
    const pending = findAudioStartReview({ file, sourceKey: "blob:current", sourceGeneration: 1,
      searchStart: 0, searchEnd: 12, signal: controller.signal, isCurrentSource: () => true })
      .catch(error => { failure = error; });
    controller.abort();
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(failure?.name).toBe("AbortError");
    } finally { rejectRead(new Error("Old read failed later")); await pending; }
    expect(Constructor).not.toHaveBeenCalled();
  });
});
