import { describe, expect, it, vi } from "vitest";
import { holdScreenForAnalysis } from "./analysisWakeLock";

class Visibility extends EventTarget {
  visibilityState = "visible";
  set(value: string) { this.visibilityState = value; this.dispatchEvent(new Event("visibilitychange")); }
}
class Lock extends EventTarget { release = vi.fn(async () => { this.dispatchEvent(new Event("release")); }); }

describe("analysis screen wake lock", () => {
  it("releases on completion and does not acquire again after teardown", async () => {
    const document = new Visibility(); const lock = new Lock(); const provider = { request: vi.fn(async () => lock) };
    const stop = holdScreenForAnalysis(document, provider);
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalledOnce());
    stop(); document.set("hidden"); document.set("visible");
    expect(lock.release).toHaveBeenCalledOnce(); expect(provider.request).toHaveBeenCalledOnce();
  });
  it("releases a request that resolves after analysis stopped", async () => {
    const document = new Visibility(); const lock = new Lock(); let complete!: (lock: Lock) => void;
    const stop = holdScreenForAnalysis(document, { request: () => new Promise(resolve => { complete = resolve; }) });
    stop(); complete(lock);
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
  });
  it("releases on background and reacquires only when visible and still active", async () => {
    const document = new Visibility(); const first = new Lock(); const second = new Lock();
    const provider = { request: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const stop = holdScreenForAnalysis(document, provider);
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalledOnce());
    document.set("hidden"); expect(first.release).toHaveBeenCalledOnce();
    document.set("visible"); await vi.waitFor(() => expect(provider.request).toHaveBeenCalledTimes(2));
    stop(); expect(second.release).toHaveBeenCalledOnce();
  });
  it("does not acquire in the background or spin on unsupported/denied requests", async () => {
    const document = new Visibility(); document.set("hidden"); const provider = { request: vi.fn().mockRejectedValue(new Error("NotAllowedError")) };
    const stop = holdScreenForAnalysis(document, provider); expect(provider.request).not.toHaveBeenCalled();
    document.set("visible"); await vi.waitFor(() => expect(provider.request).toHaveBeenCalledOnce());
    stop(); expect(() => holdScreenForAnalysis(document)()).not.toThrow();
  });
});
