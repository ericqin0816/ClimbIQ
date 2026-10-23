import { describe, expect, it } from "vitest";
import { analyzeAudioChannelWindow, analyzeBeepSequence, reconcileStereoCountdown, resampleMixedChannels, type AudioStartResult } from "./detectAudioStartSignal";

const rate = 8_000;
function tones(frequencies = [550, 550, 1100]) {
  const pcm = new Float32Array(4 * rate);
  for (const [beep, frequency] of frequencies.entries()) {
    const start = Math.round((.8 + beep) * rate), length = Math.round(.16 * rate);
    for (let i = 0; i < length; i++) pcm[start + i] = .6 * Math.sin(2 * Math.PI * frequency * i / rate)
      * Math.min(1, i / 40, (length - i) / 40);
  }
  return pcm;
}
const mixedResult = (channels: Float32Array[]) => analyzeBeepSequence(resampleMixedChannels(channels, rate, 0, channels[0].length, rate), rate);
const analyze = (channels: Float32Array[], offset = 0, signal?: AbortSignal) =>
  analyzeAudioChannelWindow(channels, rate, 0, channels[0].length, offset, signal);
const unresolved: AudioStartResult = { found: false, confidence: "None", reason: "No complete mixed protocol", segments: [] };

describe("stereo countdown recovery", () => {
  it.each(["final-only", "entire-sequence"])("recovers a real protocol cancelled by %s phase inversion, using one original clock", async mode => {
    const left = tones(), right = left.map((value, index) => mode === "entire-sequence" || index >= 2.8 * rate ? -value : value);
    expect(mixedResult([left, right]).confidence).not.toBe("High");
    expect(analyzeBeepSequence(left, rate).confidence).toBe("High");
    expect(analyzeBeepSequence(right, rate).confidence).toBe("High");
    const result = await analyze([left, right], 4.25);
    const originalClock = analyzeBeepSequence(left, rate, 4.25).rawTime!;
    expect(result.confidence).toBe("High");
    expect(result.rawTime).toBe(originalClock);
    expect(Math.abs(originalClock - 7.05)).toBeLessThanOrEqual(.02);
    expect(result.channelRecovery).toMatchObject({ selectedChannel: 0, isIndependentEvidence: false,
      channels: [{ channel: 0, rawTime: originalClock }, { channel: 1, rawTime: originalClock }],
      nominalWindowEnvelope: { isContinuousObservedSupport: false, isEventAccuracyBound: false } });
    expect(result.timingWindow!.endRawTime - result.timingWindow!.startRawTime).toBeCloseTo(.02);
  });

  it("does not promote a protocol audible in only one channel", async () => {
    const left = tones(), right = left.map((value, index) => index < 2.8 * rate ? -value : 0);
    expect(analyzeBeepSequence(left, rate).confidence).toBe("High");
    expect(analyzeBeepSequence(right, rate).confidence).not.toBe("High");
    const mixed = mixedResult([left, right]);
    expect(mixed.confidence).not.toBe("High");
    expect(await analyze([left, right])).toEqual(mixed);
  });

  it.each([[900, 900, 900], [700, 1000, 1800], [550, 700, 1100], [550, 550, 700]])(
    "does not turn cancelled nonprotocol tones %j into a High result", async (...frequencies) => {
      const left = tones(frequencies), right = left.map(value => -value);
      expect((await analyze([left, right])).confidence).not.toBe("High");
    });

  it("retains mixed High, mono, duplicated-channel and multichannel results exactly", async () => {
    const good = tones(), opposite = good.map(value => -value), silence = new Float32Array(good.length);
    for (const channels of [[good], [good, good], [good, opposite, silence], [silence, silence]]) {
      const result = await analyze(channels);
      expect(result).toEqual(mixedResult(channels));
      expect(result.channelRecovery).toBeUndefined();
    }
  });

  it("honors cancellation before a fallback channel is analyzed", async () => {
    const left = tones(), right = left.map(value => -value), controller = new AbortController();
    const pending = analyze([left, right], 0, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("association of independently qualified channel observations", () => {
  const qualified = () => {
    const result = analyzeBeepSequence(tones(), rate);
    expect(result.confidence).toBe("High");
    return result;
  };
  const delayedFinal = (result: AudioStartResult, seconds: number) => {
    const value = structuredClone(result);
    value.rawTime! += seconds;
    value.searchHintTime! += seconds;
    value.sequence![2].startTime += seconds;
    value.sequence![2].endTime += seconds;
    value.timingWindow!.startRawTime += seconds;
    value.timingWindow!.endRawTime += seconds;
    return value;
  };

  it("keeps the earliest observed clock under permutation, with separate nominal windows", () => {
    const first = qualified(), later = delayedFinal(first, .03);
    for (const channels of [[first, later], [later, first]]) {
      const result = reconcileStereoCountdown(unresolved, channels);
      expect(result.rawTime).toBe(first.rawTime);
      expect(result.channelRecovery?.selectedChannel).toBe(channels.indexOf(first));
      expect(result.timingWindow).toEqual(first.timingWindow);
      expect(result.channelRecovery?.channels.map(channel => channel.rawTime)).toEqual(channels.map(channel => channel.rawTime));
      expect(result.channelRecovery?.nominalWindowEnvelope.endRawTime).toBe(later.timingWindow!.endRawTime);
      expect(result.channelRecovery?.mixedResult).toEqual({ found: false, confidence: "None", reason: unresolved.reason });
    }
  });

  it("does not join different final cues, nonoverlapping supports, or different pitch protocols", () => {
    const first = qualified();
    const late = delayedFinal(first, .05);
    const disjoint = delayedFinal(first, .03);
    disjoint.sequence![2].startTime = first.sequence![2].endTime + .01;
    disjoint.sequence![2].endTime = disjoint.sequence![2].startTime + .16;
    const otherPitch = structuredClone(first);
    for (const cue of otherPitch.sequence!) cue.dominantFrequencyHz! *= 1.1;
    for (const other of [late, disjoint, otherPitch, { ...first, confidence: "Medium" as const }]) {
      expect(reconcileStereoCountdown(unresolved, [first, other])).toBe(unresolved);
    }
  });

  it("allows truncated support within one feature window, but not another preparation event", () => {
    const first = qualified(), truncated = structuredClone(first);
    truncated.sequence![1].startTime = first.sequence![1].endTime + .02;
    truncated.sequence![1].endTime = truncated.sequence![1].startTime + .1;
    expect(reconcileStereoCountdown(unresolved, [first, truncated]).confidence).toBe("High");
    truncated.sequence![1].startTime += .001;
    expect(reconcileStereoCountdown(unresolved, [first, truncated])).toBe(unresolved);
  });
});
