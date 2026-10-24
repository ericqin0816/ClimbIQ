import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeAudioChannelWindow, extractAudioToneComponents } from "./detectAudioStartSignal";
import { analyzeAudioStartReviewWindow, findAudioStartReview } from "./audioStartReview";

const RATE = 8_000;
function tones(frequencies = [880, 880, 1760], times = [.8, 1.8, 2.8], length = 4, amplitude = .3, rate = RATE, finalDuration = .16) {
  const samples = new Float32Array(Math.round(length * rate));
  frequencies.forEach((frequency, beep) => {
    const start = Math.round(times[beep] * rate), size = Math.round((beep === 2 ? finalDuration : .16) * rate);
    for (let index = 0; index < size; index++) samples[start + index] += amplitude * Math.sin(2 * Math.PI * frequency * index / rate) *
      Math.min(1, index / (rate * .005), (size - index) / (rate * .005));
  });
  return samples;
}

function source() {
  const current = { file: new File(["original bytes"], "attempt.mp4"), key: "blob:recording", generation: 7 };
  return { current, options: {
    file: current.file, sourceKey: current.key, sourceGeneration: current.generation,
    isCurrentSource: (file: File, key: string, generation: number) => file === current.file && key === current.key && generation === current.generation,
  } };
}

function windowOptions(samples: Float32Array, binding = source()) {
  return { ...binding.options, channels: [samples, samples], sourceSampleRate: RATE, startFrame: 0, endFrame: samples.length, timeOffset: 0 };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("manual recorded-tone navigation", () => {
  it("returns one bounded proposal with explicit navigation authority and exact source ownership", async () => {
    const binding = source(), result = await analyzeAudioStartReviewWindow(windowOptions(tones(), binding));
    expect(result.proposal).toMatchObject({ confidence: "Medium", authority: "navigation-only", automaticVoteAllowed: false, searchHintTime: null, profile: "secondary-880-1760" });
    expect(result.proposal!.rawTime).toBeCloseTo(2.79, 2);
    expect(result.proposal!.sequence).toHaveLength(3);
    expect(result.source.file).toBe(binding.options.file);
    expect(result.source.sourceGeneration).toBe(7);
    expect(result).not.toHaveProperty("automatic");
    expect(result).not.toHaveProperty("searchHintTime");
    expect(Object.isFrozen(result.proposal!.sequence[0])).toBe(true);
  });

  it("retains original source time for a nonzero sample window and time offset", async () => {
    const samples = tones([880, 880, 1760], [3.8, 4.8, 5.8], 8);
    const result = await analyzeAudioStartReviewWindow({ ...windowOptions(samples), startFrame: 3 * RATE, endFrame: 7 * RATE, timeOffset: 3 });
    expect(result.proposal!.rawTime).toBeCloseTo(5.79, 2);
    expect(result.proposal!.sequence[0].startTime).toBeCloseTo(3.79, 2);
  });

  it("selects the earlier complete profile even when a later one is louder", async () => {
    const first = tones([880, 880, 1760], [.8, 1.8, 2.8], 10, .12);
    const later = tones([880, 880, 1760], [5.8, 6.8, 7.8], 10, .3);
    const samples = first.map((value, index) => value + later[index]);
    const result = await analyzeAudioStartReviewWindow(windowOptions(samples));
    expect(result.proposal!.rawTime).toBeCloseTo(2.79, 2);
  });

  it("does not replace an existing authoritative-profile cue or mutate stereo recovery metadata", async () => {
    const left = tones([550, 550, 1100]), right = left.map(value => -value);
    const before = await analyzeAudioChannelWindow([left, right], RATE, 0, left.length, 0);
    expect(before.channelRecovery).toBeDefined();
    const snapshot = JSON.stringify(before), input = left.slice();
    const result = await analyzeAudioStartReviewWindow({ ...windowOptions(left), channels: [left, right] });
    expect(result.proposal).toBeNull();
    expect(result.reason).toContain("existing automatic audio profile");
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(left).toEqual(input);
    expect(await analyzeAudioChannelWindow([left, right], RATE, 0, left.length, 0)).toEqual(before);
  });

  it("recovers a quiet higher tone masked by a louder 300 Hz component", async () => {
    const samples = tones([880, 880, 1760], [.8, 1.8, 2.8], 4, .05);
    for (let index = 2.6 * RATE; index < 3.3 * RATE; index++) samples[index] += .6 * Math.sin(2 * Math.PI * 300 * index / RATE);
    const result = await analyzeAudioStartReviewWindow(windowOptions(samples));
    expect(result.proposal!.rawTime).toBeCloseTo(2.79, 2);
  });

  it.each([840, 880])("does not turn a 1568 Hz final after %i Hz preparations into this profile", async preparation => {
    const result = await analyzeAudioStartReviewWindow(windowOptions(tones([preparation, preparation, 1568])));
    expect(result.proposal).toBeNull();
  });

  it("retains the known short-pulse limitation without calling feature span physical duration", async () => {
    const result = await analyzeAudioStartReviewWindow(windowOptions(tones([880, 880, 1760], [.8, 1.8, 2.8], 4, .3, RATE, .025)));
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.sequence[2].qualifiedFrames).toBeGreaterThanOrEqual(4);
    expect(result.proposal!.supportMeaning).toContain("not a measured physical tone duration");
    expect(result.proposal!.supportMeaning).toContain("Short pulse suggestions can occur");
  });

  it("returns no proposal for a mathematically silent window", async () => {
    expect((await analyzeAudioStartReviewWindow(windowOptions(new Float32Array(4 * RATE)))).proposal).toBeNull();
  });

  it("does not mutate samples or share feature arrays between calls", () => {
    const samples = tones(), before = samples.slice();
    const first = extractAudioToneComponents(samples, RATE), second = extractAudioToneComponents(samples, RATE);
    expect(first.features).not.toBe(second.features);
    expect(first.features).toEqual(second.features);
    expect(samples).toEqual(before);
  });
});

describe("manual review source cancellation", () => {
  it("refuses an already aborted request before reading the file", async () => {
    const binding = source(), controller = new AbortController(), bytes = vi.spyOn(binding.options.file, "arrayBuffer");
    controller.abort();
    await expect(findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(bytes).not.toHaveBeenCalled();
  });

  it.each(["file", "key", "generation"] as const)("does not publish after the current %s changes during analysis", async field => {
    const binding = source(), pending = analyzeAudioStartReviewWindow(windowOptions(tones(), binding));
    queueMicrotask(() => {
      if (field === "file") binding.current.file = new File(["original bytes"], "attempt.mp4");
      else if (field === "key") binding.current.key = "blob:replacement";
      else binding.current.generation += 1;
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("manual decoder ownership", () => {
  function decoded(samples: Float32Array, rate = RATE): AudioBuffer {
    return { sampleRate: rate, numberOfChannels: 2, length: samples.length, duration: samples.length / rate, getChannelData: () => samples } as unknown as AudioBuffer;
  }

  it("owns and closes exactly one decoder context", async () => {
    const binding = source(), close = vi.fn(async () => undefined), decode = vi.fn(async () => decoded(tones()));
    const Constructor = vi.fn(function () { return { decodeAudioData: decode, close }; });
    vi.stubGlobal("window", { AudioContext: Constructor });
    const result = await findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4 });
    expect(result.proposal!.rawTime).toBeCloseTo(2.79, 2);
    expect(Constructor).toHaveBeenCalledOnce(); expect(decode).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it("uses the unsupported-rate fallback without changing the source clock", async () => {
    const binding = source(), close = vi.fn(async () => undefined), samples = tones([880, 880, 1760], [.8, 1.8, 2.8], 4, .3, 48_000);
    const Constructor = vi.fn(function (options?: AudioContextOptions) {
      if (options?.sampleRate === RATE) throw new DOMException("Unsupported8k", "NotSupportedError");
      return { decodeAudioData: async () => decoded(samples, 48_000), close };
    });
    vi.stubGlobal("window", { AudioContext: Constructor });
    const result = await findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4 });
    expect(result.proposal!.rawTime).toBeCloseTo(2.79, 2);
    expect(Constructor).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
  });

  it("closes its context and rejects a generation change while decoding", async () => {
    const binding = source(), close = vi.fn(async () => undefined);
    let finish!: (buffer: AudioBuffer) => void;
    const decode = vi.fn(() => new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { decodeAudioData: decode, close }; }) });
    const pending = findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4 });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    binding.current.generation += 1; finish(decoded(tones()));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a source change during asynchronous context cleanup before publishing", async () => {
    const binding = source(), close = vi.fn(async () => { binding.current.generation += 1; });
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { decodeAudioData: async () => decoded(tones()), close }; }) });
    await expect(findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4 })).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a held decoder immediately when a source replacement aborts its owner", async () => {
    const binding = source(), controller = new AbortController(), close = vi.fn(async () => undefined);
    let finish!: (buffer: AudioBuffer) => void;
    const decode = vi.fn(() => new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    vi.stubGlobal("window", { AudioContext: vi.fn(function () { return { decodeAudioData: decode, close }; }) });
    const pending = findAudioStartReview({ ...binding.options, searchStart: 0, searchEnd: 4, signal: controller.signal });
    // Attach the rejection expectation before aborting: the decoder remains held.
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    binding.current.file = new File(["replacement bytes"], "attempt.mp4");
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await rejected;
    finish(decoded(tones()));
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });
});
