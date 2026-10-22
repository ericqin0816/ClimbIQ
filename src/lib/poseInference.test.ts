import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredPoseExecutionMode, createPoseInference } from "./poseInference";
import { POSE_TRACKER_OPTIONS } from "./poseWorkerProtocol";
import type { PoseWorkerRequest, PoseWorkerResponse } from "./poseWorkerProtocol";

const main = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: main.resolve },
  PoseLandmarker: { createFromOptions: main.create },
}));

const model = () => new Uint8Array([1, 2, 3]);
const wasmBase = "capacitor://localhost/mediapipe/wasm";
let workers: FakeWorker[];
let initializeError: string | undefined;
let detectError: string | undefined;
let image: ImageBitmap & { close: ReturnType<typeof vi.fn> };

class FakeWorker {
  listeners = new Map<string, Set<(event: any) => void>>();
  transfers: Transferable[][] = [];
  messages: PoseWorkerRequest[] = [];
  terminate = vi.fn();
  constructor() { workers.push(this); }
  addEventListener(type: string, listener: (event: any) => void) {
    const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  reply(data: PoseWorkerResponse) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
  postMessage(message: PoseWorkerRequest, transfer: Transferable[]) {
    this.messages.push(message); this.transfers.push(transfer);
    // Perform real ArrayBuffer transfer at the initialization boundary. Native
    // ImageBitmap transfer is checked in the browser parity run, not simulated.
    if (message.kind === "initialize") structuredClone(message, { transfer: transfer as ArrayBuffer[] });
    const error = message.kind === "initialize" ? initializeError : detectError;
    queueMicrotask(() => this.reply(error ? { id: message.id, kind: "error", message: error }
      : message.kind === "initialize" ? { id: message.id, kind: "ready" }
        : { id: message.id, kind: "landmarks", landmarks: [] }));
  }
}

beforeEach(() => {
  vi.clearAllMocks(); workers = []; initializeError = undefined; detectError = undefined;
  image = { close: vi.fn() } as unknown as typeof image;
  main.resolve.mockResolvedValue({ wasmLoaderPath: "loader.js", wasmBinaryPath: "module.wasm" });
  main.create.mockImplementation(async () => ({ detectForVideo: vi.fn(() => ({ landmarks: [] })), close: vi.fn() }));
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", vi.fn(async () => image));
});
afterEach(() => vi.unstubAllGlobals());

describe("pose inference backend", () => {
  it("defaults browser runs to automatic workers and native runs to their verified main-thread path", () => {
    expect(configuredPoseExecutionMode(undefined, false)).toBe("auto");
    expect(configuredPoseExecutionMode(undefined, true)).toBe("main-thread");
    expect(configuredPoseExecutionMode("main-thread", false)).toBe("main-thread");
    expect(configuredPoseExecutionMode("worker", true)).toBe("worker");
    expect(configuredPoseExecutionMode("misspelled", false)).toBe("main-thread");
  });
  it("creates separate main-thread trackers with the unchanged analysis options", async () => {
    const first = await createPoseInference(model(), wasmBase);
    const second = await createPoseInference(model(), wasmBase);
    expect(main.create).toHaveBeenCalledTimes(2);
    expect(main.create).toHaveBeenCalledWith(expect.any(Object), { ...POSE_TRACKER_OPTIONS, baseOptions: { modelAssetBuffer: model(), delegate: "CPU" } });
    expect(workers).toHaveLength(0);
    const one = await main.create.mock.results[0].value, two = await main.create.mock.results[1].value;
    first.close(); expect(one.close).toHaveBeenCalledOnce(); expect(two.close).not.toHaveBeenCalled(); second.close();
  });

  it("falls back before processing when a worker API is missing", async () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const backend = await createPoseInference(model(), wasmBase, undefined, "auto");
    expect(backend.backend).toBe("main-thread"); expect(backend.fallbackReason).toMatch(/unavailable/);
    expect(workers).toHaveLength(0); backend.close();
  });

  it("falls back when Worker construction is denied and reports the original cause", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("Worker blocked by browser policy"); } });
    const backend = await createPoseInference(model(), wasmBase, undefined, "auto");
    expect(backend.backend).toBe("main-thread"); expect(backend.fallbackReason).toBe("Worker blocked by browser policy"); backend.close();
  });

  it("uses a transferred copy and keeps the original model available for startup fallback", async () => {
    initializeError = "Offscreen WebGL is unavailable";
    const original = model(); const backend = await createPoseInference(original, wasmBase, undefined, "auto");
    expect(original).toEqual(model());
    expect((workers[0].messages[0] as Extract<PoseWorkerRequest, { kind: "initialize" }>).model.byteLength).toBe(0);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(backend.backend).toBe("main-thread"); expect(backend.fallbackReason).toBe(initializeError); backend.close();
  });

  it("preserves initialization failures in explicit worker experiments", async () => {
    initializeError = "WASM integrity/setup failed";
    await expect(createPoseInference(model(), wasmBase, undefined, "worker")).rejects.toThrow(initializeError);
    expect(main.create).not.toHaveBeenCalled(); expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("transfers each snapshot, releases it after the response, and keeps the tracker alive until close", async () => {
    const backend = await createPoseInference(model(), wasmBase, undefined, "worker");
    const canvas = {} as HTMLCanvasElement;
    await expect(backend.detect(canvas, 1500)).resolves.toEqual([]);
    expect(createImageBitmap).toHaveBeenCalledWith(canvas);
    expect(workers[0].transfers[1]).toEqual([image]); expect(image.close).toHaveBeenCalledOnce();
    expect(workers[0].terminate).not.toHaveBeenCalled(); backend.close(); expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not silently restart a tracker on the main thread after a worker frame fails", async () => {
    const backend = await createPoseInference(model(), wasmBase, undefined, "auto"); detectError = "Inference failed";
    await expect(backend.detect({} as HTMLCanvasElement, 1500)).rejects.toThrow(detectError);
    expect(image.close).toHaveBeenCalledOnce(); expect(main.create).not.toHaveBeenCalled(); backend.close();
  });

  it("does not create a backend for an already-cancelled analysis", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createPoseInference(model(), wasmBase, controller.signal, "auto")).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0); expect(main.create).not.toHaveBeenCalled();
  });

  it("closes a main-thread tracker whose initialization finishes after cancellation", async () => {
    let complete!: (tracker: { close: ReturnType<typeof vi.fn> }) => void;
    const created = new Promise(resolve => { complete = resolve; });
    main.create.mockReturnValue(created);
    const controller = new AbortController();
    const pending = createPoseInference(model(), wasmBase, controller.signal, "main-thread");
    await vi.waitFor(() => expect(main.create).toHaveBeenCalledOnce());
    controller.abort(); const tracker = { close: vi.fn() }; complete(tracker);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tracker.close).toHaveBeenCalledOnce();
  });
});
