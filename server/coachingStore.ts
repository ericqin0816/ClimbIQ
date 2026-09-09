export interface ReviewRecord {
  id: string; requestId: string; fingerprint: string; createdAt: string; completedAt?: string;
  model: string; packet: unknown; status: "pending" | "complete" | "failed";
  plan?: unknown; rawOutput?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  estimatedCostUsd: null;
}
export interface ReviewStore {
  reserve(record: ReviewRecord): Promise<{ state: "created" | "existing" | "limited"; id: string }>;
  get(id: string): Promise<ReviewRecord | null>;
  save(record: ReviewRecord): Promise<void>;
}

// Reservation, request deduplication and daily budget are one atomic operation.
// Records and request pointers do not expire. An uncertain request cannot bill twice.
const RESERVE = `
local existing = redis.call('GET', KEYS[1])
if existing then return {'existing', existing} end
local identical = redis.call('GET', KEYS[2])
if identical then return {'existing', identical} end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[3]) then return {'limited', ''} end
redis.call('SET', KEYS[4], ARGV[2])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], 172800)
return {'created', ARGV[1]}`;

export class RedisReviewStore implements ReviewStore {
  constructor(private url: string, private token: string, private owner: string, private dailyLimit: number) {}
  private key(suffix: string) { return `climbiq:coaching:v1:${this.owner}:${suffix}`; }
  private async command(args: (string | number)[]) {
    const response = await fetch(this.url, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Review storage unavailable.");
    const data = await response.json() as { result?: unknown; error?: string };
    if (data.error) throw new Error("Review storage unavailable.");
    return data.result;
  }
  async reserve(record: ReviewRecord) {
    const day = record.createdAt.slice(0, 10);
    const result = await this.command(["EVAL", RESERVE, 4, this.key(`request:${record.requestId}`), this.key(`evidence:${record.fingerprint}`), this.key(`budget:${day}`), this.key(`record:${record.id}`), record.id, JSON.stringify(record), this.dailyLimit]);
    if (!Array.isArray(result) || !["created", "existing", "limited"].includes(result[0]) || typeof result[1] !== "string") throw new Error("Invalid reservation.");
    return { state: result[0] as "created" | "existing" | "limited", id: result[1] };
  }
  async get(id: string): Promise<ReviewRecord | null> {
    const result = await this.command(["GET", this.key(`record:${id}`)]);
    if (result === null) return null;
    if (typeof result !== "string") throw new Error("Invalid review record.");
    return JSON.parse(result) as ReviewRecord;
  }
  async save(record: ReviewRecord) {
    if (await this.command(["SET", this.key(`record:${record.id}`), JSON.stringify(record)]) !== "OK") throw new Error("Review was not saved.");
  }
}
