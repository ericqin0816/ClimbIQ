import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoseWorkerClient, type PoseWorkerTransport } from "./poseWorkerClient";
import type { PoseWorkerRequest, PoseWorkerResponse } from "./poseWorkerProtocol";

function transport() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const worker = {
    postMessage: vi.fn<(message: PoseWorkerRequest, transfer: Transferable[]) => void>(),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => {
      const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.get(type)?.delete(listener)),
  } satisfies PoseWorkerTransport;
  return {
    worker,
    reply: (data: PoseWorkerResponse) => { for (const listener of listeners.get("message") ?? []) listener({ data }); },
    error: (type = "error") => { for (const listener of listeners.get(type) ?? []) listener(new Event(type)); },
    listenerCount: () => [...listeners.values()].reduce((total, group) => total + group.size, 0),
  };
}

const initialize = () => ({ kind: "initialize" as const, model: new Uint8Array([1, 2, 3]), wasmBase: "capacitor://localhost/mediapipe/wasm" });
afterEach(() => vi.useRealTimers());

describe("pose worker transport", () => {
  it("passes transferred model ownership through and resolves only the matching ready reply", async () => {
    const { worker, reply } = transport(); const client = createPoseWorkerClient(worker);
    const message = initialize(); const pending = client.request(message, [message.model.buffer]);
    expect(worker.postMessage).toHaveBeenCalledWith({ ...message, id: 1 }, [message.model.buffer]);
    reply({ id: 999, kind: "ready" });
    reply({ id: 1, kind: "ready" });
    await expect(pending).resolves.toEqual({ id: 1, kind: "ready" }); client.close();
  });

  it("preserves the worker's initialization error instead of replacing it with cancellation", async () => {
    const { worker, reply } = transport(); const client = createPoseWorkerClient(worker);
    const pending = client.request(initialize());
    reply({ id: 1, kind: "error", message: "WASM module could not be loaded" });
    client.close();
    await expect(pending).rejects.toThrow("WASM module could not be loaded");
  });

  it("rejects concurrent frames without posting or losing the current frame", async () => {
    const { worker, reply } = transport(); const client = createPoseWorkerClient(worker);
    const first = client.request(initialize());
    await expect(client.request(initialize())).rejects.toThrow("current pose frame");
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    reply({ id: 1, kind: "ready" }); await first; client.close();
  });

  it("ignores a late prior reply while a later frame is pending", async () => {
    const { worker, reply } = transport(); const client = createPoseWorkerClient(worker);
    const first = client.request(initialize()); reply({ id: 1, kind: "ready" }); await first;
    const image = { close: vi.fn() } as unknown as ImageBitmap;
    const second = client.request({ kind: "detect", image, timestamp: 2000 }, [image]);
    reply({ id: 1, kind: "landmarks", landmarks: [[{ x: 99, y: 99, z: 0, visibility: 1 }]] });
    reply({ id: 2, kind: "landmarks", landmarks: [] });
    await expect(second).resolves.toEqual({ id: 2, kind: "landmarks", landmarks: [] });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 2, kind: "detect", image, timestamp: 2000 }, [image]);
    client.close();
  });

  it("cancels an in-flight call immediately, terminates once, and removes listeners", async () => {
    const { worker, reply, listenerCount } = transport(); const controller = new AbortController();
    const client = createPoseWorkerClient(worker, controller.signal);
    const pending = client.request(initialize()); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    reply({ id: 1, kind: "ready" }); client.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(listenerCount()).toBe(0);
    await expect(client.request(initialize())).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not post to an already-cancelled worker", async () => {
    const { worker, listenerCount } = transport(); const controller = new AbortController(); controller.abort();
    const client = createPoseWorkerClient(worker, controller.signal);
    await expect(client.request(initialize())).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.postMessage).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1); expect(listenerCount()).toBe(0);
  });

  it("cleans up a hung initialization and preserves timeout as the failure reason", async () => {
    vi.useFakeTimers();
    const { worker, listenerCount } = transport(); const client = createPoseWorkerClient(worker, undefined, 500);
    const pending = client.request(initialize()); const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(501); await failure;
    await expect(client.request(initialize())).rejects.toThrow("timed out");
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "messageerror"])("cleans up a worker %s and rejects its pending call", async type => {
    const { worker, error, listenerCount } = transport(); const client = createPoseWorkerClient(worker);
    const pending = client.request(initialize()); error(type);
    await expect(pending).rejects.toThrow("background pose task stopped");
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(listenerCount()).toBe(0);
  });

  it("preserves a synchronous transfer failure and does not leave a timer or listeners", async () => {
    vi.useFakeTimers();
    const { worker, listenerCount } = transport(); const problem = new DOMException("Cannot transfer image", "DataCloneError");
    worker.postMessage.mockImplementation(() => { throw problem; });
    const client = createPoseWorkerClient(worker);
    await expect(client.request(initialize())).rejects.toBe(problem);
    await expect(client.request(initialize())).rejects.toBe(problem);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after successful work and detaches the abort listener on close", async () => {
    vi.useFakeTimers();
    const { worker, reply } = transport(); const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = createPoseWorkerClient(worker, controller.signal);
    const pending = client.request(initialize()); reply({ id: 1, kind: "ready" }); await pending;
    expect(vi.getTimerCount()).toBe(0); client.close(); controller.abort();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
