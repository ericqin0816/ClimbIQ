export interface VerifiedModelDefinition {
  url: string;
  expectedBytes: number;
  sha256: string;
}

interface ModelCacheDependencies {
  fetch: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  digest: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
}

interface PendingModel {
  key: string;
  controller: AbortController;
  subscribers: number;
  promise: Promise<Uint8Array>;
}

const cancelled = () => new DOMException("Pose model loading cancelled.", "AbortError");

/** One verified model retained in memory. Each consumer gets its own bytes so a
 * native/WASM task cannot mutate the verified cache. No tracking state is shared.
 */
export function createVerifiedModelCache(dependencies: ModelCacheDependencies) {
  let cached: { key: string; bytes: Uint8Array } | undefined;
  let pending: PendingModel | undefined;

  async function verify(definition: VerifiedModelDefinition, signal: AbortSignal): Promise<Uint8Array> {
    const response = await dependencies.fetch(definition.url, { signal });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || contentType.includes("text/html")) {
      throw new Error("The local pose model is missing or was served as an HTML fallback. Redeploy the complete production build.");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== definition.expectedBytes) {
      throw new Error(`Pose model size check failed (${buffer.byteLength} bytes).`);
    }
    if (signal.aborted) throw cancelled();
    const digest = await dependencies.digest(buffer);
    if (signal.aborted) throw cancelled();
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== definition.sha256) throw new Error("Pose model integrity check failed.");
    return new Uint8Array(buffer);
  }

  return {
    load(definition: VerifiedModelDefinition, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted) return Promise.reject(cancelled());
      const key = JSON.stringify([definition.url, definition.expectedBytes, definition.sha256]);
      if (cached?.key === key) return Promise.resolve(cached.bytes.slice());
      if (!pending || pending.key !== key || pending.controller.signal.aborted) {
        const controller = new AbortController();
        const entry: PendingModel = { key, controller, subscribers: 0, promise: undefined! };
        entry.promise = verify(definition, controller.signal).then(bytes => {
          if (pending === entry && !controller.signal.aborted) cached = { key, bytes };
          return bytes;
        }).finally(() => { if (pending === entry) pending = undefined; });
        pending = entry;
      }
      const entry = pending;
      entry.subscribers++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          entry.subscribers--;
          operation();
        };
        const abort = () => finish(() => {
          // Cancelling one caller must not cancel another analysis's shared load.
          if (entry.subscribers === 0) {
            entry.controller.abort();
            if (pending === entry) pending = undefined;
          }
          reject(cancelled());
        });
        signal?.addEventListener("abort", abort, { once: true });
        entry.promise.then(
          bytes => finish(() => signal?.aborted ? reject(cancelled()) : resolve(bytes.slice())),
          error => finish(() => reject(error)),
        );
        if (signal?.aborted) abort();
      });
    },
    clear() {
      cached = undefined;
      // Existing consumers may finish; their result must not repopulate the cache.
      pending = undefined;
    },
  };
}

export const verifiedPoseModelCache = createVerifiedModelCache({
  fetch: (url, options) => fetch(url, options),
  digest: bytes => crypto.subtle.digest("SHA-256", bytes),
});
