import { afterEach, describe, expect, it, vi } from "vitest";
import { createProtocolClient } from "./cdp-client.mjs";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  reply(data) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) })); }
}

afterEach(() => vi.useRealTimers());

describe("bounded browser protocol requests", () => {
  it("matches out-of-order replies and ignores unrelated events", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    const first = client.send("Page.enable");
    const second = client.send("Runtime.enable");
    socket.reply({ method: "Page.event" });
    socket.reply({ id: 2, result: "second" });
    socket.reply({ id: 1, result: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
  it("rejects an unresponsive command instead of waiting forever", async () => {
    vi.useFakeTimers();
    const client = createProtocolClient(new FakeSocket(), { timeoutMs: 20 });
    const assertion = expect(client.send("DOM.setFileInputFiles")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects all pending and later requests after the browser closes", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    const first = expect(client.send("Page.enable")).rejects.toThrow("closed");
    const second = expect(client.send("Runtime.enable")).rejects.toThrow("closed");
    socket.dispatchEvent(new Event("close"));
    await Promise.all([first, second]);
    await expect(client.send("Page.reload")).rejects.toThrow("closed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves the failing method in a protocol error", async () => {
    const socket = new FakeSocket();
    const client = createProtocolClient(socket);
    const assertion = expect(client.send("Runtime.evaluate")).rejects.toThrow("Runtime.evaluate: missing context");
    socket.reply({ id: 1, error: { message: "missing context" } });
    await assertion;
  });
  it("cleans up a synchronous send failure", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.send = () => { throw new Error("send failed"); };
    await expect(createProtocolClient(socket).send("Page.enable")).rejects.toThrow("send failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
