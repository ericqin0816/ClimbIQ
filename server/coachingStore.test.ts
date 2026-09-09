import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisReviewStore, type ReviewRecord } from "./coachingStore";

afterEach(() => vi.unstubAllGlobals());
const record: ReviewRecord = { id: "abcdefghijklmnopqrstu", requestId: "request-id", fingerprint: "evidence-hash", createdAt: "2026-09-08T00:00:00Z", model: "nvidia/test", packet: {}, status: "pending", estimatedCostUsd: null };
describe("Redis persistence command contract (mocked REST)", () => {
  it("uses one atomic reservation command with owner-scoped keys", async () => {
    let command: (string | number)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(url).toBe("https://test.upstash.io");
      expect(init.headers.Authorization).toBe("Bearer server-token");
      command = JSON.parse(init.body);
      return Response.json({ result: ["created", record.id] });
    }));
    const store = new RedisReviewStore("https://test.upstash.io", "server-token", "owner-hash", 5);
    expect(await store.reserve(record)).toEqual({ state: "created", id: record.id });
    expect(command[0]).toBe("EVAL"); expect(command[2]).toBe(4);
    expect(command.slice(3, 7).every(key => String(key).startsWith("climbiq:coaching:v1:owner-hash:"))).toBe(true);
    expect(command[5]).toContain("2026-09-08");
    expect(command[8]).toBe(JSON.stringify(record)); expect(command[9]).toBe(5);
  });
  it("requires positive save acknowledgment and handles missing records", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ result: null })).mockResolvedValueOnce(Response.json({ error: "secret backend detail" })).mockResolvedValueOnce(Response.json({ result: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new RedisReviewStore("https://test.upstash.io", "token", "owner", 5);
    expect(await store.get(record.id)).toBeNull();
    await expect(store.save(record)).rejects.toThrow("Review storage unavailable.");
    await expect(store.save(record)).resolves.toBeUndefined();
  });
});
