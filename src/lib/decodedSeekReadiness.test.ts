import {afterEach, describe, expect, it, vi} from "vitest";
import {waitForDecodedSeek} from "./videoFrameSampler";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const video = () => ({src:"blob:readiness",currentTime:2.5}) as HTMLVideoElement;

describe("decoded seek readiness", () => {
  it("waits out an old native frame instead of calibrating the new cursor from it", async () => {
    vi.useFakeTimers();
    let calls=0;
    const close=vi.fn();
    vi.stubGlobal("VideoFrame", class {
      timestamp=++calls<3?500000:2500000;
      duration=100000;
      close=close;
    });
    const pending=waitForDecodedSeek(video());
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(calls).toBe(3);
    expect(close).toHaveBeenCalledTimes(3);
  });
  it("fails within a bounded wait if readable native frames stay stale", async () => {
    vi.useFakeTimers();
    const close=vi.fn();
    vi.stubGlobal("VideoFrame", class { timestamp=500000; duration=100000; close=close; });
    const assertion=expect(waitForDecodedSeek(video())).rejects.toThrow("did not catch up");
    await vi.advanceTimersByTimeAsync(210);
    await assertion;
    expect(close).toHaveBeenCalled();
  });
  it("preserves fallback for missing native support or unavailable duration", async () => {
    vi.stubGlobal("VideoFrame", undefined);
    await expect(waitForDecodedSeek(video())).resolves.toBeUndefined();
    const close=vi.fn();
    vi.stubGlobal("VideoFrame", class { timestamp=500000; duration=null; close=close; });
    await expect(waitForDecodedSeek(video())).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    vi.stubGlobal("VideoFrame", class { constructor() { throw new Error("unsupported codec"); } });
    await expect(waitForDecodedSeek(video())).resolves.toBeUndefined();
  });
  it("stops if the video changes while waiting", async () => {
    vi.useFakeTimers();
    const target=video();
    vi.stubGlobal("VideoFrame", class { timestamp=500000; duration=100000; close() {} });
    const assertion=expect(waitForDecodedSeek(target)).rejects.toThrow("Video changed");
    target.src="blob:replacement";
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});
