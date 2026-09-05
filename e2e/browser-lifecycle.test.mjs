import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

class Browser extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kill = vi.fn(() => { this.signalCode = "SIGTERM"; this.emit("exit"); });
  exit() { this.exitCode = 0; this.emit("exit"); }
}
afterEach(() => vi.useRealTimers());

describe("owned test-browser shutdown", () => {
  it("requests graceful shutdown and leaves an exited browser alone", async () => {
    const browser = new Browser(), send = vi.fn(async () => { browser.exit(); });
    await closeTestBrowser(browser, send);
    expect(send).toHaveBeenCalledExactlyOnceWith("Browser.close");
    expect(browser.kill).not.toHaveBeenCalled();
    expect(browser.listenerCount("exit")).toBe(0);
  });
  it("bounds a hung close request and falls back to the owned process handle", async () => {
    vi.useFakeTimers(); const browser = new Browser();
    const closing = closeTestBrowser(browser, () => new Promise(() => {}), { requestMs: 50, graceMs: 50 });
    await vi.advanceTimersByTimeAsync(100); await closing;
    expect(browser.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(browser.listenerCount("exit")).toBe(0);
  });
  it("handles a broken debugging connection and already exited children", async () => {
    vi.useFakeTimers(); const browser = new Browser();
    const closing = closeTestBrowser(browser, async () => { throw new Error("Closed connection"); }, { graceMs: 50 });
    await vi.advanceTimersByTimeAsync(50); await closing;
    expect(browser.kill).toHaveBeenCalledOnce();
    const send = vi.fn(); await closeTestBrowser(browser, send); expect(send).not.toHaveBeenCalled();
  });
});
