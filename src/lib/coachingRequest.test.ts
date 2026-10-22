import { afterEach, describe, expect, it, vi } from "vitest";
import { readCoachingResponse } from "./coachingRequest";

afterEach(() => { vi.useRealTimers(); });

describe("bounded coaching responses", () => {
  it("keeps network failures actionable without an automatic retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(readCoachingResponse("/api/coaching", {}, 100, fetcher)).rejects.toThrow("Check your connection and retry");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains server status and structured error details without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Review limit reached" }, { status: 429 }));
    await expect(readCoachingResponse("/api/coaching", {}, 100, fetcher)).resolves.toEqual({
      ok: false, status: 429, data: { error: "Review limit reached" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>Unavailable</html>", "null", "[]"])("rejects an unreadable response: %s", async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(readCoachingResponse("/api/coaching", {}, 100, fetcher)).rejects.toThrow("unreadable response");
  });

  it("stops waiting for response headers and aborts the owned fetch", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const result = readCoachingResponse("/api/coaching", {}, 100, fetcher);
    const rejected = expect(result).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a response body that stalls after headers arrive", async () => {
    vi.useFakeTimers();
    const response = { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const rejected = expect(readCoachingResponse("/api/coaching", {}, 100, fetcher)).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors cancellation even when a transport ignores its signal", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { resolveFetch = resolve; }));
    const rejected = expect(readCoachingResponse("/api/coaching", { signal: external.signal }, 100, fetcher)).rejects.toMatchObject({ name: "AbortError" });
    external.abort();
    await rejected;
    resolveFetch(Response.json({ status: "complete" }));
    await Promise.resolve();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an already canceled request", async () => {
    const external = new AbortController(); external.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(readCoachingResponse("/api/coaching", { signal: external.signal }, 100, fetcher)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes its timer and external abort listener after success", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ enabled: true }));
    await expect(readCoachingResponse("/api/coaching", { signal: external.signal }, 100, fetcher)).resolves.toMatchObject({ data: { enabled: true } });
    external.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
