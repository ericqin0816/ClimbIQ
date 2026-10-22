export const COACHING_REQUEST_TIMEOUT_MS = 35_000;

/** Bound the entire response, including a stalled body, without retrying generation. */
export async function readCoachingResponse(
  input: string,
  init: RequestInit = {},
  timeoutMs = COACHING_REQUEST_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  if (init.signal?.aborted) {
    cancel();
    throw controller.signal.reason;
  }
  init.signal?.addEventListener("abort", cancel, { once: true });
  let rejectOnAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error(
    "The online review took too long. Your local review is unchanged. Retry to check the same request.",
  )), timeoutMs);
  try {
    return await Promise.race([interrupted, (async () => {
      let response: Response;
      try { response = await fetcher(input, { ...init, signal: controller.signal }); }
      catch {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new Error("Online review could not connect. Your local review is unchanged. Check your connection and retry.");
      }
      let data: unknown;
      try { data = await response.json(); }
      catch {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new Error("The online review returned an unreadable response. Your local review is unchanged.");
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The online review returned an unreadable response. Your local review is unchanged.");
      }
      return { ok: response.ok, status: response.status, data: data as Record<string, unknown> };
    })()]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}
