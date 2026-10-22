import { describe, expect, it, vi } from "vitest";
import type { SavedAnalysisSession } from "../types";
import { createIndexedDbSessionStore, createSessionStorage, type SessionStore } from "./sessionStorage";

function session(id: string): SavedAnalysisSession {
  return {
    id, version: 1, name: id, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
    climberName: "", date: "2026-09-22", location: "", attemptType: "Training", notes: "",
    videoMetadata: null, zones: {}, startLightCalibration: {}, timestamps: [],
    settings: {
      startSearchStart: 0, startSearchEnd: 12, startSensitivity: "medium", startLightVisibility: "clear",
      startDetectionProfile: "auto", reactionTimeOffset: 0.2, startSignalOffset: 0,
      movementSensitivity: "medium", firstMovementDefinition: "earliest", committedLaunchMinDelay: 0.1,
      firstMovementOffset: 0, officialTotalTime: "",
    },
  };
}

const decode = (value: unknown) => value as SavedAnalysisSession;

/** A minimal transactional key/value IndexedDB double. Transactions share a
 * lock and commit staged puts together; abort discards them. The production
 * adapter controls all requests and comparisons, rather than the double
 * emulating the proposed compare-and-swap behavior for it. */
function sharedDatabase(initial?: unknown) {
  let committed = initial;
  let transactionQueue = Promise.resolve();
  let failNextPut: Error | undefined;
  type Request = { result?: unknown; onsuccess?: () => void };

  const database = {
    close: vi.fn(),
    transaction() {
      let staged = committed;
      let hasPut = false;
      let aborted = false;
      const operations: Array<() => void> = [];
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        error: null as Error | null,
        abort: () => { aborted = true; },
        objectStore: () => ({
          get: () => {
            const request: Request = {};
            operations.push(() => { request.result = hasPut ? staged : committed; request.onsuccess?.(); });
            return request;
          },
          put: (value: unknown) => {
            const request: Request = {};
            operations.push(() => {
              if (failNextPut) {
                transaction.error = failNextPut;
                failNextPut = undefined;
                aborted = true;
                return;
              }
              staged = value;
              hasPut = true;
              request.onsuccess?.();
            });
            return request;
          },
        }),
      };
      transactionQueue = transactionQueue.then(async () => {
        while (operations.length && !aborted) {
          await Promise.resolve();
          operations.shift()!();
        }
        if (aborted) transaction.onabort?.();
        else {
          if (hasPut) committed = staged;
          transaction.oncomplete?.();
        }
      });
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } as unknown as IDBFactory;
  return {
    factory,
    value: () => committed,
    failNextWrite: (error: Error) => { failNextPut = error; },
    store: () => createIndexedDbSessionStore(factory),
  };
}

function client(store: SessionStore, legacy: () => string | null = () => null) {
  return createSessionStorage({ openStore: async () => store, readLegacy: legacy });
}

describe("saved-library writes across independent browser tabs", () => {
  it("does not let a stale second tab erase a newly saved attempt", async () => {
    const database = sharedDatabase("[]");
    const first = client(database.store());
    const second = client(database.store());
    await Promise.all([first.loadSessionLibrary(decode), second.loadSessionLibrary(decode)]);
    await first.saveSessionLibrary([session("first-tab")]);
    await expect(second.saveSessionLibrary([session("second-tab")])).rejects.toMatchObject({ code: "conflict" });
    expect(JSON.parse(database.value() as string).map((item: SavedAnalysisSession) => item.id)).toEqual(["first-tab"]);
  });

  it("compares and replaces inside the same transaction when two saves race", async () => {
    const database = sharedDatabase("[]");
    const tabs = [client(database.store()), client(database.store())];
    await Promise.all(tabs.map(tab => tab.loadSessionLibrary(decode)));
    const results = await Promise.allSettled(tabs.map((tab, index) => tab.saveSessionLibrary([session(`tab-${index}`)])));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected");
    expect(failure).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
  });

  it("requires reload after conflict and then permits saving against the current snapshot", async () => {
    const database = sharedDatabase("[]");
    const first = client(database.store());
    const stale = client(database.store());
    await Promise.all([first.loadSessionLibrary(decode), stale.loadSessionLibrary(decode)]);
    await first.saveSessionLibrary([session("first")]);
    await expect(stale.saveSessionLibrary([session("draft")])).rejects.toMatchObject({ code: "conflict" });
    await expect(stale.saveSessionLibrary([])).rejects.toThrow("must load successfully");
    const refreshed = await stale.loadSessionLibrary(decode);
    await stale.saveSessionLibrary([...refreshed.sessions, session("draft-copy")]);
    expect(JSON.parse(database.value() as string).map((item: SavedAnalysisSession) => item.id)).toEqual(["first", "draft-copy"]);
  });

  it("protects the first save when another tab creates the previously absent library", async () => {
    const database = sharedDatabase();
    const first = client(database.store());
    const stale = client(database.store());
    await Promise.all([first.loadSessionLibrary(decode), stale.loadSessionLibrary(decode)]);
    await first.saveSessionLibrary([session("created-first")]);
    await expect(stale.saveSessionLibrary([])).rejects.toMatchObject({ code: "conflict" });
    expect(JSON.parse(database.value() as string)[0].id).toBe("created-first");
  });

  it("cannot overwrite a concurrently created library while migrating legacy storage", async () => {
    const database = sharedDatabase();
    const adapter = database.store();
    const other = client(database.store());
    await other.loadSessionLibrary(decode);
    const legacy = JSON.stringify([session("legacy")]);
    const migrating = client({
      ...adapter,
      async read() {
        const observed = await adapter.read();
        await other.saveSessionLibrary([session("concurrent")]);
        return observed;
      },
    }, () => legacy);
    await expect(migrating.loadSessionLibrary(decode)).rejects.toMatchObject({ code: "conflict" });
    await expect(migrating.saveSessionLibrary([])).rejects.toThrow("must load successfully");
    expect(JSON.parse(database.value() as string)[0].id).toBe("concurrent");
  });

  it("compares the original stored bytes even when decoding sanitizes and reorders them", async () => {
    const original = JSON.stringify([session("second"), session("first")], null, 2);
    const database = sharedDatabase(original);
    const tab = client(database.store());
    const loaded = await tab.loadSessionLibrary(value => ({ ...decode(value), notes: "Sanitized" }));
    await expect(tab.saveSessionLibrary(loaded.sessions)).resolves.toEqual({ backend: "indexeddb" });
    expect(JSON.parse(database.value() as string).every((item: SavedAnalysisSession) => item.notes === "Sanitized")).toBe(true);
  });

  it("advances its own expected snapshot only after successful commits", async () => {
    const database = sharedDatabase("[]");
    const tab = client(database.store());
    await tab.loadSessionLibrary(decode);
    await tab.saveSessionLibrary([session("one")]);
    database.failNextWrite(new Error("Quota exceeded"));
    await expect(tab.saveSessionLibrary([session("two")])).rejects.toThrow("could not be saved");
    await expect(tab.saveSessionLibrary([session("retry")])).resolves.toEqual({ backend: "indexeddb" });
    expect(JSON.parse(database.value() as string)[0].id).toBe("retry");
  });
});
