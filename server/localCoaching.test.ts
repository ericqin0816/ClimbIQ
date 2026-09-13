import { describe, expect, it } from "vitest";
import { createLocalCoachingHandler } from "./localCoaching";

const env = {
  COACHING_ENABLED: "1", NVIDIA_NIM_API_KEY: "provider-secret",
  NVIDIA_NIM_MODEL: "nvidia/test-model", COACHING_ACCESS_TOKEN: "local-workspace-secret-123456789012345",
  COACHING_ALLOWED_ORIGIN: "http://127.0.0.1:5173",
  UPSTASH_REDIS_REST_URL: "https://test.upstash.io", UPSTASH_REDIS_REST_TOKEN: "redis-secret",
};
const headers = { Host: "127.0.0.1:5173", "Sec-Fetch-Site": "same-origin", "X-Climbiq-Local": "1" };
const request = (extra: Record<string, string> = {}) => new Request("http://localhost/api/coaching?id=invalid", { headers: { ...headers, ...extra } });

describe("development-only local coaching access", () => {
  it("authenticates loopback browser readback without exposing credentials", async () => {
    const handler = createLocalCoachingHandler(env);
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect((await handler(request(), address)).status).toBe(400); // Passed auth, rejected invalid ID without touching Redis.
    }
    const status = await handler(new Request("http://localhost/api/coaching?status=1", { headers }), "127.0.0.1");
    expect(await status.json()).toEqual({ enabled: true, provider: "NVIDIA NIM", mode: "private-workspace", localAccess: true });
  });
  it("does not authenticate foreign sites, hosts, remote clients, or missing browser headers", async () => {
    const handler = createLocalCoachingHandler(env);
    const overrides: Record<string, string>[] = [
      { Host: "attacker.test:5173" }, { Host: "127.0.0.1:9999" },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "" },
      { "X-Climbiq-Local": "" }, { Origin: "https://attacker.test" },
      { Authorization: "Bearer wrong" },
    ];
    for (const override of overrides) expect([401, 403]).toContain((await handler(request(override), "127.0.0.1")).status);
    expect((await handler(request(), "192.168.1.5")).status).toBe(401);
    expect((await handler(request(), undefined)).status).toBe(401);
    const hosted = createLocalCoachingHandler({ ...env, COACHING_ALLOWED_ORIGIN: "https://climbiq.test" });
    expect((await hosted(request({ Host: "climbiq.test" }), "127.0.0.1")).status).toBe(401);
  });
  it("still requires the matching Origin and consent for POST and rejects preflight", async () => {
    const handler = createLocalCoachingHandler(env);
    const post = (origin?: string) => new Request("http://localhost/api/coaching", { method: "POST", headers: { ...headers, ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: JSON.stringify({ consent: false }) });
    expect((await handler(post(), "127.0.0.1")).status).toBe(403);
    expect((await handler(post("https://attacker.test"), "127.0.0.1")).status).toBe(403);
    expect((await handler(post(env.COACHING_ALLOWED_ORIGIN), "127.0.0.1")).status).toBe(400);
    expect((await handler(new Request("http://localhost/api/coaching", { method: "OPTIONS", headers }), "127.0.0.1")).status).toBe(405);
  });
});
