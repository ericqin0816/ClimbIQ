import { describe, expect, it, vi } from "vitest";
import { createCoachingHandler, coachingConfig } from "./coachingHandler";
import { generateNimReview } from "./coachingNim";
import type { ReviewRecord, ReviewStore } from "./coachingStore";
import { buildCoachingCatalog, type CoachingPacket } from "../src/lib/coachingPolicy";

const evidence = (): CoachingPacket => ({ version: 1, goal: "overview", baseline: null, current: { timingState: "accepted", totalSeconds: 12.255, movementSeconds: .2, reviewedHold10: false, bottomSeconds: null, topSeconds: null, speedCoverage: .6, comparisonFloorSeconds: .1 } });
const env = { COACHING_ENABLED: "1", NVIDIA_NIM_API_KEY: "test-provider-key", NVIDIA_NIM_MODEL: "nvidia/test-model", COACHING_ACCESS_TOKEN: "private-test-workspace-code-123456789", UPSTASH_REDIS_REST_URL: "https://test.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-store-token", COACHING_ALLOWED_ORIGIN: "https://climbiq.test" };
const requestId = "12345678-1234-1234-1234-123456789012";
const request = (body: unknown = { requestId, consent: true, packet: evidence() }, headers: Record<string, string> = {}) => new Request("https://climbiq.test/api/coaching", { method: "POST", headers: { "Content-Type": "application/json", Origin: env.COACHING_ALLOWED_ORIGIN, Authorization: `Bearer ${env.COACHING_ACCESS_TOKEN}`, ...headers }, body: JSON.stringify(body) });
function setup() {
  const records = new Map<string, ReviewRecord>(); const events: string[] = [];
  const store: ReviewStore = {
    reserve: vi.fn<ReviewStore["reserve"]>(async r => { events.push("reserve"); const old = [...records.values()].find(x => x.requestId === r.requestId || x.fingerprint === r.fingerprint); if (old) return { state: "existing", id: old.id }; records.set(r.id, r); return { state: "created", id: r.id }; }),
    get: vi.fn(async id => records.get(id) ?? null),
    save: vi.fn(async r => { events.push("save"); records.set(r.id, r); }),
  };
  const generate = vi.fn(async (p: CoachingPacket) => { events.push("generate"); return { plan: buildCoachingCatalog(p).defaultPlan, rawOutput: "test output", usage: { inputTokens: 10, outputTokens: 20 }, estimatedCostUsd: null }; });
  return { records, events, store, generate, handler: createCoachingHandler(env, { store, generate }) };
}
describe("private NIM review boundary", () => {
  it("fails closed until every server control is configured", async () => {
    for (const key of Object.keys(env)) expect(coachingConfig({ ...env, [key]: "" })).toBeNull();
    expect(coachingConfig({ ...env, COACHING_DAILY_LIMIT: "500" })).toBeNull();
    const handler = createCoachingHandler({});
    expect(await (await handler(new Request("https://climbiq.test/api/coaching?status=1"))).json()).toMatchObject({ enabled: false });
    expect((await handler(request())).status).toBe(503);
  });
  it("requires correct auth, origin, consent, size and exact evidence schema", async () => {
    const s = setup();
    expect((await s.handler(request(undefined, { Authorization: "wrong" }))).status).toBe(401);
    expect((await s.handler(request(undefined, { Origin: "https://other.test" }))).status).toBe(403);
    expect((await s.handler(request({ requestId, consent: false, packet: evidence() }))).status).toBe(400);
    expect((await s.handler(request({ requestId, consent: true, packet: { ...evidence(), notes: "secret" } }))).status).toBe(400);
    expect((await s.handler(request({ text: "x".repeat(9000) }))).status).toBe(400);
    expect((await s.handler(request(undefined, { "Content-Type": "text/plain" }))).status).toBe(400);
    expect(s.generate).not.toHaveBeenCalled();
  });
  it("reserves before inference, saves before reply and hides raw output", async () => {
    const s = setup(); const response = await s.handler(request()); const data = await response.json();
    expect(response.status).toBe(200); expect(s.events).toEqual(["reserve", "generate", "save"]);
    expect(data.id).toMatch(/^[\w-]{21}$/); expect(data.rawOutput).toBeUndefined();
    expect(s.records.get(data.id)).toMatchObject({ status: "complete", rawOutput: "test output", estimatedCostUsd: null, usage: { inputTokens: 10, outputTokens: 20 } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("deduplicates both request IDs and identical evidence", async () => {
    const s = setup(); const first = await (await s.handler(request())).json();
    expect(await (await s.handler(request())).json()).toEqual(first);
    expect(await (await s.handler(request({ requestId: "22345678-1234-1234-1234-123456789012", consent: true, packet: evidence() }))).json()).toEqual(first);
    expect(s.generate).toHaveBeenCalledTimes(1);
    const p = evidence(); p.current.totalSeconds = 13;
    expect((await s.handler(request({ requestId, consent: true, packet: p }))).status).toBe(409);
  });
  it("does not infer when reservation or budget fails", async () => {
    const s = setup(); vi.mocked(s.store.reserve).mockResolvedValue({ state: "limited", id: "" });
    expect((await s.handler(request())).status).toBe(429);
    vi.mocked(s.store.reserve).mockRejectedValue(new Error("private-storage-secret"));
    const response = await s.handler(request()); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-storage-secret"); expect(s.generate).not.toHaveBeenCalled();
  });
  it("retains an uncertain saved reservation without generating twice", async () => {
    const s = setup(); vi.mocked(s.store.save).mockRejectedValue(new Error("offline"));
    expect((await s.handler(request())).status).toBe(503);
    expect((await s.handler(request())).status).toBe(202); expect(s.generate).toHaveBeenCalledTimes(1);
  });
  it("saves provider failure without leaking secrets", async () => {
    const s = setup(); s.generate.mockRejectedValue(new Error("test-provider-key"));
    const response = await s.handler(request()); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("test-provider-key"); expect([...s.records.values()][0].status).toBe("failed");
  });
  it("supports authenticated saved readback without a GET Origin header", async () => {
    const s = setup(); const result = await (await s.handler(request())).json();
    const url = `https://climbiq.test/api/coaching?id=${result.id}`;
    expect((await s.handler(new Request(url))).status).toBe(401);
    expect(await (await s.handler(new Request(url, { headers: { Authorization: `Bearer ${env.COACHING_ACCESS_TOKEN}` } }))).json()).toEqual(result);
  });
});
describe("actual NIM compatible adapter with mocked HTTP", () => {
  it.each([
    { unsupported: false, model: "nvidia/test-model" },
    { unsupported: true, model: "nvidia/test-model" },
    { unsupported: false, model: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  ])("validates model output ($model, unsupported=$unsupported) and captures usage", async ({ unsupported, model }) => {
    let payload: Record<string, unknown> = {};
    const mockFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      payload = JSON.parse(init!.body as string);
      return Response.json({ id: "test-completion", object: "chat.completion", created: 1, model: "nvidia/test-model", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(unsupported ? { observationIds: ["invented"], focusId: "rehab" } : buildCoachingCatalog(evidence()).defaultPlan) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
    };
    const result = await generateNimReview(evidence(), "test-key", model, mockFetch);
    expect(payload.model).toBe(model); expect(payload.max_tokens).toBe(700);
    expect(payload.chat_template_kwargs).toEqual(model === "nvidia/nemotron-3.5-lightning-30b-a3b" ? { enable_thinking: false } : undefined);
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20 });
    expect(result.plan === null).toBe(unsupported); expect(result.rawOutput).toBeTruthy();
    expect(result.estimatedCostUsd).toBeNull();
  });
});
