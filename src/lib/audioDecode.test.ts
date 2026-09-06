import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAudioStartSignal } from "./detectAudioStartSignal";

afterEach(() => vi.unstubAllGlobals());

function audioHarness(options: {
  constructorError?: Error;
  rejectRequestedRate?: boolean;
  decodeError?: Error;
  beforeDecode?: () => void;
  closeError?: Error;
} = {}) {
  const requests: (AudioContextOptions | undefined)[] = [];
  const close = vi.fn(() => options.closeError ? Promise.reject(options.closeError) : Promise.resolve());
  const decode = vi.fn(async () => {
    options.beforeDecode?.();
    if (options.decodeError) throw options.decodeError;
    const sampleRate = requests.at(-1)?.sampleRate ?? 44_100;
    const channel = new Float32Array(sampleRate * 2);
    return { numberOfChannels: 1, length: channel.length, sampleRate, getChannelData: () => channel };
  });
  class Context {
    constructor(settings?: AudioContextOptions) {
      requests.push(settings);
      if (options.constructorError) throw options.constructorError;
      if (settings?.sampleRate && options.rejectRequestedRate) throw new DOMException("Unsupported rate", "NotSupportedError");
    }
    decodeAudioData = decode;
    close = close;
  }
  vi.stubGlobal("window", { AudioContext: Context });
  return { requests, close, decode, Context };
}

const file = (read: () => Promise<ArrayBuffer> = async () => new ArrayBuffer(8)) => ({ arrayBuffer: vi.fn(read) }) as unknown as File;
const detect = (input: File = file(), signal?: AbortSignal) => detectAudioStartSignal({ file: input, searchStart: 0, searchEnd: 2, signal });

describe("bounded-rate audio decoding and resource cleanup", () => {
  it("requests the detector's 8 kHz rate instead of allocating output-rate PCM", async () => {
    const harness = audioHarness();
    const result = await detect();
    expect(harness.requests).toEqual([{ sampleRate: 8_000 }]);
    expect(harness.decode).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(result.found).toBe(false);
  });

  it("falls back to the browser default only when the requested rate is unsupported", async () => {
    const harness = audioHarness({ rejectRequestedRate: true });
    await detect();
    expect(harness.requests).toEqual([{ sampleRate: 8_000 }, undefined]);
    expect(harness.decode).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("reports a context creation failure without retrying unrelated errors", async () => {
    const harness = audioHarness({ constructorError: new DOMException("Device unavailable", "InvalidStateError") });
    const result = await detect();
    expect(result.found).toBe(false);
    expect(result.reason).toContain("Device unavailable");
    expect(harness.requests).toHaveLength(1);
    expect(harness.decode).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("reports a file-read failure as missing audio evidence", async () => {
    const harness = audioHarness();
    const result = await detect(file(async () => { throw new Error("File no longer available"); }));
    expect(result.reason).toContain("File no longer available");
    expect(result.found).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it("closes the context when the codec cannot be decoded", async () => {
    const harness = audioHarness({ decodeError: new Error("Unsupported codec") });
    expect((await detect()).reason).toContain("Unsupported codec");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("does not let asynchronous close failure overwrite analysis", async () => {
    const harness = audioHarness({ closeError: new Error("Already closed") });
    expect((await detect()).found).toBe(false);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("does not read or allocate anything after prior cancellation", async () => {
    const harness = audioHarness();
    const input = file();
    const controller = new AbortController();
    controller.abort();
    await expect(detect(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.arrayBuffer).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(0);
  });

  it("stops before opening a context when cancelled during file reading", async () => {
    const harness = audioHarness();
    const controller = new AbortController();
    await expect(detect(file(async () => { controller.abort(); return new ArrayBuffer(8); }), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(harness.requests).toHaveLength(0);
  });

  it("closes the context and discards decoded evidence after cancellation", async () => {
    const controller = new AbortController();
    const harness = audioHarness({ beforeDecode: () => controller.abort() });
    await expect(detect(file(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("keeps cancellation identifiable even if the codec rejects at the same time", async () => {
    const controller = new AbortController();
    const harness = audioHarness({ beforeDecode: () => controller.abort(), decodeError: new Error("Decoder stopped") });
    await expect(detect(file(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("supports the prefixed browser constructor", async () => {
    const harness = audioHarness();
    vi.stubGlobal("window", { webkitAudioContext: harness.Context });
    await detect();
    expect(harness.requests).toEqual([{ sampleRate: 8_000 }]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("returns missing evidence without reading the file when Web Audio is unavailable", async () => {
    vi.stubGlobal("window", {});
    const input = file();
    expect((await detect(input)).reason).toContain("cannot decode");
    expect(input.arrayBuffer).not.toHaveBeenCalled();
  });
});
