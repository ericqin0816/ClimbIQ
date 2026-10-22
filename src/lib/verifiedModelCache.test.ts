import { describe, expect, it, vi } from "vitest";
import { createVerifiedModelCache, type VerifiedModelDefinition } from "./verifiedModelCache";

const definition: VerifiedModelDefinition = { url: "capacitor://localhost/models/pose.task", expectedBytes: 3, sha256: "010203" };
const bytes = () => new Uint8Array([4, 5, 6]);
const response = () => new Response(bytes(), { headers: { "content-type": "application/octet-stream" } });
const digest = () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }

describe("verified model cache", () => {
  it("fetches and verifies once, but returns independent bytes to every task", async () => {
    const fetcher = vi.fn(async () => response()); const hasher = vi.fn(digest);
    const cache = createVerifiedModelCache({ fetch: fetcher, digest: hasher });
    const first = await cache.load(definition); first[0] = 99;
    expect(await cache.load(definition)).toEqual(bytes());
    expect(fetcher).toHaveBeenCalledTimes(1); expect(hasher).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight verification without sharing mutable output", async () => {
    const request = deferred<Response>(); const fetcher = vi.fn(() => request.promise);
    const cache = createVerifiedModelCache({ fetch: fetcher, digest });
    const first = cache.load(definition), second = cache.load(definition);
    request.resolve(response()); const [a,b] = await Promise.all([first,second]);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(a).not.toBe(b); expect(a).toEqual(b);
  });

  it("cancels a subscriber promptly while preserving another subscriber's request", async () => {
    const request = deferred<Response>(); let underlying!: AbortSignal;
    const cache = createVerifiedModelCache({ fetch: (_, options) => {underlying=options.signal;return request.promise;}, digest });
    const controller = new AbortController();
    const first = cache.load(definition, controller.signal), second = cache.load(definition);
    controller.abort(); await expect(first).rejects.toMatchObject({name:"AbortError"});
    expect(underlying.aborted).toBe(false);
    request.resolve(response()); expect(await second).toEqual(bytes());
  });

  it("aborts the underlying request when all subscribers cancel and allows immediate retry", async () => {
    const request = deferred<Response>(); let underlying!: AbortSignal;
    const fetcher = vi.fn().mockImplementationOnce((_, options) => {underlying=options.signal;return request.promise;}).mockImplementation(async () => response());
    const cache = createVerifiedModelCache({ fetch: fetcher, digest });
    const controller = new AbortController(); const first = cache.load(definition, controller.signal);
    controller.abort(); await expect(first).rejects.toMatchObject({name:"AbortError"});
    expect(underlying.aborted).toBe(true);
    expect(await cache.load(definition)).toEqual(bytes());
    request.reject(new DOMException("Aborted", "AbortError"));
    expect(await cache.load(definition)).toEqual(bytes()); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not fetch or serve cached data for a pre-cancelled task", async () => {
    const fetcher = vi.fn(async () => response()); const cache = createVerifiedModelCache({fetch:fetcher,digest});
    const controller = new AbortController();controller.abort();
    await expect(cache.load(definition,controller.signal)).rejects.toMatchObject({name:"AbortError"});
    expect(fetcher).not.toHaveBeenCalled();
    await cache.load(definition);
    await expect(cache.load(definition,controller.signal)).rejects.toMatchObject({name:"AbortError"});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTML fallback", () => new Response("bad", {headers:{"content-type":"text/html"}}), digest, /missing|HTML/],
    ["wrong length", () => new Response(new Uint8Array([1])), digest, /size check/],
    ["bad digest", response, async () => new Uint8Array([9]).buffer, /integrity check/],
    ["HTTP error", () => new Response("bad", {status:404}), digest, /missing/],
  ] as const)("does not retain %s failures", async (_, invalid, hasher, message) => {
    const fetcher = vi.fn(async () => invalid()); const cache = createVerifiedModelCache({fetch:fetcher,digest:hasher});
    await expect(cache.load(definition)).rejects.toThrow(message);
    await expect(cache.load(definition)).rejects.toThrow(message); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keys verification by URL, expected size and hash", async () => {
    const fetcher = vi.fn(async () => response()); const cache = createVerifiedModelCache({fetch:fetcher,digest});
    await cache.load(definition);
    await cache.load({...definition,url:"https://example.test/model.task"});
    await expect(cache.load({...definition,expectedBytes:4})).rejects.toThrow(/size/);
    await expect(cache.load({...definition,sha256:"00"})).rejects.toThrow(/integrity/);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects cancellation during hashing and does not publish that result", async () => {
    const hashing = deferred<ArrayBuffer>(); const fetcher=vi.fn(async()=>response());
    const hasher=vi.fn().mockImplementationOnce(()=>hashing.promise).mockImplementation(digest);
    const cache=createVerifiedModelCache({fetch:fetcher,digest:hasher});
    const controller=new AbortController();const first=cache.load(definition,controller.signal);
    await vi.waitFor(()=>expect(hasher).toHaveBeenCalledTimes(1));
    controller.abort();await expect(first).rejects.toMatchObject({name:"AbortError"});
    hashing.resolve(new Uint8Array([1,2,3]).buffer);
    expect(await cache.load(definition)).toEqual(bytes());expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("can release the retained model and prevents an older request repopulating it", async () => {
    const request=deferred<Response>();const fetcher=vi.fn().mockImplementationOnce(()=>request.promise).mockImplementation(async()=>response());
    const cache=createVerifiedModelCache({fetch:fetcher,digest});
    const first=cache.load(definition);cache.clear();request.resolve(response());await first;
    await cache.load(definition);cache.clear();await cache.load(definition);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
