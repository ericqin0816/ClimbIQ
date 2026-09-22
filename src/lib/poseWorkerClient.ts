import type { PoseWorkerRequest, PoseWorkerResponse } from "./poseWorkerProtocol";

export interface PoseWorkerTransport {
  postMessage(message: PoseWorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<PoseWorkerResponse>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<PoseWorkerResponse>) => void): void;
  removeEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  terminate(): void;
}

type RequestWithoutId = PoseWorkerRequest extends infer Request ? Request extends PoseWorkerRequest ? Omit<Request, "id"> : never : never;
const cancelled = () => new DOMException("Pose inference cancelled.", "AbortError");

/** One in-flight frame per worker: no backlog or late result can replace a run. */
export function createPoseWorkerClient(worker: PoseWorkerTransport, signal?: AbortSignal, timeoutMs = 15000) {
  let sequence = 0;
  let closed = false;
  let closedReason: unknown;
  let pending: { id: number; resolve(value: PoseWorkerResponse): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> } | undefined;

  function settle(error?: unknown, value?: PoseWorkerResponse) {
    const current = pending;
    pending = undefined;
    if (!current) return;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve(value!);
  }
  function close(error: unknown = cancelled()) {
    if (closed) return;
    closed = true;
    closedReason = error;
    settle(error);
    signal?.removeEventListener("abort", abort);
    worker.removeEventListener("message", message);
    worker.removeEventListener("error", failed);
    worker.removeEventListener("messageerror", failed);
    // Termination also interrupts a synchronous WASM call inside the worker.
    worker.terminate();
  }
  function abort() { close(cancelled()); }
  function failed() { close(new Error("The background pose task stopped. Retry the analysis.")); }
  function message(event: MessageEvent<PoseWorkerResponse>) {
    if (closed || !pending || event.data.id !== pending.id) return;
    if (event.data.kind === "error") settle(new Error(event.data.message));
    else settle(undefined, event.data);
  }
  worker.addEventListener("message", message);
  worker.addEventListener("error", failed);
  worker.addEventListener("messageerror", failed);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return {
    request(request: RequestWithoutId, transfer: Transferable[] = []): Promise<PoseWorkerResponse> {
      if (closed) return Promise.reject(closedReason);
      if (signal?.aborted) return Promise.reject(cancelled());
      if (pending) return Promise.reject(new Error("Wait for the current pose frame before sending another."));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => close(new Error("Background pose inference timed out. Retry the analysis.")), timeoutMs);
        pending = { id, resolve, reject, timer };
        try { worker.postMessage({ ...request, id } as PoseWorkerRequest, transfer); }
        catch (error) { close(error); }
      });
    },
    close,
  };
}
