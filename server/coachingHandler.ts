import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { buildCoachingCatalog, parseCoachingPacket, validateCoachingPlan } from "../src/lib/coachingPolicy.js";
import { generateNimReview } from "./coachingNim.js";
import { RedisReviewStore, type ReviewRecord, type ReviewStore } from "./coachingStore.js";

type Env = Record<string, string | undefined>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function coachingConfig(env: Env) {
  try {
    const url = new URL(env.UPSTASH_REDIS_REST_URL ?? "");
    const origin = new URL(env.COACHING_ALLOWED_ORIGIN ?? "");
    const token = env.COACHING_ACCESS_TOKEN ?? "";
    const model = env.NVIDIA_NIM_MODEL ?? "";
    const limit = Number(env.COACHING_DAILY_LIMIT ?? "5");
    if (env.COACHING_ENABLED !== "1" || !env.NVIDIA_NIM_API_KEY || !env.UPSTASH_REDIS_REST_TOKEN || token.length < 32 || token.startsWith("nvapi") || !/^[\w.-]+\/[\w.-]+$/.test(model) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      url.protocol !== "https:" || !url.hostname.endsWith(".upstash.io") || url.username || url.password || url.search || url.hash ||
      !["https:", "http:"].includes(origin.protocol) || (origin.protocol === "http:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return { token, model, limit, origin: origin.origin, url: url.origin, redisToken: env.UPSTASH_REDIS_REST_TOKEN, apiKey: env.NVIDIA_NIM_API_KEY };
  } catch { return null; }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function publicRecord(record: ReviewRecord) {
  const packet = parseCoachingPacket(record.packet);
  return { id: record.id, status: record.status, createdAt: record.createdAt, model: record.model, packet,
    plan: record.status === "complete" ? validateCoachingPlan(record.plan, buildCoachingCatalog(packet)) : null };
}
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body.");
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) { await reader.cancel(); throw new Error("Body too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function createCoachingHandler(env: Env, dependencies: { store?: ReviewStore; generate?: typeof generateNimReview } = {}) {
  const config = coachingConfig(env);
  const store = config ? dependencies.store ?? new RedisReviewStore(config.url, config.redisToken, hash(config.token), config.limit) : null;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.searchParams.get("status") === "1") return json({ enabled: !!config, provider: "NVIDIA NIM", mode: "private-workspace" });
    if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
    if (!config || !store) return json({ error: "Hosted coaching is not configured. Local evidence review is available." }, 503);
    const origin = request.headers.get("origin");
    if ((request.method === "POST" || origin !== null) && origin !== config.origin) return json({ error: "Origin not allowed." }, 403);
    const auth = request.headers.get("authorization") ?? "";
    if (!timingSafeEqual(Buffer.from(hash(auth)), Buffer.from(hash(`Bearer ${config.token}`)))) return json({ error: "Workspace access code required." }, 401);
    try {
      if (request.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[\w-]{21}$/.test(id)) return json({ error: "Invalid review ID." }, 400);
        const record = await store.get(id);
        return record ? json(publicRecord(record), record.status === "pending" ? 202 : 200) : json({ error: "Review not found." }, 404);
      }
      let packet; let requestId: string;
      try {
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
        const body = await boundedBody(request);
        if (!body || Object.keys(body).sort().join(",") !== "consent,packet,requestId" || body.consent !== true || typeof body.requestId !== "string" || !/^[\da-f-]{36}$/i.test(body.requestId)) throw new Error();
        packet = parseCoachingPacket(body.packet); requestId = body.requestId;
      } catch { return json({ error: "Invalid request or missing consent." }, 400); }
      const fingerprint = hash(JSON.stringify({ packet, model: config.model, policy: 1 }));
      const record: ReviewRecord = { id: nanoid(), requestId, fingerprint, model: config.model, packet, status: "pending", createdAt: new Date().toISOString(), estimatedCostUsd: null };
      const reservation = await store.reserve(record);
      if (reservation.state === "limited") return json({ error: "Daily workspace review limit reached. Use the local review." }, 429);
      if (reservation.state === "existing") {
        const existing = await store.get(reservation.id);
        if (!existing) throw new Error();
        if (existing.fingerprint !== fingerprint) return json({ error: "Request ID was already used for different evidence." }, 409);
        return json(publicRecord(existing), existing.status === "pending" ? 202 : 200);
      }
      let output;
      try { output = await (dependencies.generate ?? generateNimReview)(packet, config.apiKey, config.model); }
      catch {
        await store.save({ ...record, status: "failed", completedAt: new Date().toISOString() });
        return json({ id: record.id, status: "failed", error: "NIM could not complete this review. The local review remains available." }, 502);
      }
      const completed: ReviewRecord = { ...record, ...output, status: output.plan ? "complete" : "failed", completedAt: new Date().toISOString() };
      await store.save(completed); // Never return an unsaved generation.
      return json(publicRecord(completed), output.plan ? 200 : 502);
    } catch { return json({ error: "Review storage is unavailable or the result could not be saved. Retry the same request; no new generation will be started for reserved evidence." }, 503); }
  };
}
