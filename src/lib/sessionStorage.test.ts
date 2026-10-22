import { describe, expect, it, vi } from "vitest";
import type { ReadFileOptions, RenameOptions, WriteFileOptions } from "@capacitor/filesystem";
import type { SavedAnalysisSession } from "../types";
import {
  createIndexedDbSessionStore,
  createNativeSessionStore,
  createSessionStorage,
  type SessionStore,
} from "./sessionStorage";

function session(id: string, updatedAt = "2026-09-22T00:00:00.000Z"): SavedAnalysisSession {
  return {
    id, version: 1, name: id, createdAt: updatedAt, updatedAt,
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

function decode(value: unknown): SavedAnalysisSession | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return null;
  return value as SavedAnalysisSession;
}

function fixture(current: string | null = null, legacy: string | null = null) {
  let committed = current;
  const store: SessionStore = {
    backend: "indexeddb",
    read: vi.fn(async () => committed),
    write: vi.fn(async (serialized) => { committed = serialized; }),
  };
  const readLegacy = vi.fn(() => legacy);
  const storage = createSessionStorage({ openStore: async () => store, readLegacy });
  return { storage, store, readLegacy, committed: () => committed };
}

describe("session storage safety and migration", () => {
  it("migrates the entire sanitized library without deleting the original", async () => {
    const original = JSON.stringify([session("older", "2026-09-01"), session("newer")]);
    const state = fixture(null, original);
    const result = await state.storage.loadSessionLibrary((value) => {
      const decoded = decode(value);
      return decoded ? { ...decoded, name: `${decoded.name} sanitized` } : null;
    });
    expect(result).toMatchObject({ backend: "indexeddb", migrated: true });
    expect(result.sessions.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(JSON.parse(state.committed()!)[0].name).toBe("newer sanitized");
    expect(state.readLegacy()).toBe(original);
  });

  it("prefers committed data, including an intentionally empty library, over legacy", async () => {
    const state = fixture("[]", JSON.stringify([session("deleted")]));
    const result = await state.storage.loadSessionLibrary(decode);
    expect(result.sessions).toEqual([]);
    expect(state.readLegacy).not.toHaveBeenCalled();
    expect(state.store.write).not.toHaveBeenCalled();
  });

  it.each(["{broken", "{}", '[{"version":2}]', "", JSON.stringify([session("duplicate"), session("duplicate")])])(
    "blocks writes after malformed legacy data: %s", async (legacy) => {
      const state = fixture(null, legacy);
      await expect(state.storage.loadSessionLibrary(decode)).rejects.toThrow("has not been replaced");
      await expect(state.storage.saveSessionLibrary([])).rejects.toThrow("must load successfully");
      expect(state.store.write).not.toHaveBeenCalled();
      expect(state.readLegacy()).toBe(legacy);
    },
  );

  it("does not discard individual unsupported attempts during migration", async () => {
    const state = fixture(null, JSON.stringify([session("valid"), { version: 2 }]));
    await expect(state.storage.loadSessionLibrary(decode)).rejects.toThrow("unsupported data");
    expect(state.store.write).not.toHaveBeenCalled();
  });

  it("does not fallback to legacy when current storage is corrupt or unreadable", async () => {
    const state = fixture("corrupt", JSON.stringify([session("old")]));
    await expect(state.storage.loadSessionLibrary(decode)).rejects.toThrow("has not been replaced");
    vi.mocked(state.store.read).mockRejectedValueOnce(new Error("Device locked"));
    await expect(state.storage.loadSessionLibrary(decode)).rejects.toThrow("could not be opened");
    expect(state.readLegacy).not.toHaveBeenCalled();
    await expect(state.storage.saveSessionLibrary([])).rejects.toThrow("must load successfully");
  });

  it("blocks a new library when legacy storage cannot be checked", async () => {
    const state = fixture();
    state.readLegacy.mockImplementation(() => { throw new Error("SecurityError"); });
    await expect(state.storage.loadSessionLibrary(decode)).rejects.toThrow("could not be opened");
    await expect(state.storage.saveSessionLibrary([])).rejects.toThrow("must load successfully");
    expect(state.store.write).not.toHaveBeenCalled();
  });

  it("returns legacy attempts with a warning when migration fails and allows a retry", async () => {
    const legacy = JSON.stringify([session("kept")]);
    const state = fixture(null, legacy);
    vi.mocked(state.store.write).mockRejectedValueOnce(new Error("Quota exceeded"));
    const result = await state.storage.loadSessionLibrary(decode);
    expect(result).toMatchObject({ migrated: false, sessions: [session("kept")] });
    expect(result.warning).toContain("original library is still intact");
    expect(state.committed()).toBeNull();
    expect(state.readLegacy()).toBe(legacy);
    await expect(state.storage.saveSessionLibrary(result.sessions)).resolves.toEqual({ backend: "indexeddb" });
  });

  it("does not write an empty library as a side effect of first launch", async () => {
    const state = fixture();
    await expect(state.storage.loadSessionLibrary(decode)).resolves.toMatchObject({ sessions: [], migrated: false });
    expect(state.store.write).not.toHaveBeenCalled();
  });

  it("serializes saves, captures values when requested, and reads after the commit", async () => {
    const state = fixture("[]");
    await state.storage.loadSessionLibrary(decode);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    vi.mocked(state.store.write).mockImplementation(async (raw) => {
      writes.push(raw);
      if (writes.length === 1) await pending;
    });
    const first = state.storage.saveSessionLibrary([session("first")]);
    const next = [session("second")];
    const second = state.storage.saveSessionLibrary(next);
    next[0].name = "mutated after request";
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(writes.map((raw) => JSON.parse(raw)[0].name)).toEqual(["first", "second"]);
  });

  it("reports failure without poisoning later saves", async () => {
    const initial = JSON.stringify([session("kept")]);
    const state = fixture(initial);
    await state.storage.loadSessionLibrary(decode);
    vi.mocked(state.store.write).mockRejectedValueOnce(new Error("Full"));
    await expect(state.storage.saveSessionLibrary([])).rejects.toThrow("could not be saved");
    expect(state.committed()).toBe(initial);
    await state.storage.saveSessionLibrary([session("retry")]);
    expect(JSON.parse(state.committed()!)[0].id).toBe("retry");
  });
});

function nativeFixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const filesystem = {
    readdir: vi.fn(async () => ({ files: [...files.keys()].map((name) => ({
      name: name.split("/").at(-1)!, type: "file" as const, size: 0, ctime: 0, mtime: 0, uri: name,
    })) })),
    readFile: vi.fn(async ({ path }: ReadFileOptions) => {
      if (!files.has(path)) throw { code: "OS-PLUG-FILE-0008" };
      return { data: files.get(path)! };
    }),
    writeFile: vi.fn(async ({ path, data }: WriteFileOptions) => {
      if (typeof data !== "string") throw new Error("Expected text");
      files.set(path, data);
      return { uri: path };
    }),
    rename: vi.fn(async ({ from, to }: RenameOptions) => {
      if (files.has(to)) throw new Error("Destination exists");
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => { files.delete(path); }),
  };
  return { files, filesystem };
}

const snapshot = (revision: number) => `climbiq-sessions/library-${String(revision).padStart(16, "0")}.json`;

describe("native saved-attempt snapshots", () => {
  it("commits via staging and keeps a previous complete snapshot", async () => {
    const state = nativeFixture({ [snapshot(1)]: "first", [snapshot(2)]: "second" });
    const store = await createNativeSessionStore(state.filesystem);
    await store.write("third");
    expect(await store.read()).toBe("third");
    expect([...state.files.keys()].sort()).toEqual([snapshot(2), snapshot(3)]);
    expect(state.filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "climbiq-sessions/library.pending.json", directory: "DATA", encoding: "utf8",
    }));
    expect(state.filesystem.rename).toHaveBeenCalledWith(expect.objectContaining({ to: snapshot(3) }));
  });

  it.each(["write", "verification", "rename"])("preserves committed attempts on %s failure", async (failure) => {
    const state = nativeFixture({ [snapshot(1)]: "kept" });
    if (failure === "write") state.filesystem.writeFile.mockRejectedValueOnce(new Error("Full"));
    if (failure === "verification") state.filesystem.readFile.mockResolvedValueOnce({ data: "truncated" });
    if (failure === "rename") state.filesystem.rename.mockRejectedValueOnce(new Error("Rename failed"));
    const store = await createNativeSessionStore(state.filesystem);
    await expect(store.write("new")).rejects.toThrow();
    expect(await store.read()).toBe("kept");
    expect(state.files.get(snapshot(1))).toBe("kept");
    expect(state.files.has(snapshot(2))).toBe(false);
  });

  it("ignores an interrupted staging write but does not hide a corrupt published snapshot", async () => {
    const state = nativeFixture({
      [snapshot(1)]: JSON.stringify([session("old")]), [snapshot(2)]: "broken",
      "climbiq-sessions/library.pending.json": "interrupted",
    });
    const store = await createNativeSessionStore(state.filesystem);
    const storage = createSessionStorage({ openStore: async () => store, readLegacy: () => null });
    await expect(storage.loadSessionLibrary(decode)).rejects.toThrow("has not been replaced");
    await expect(storage.saveSessionLibrary([])).rejects.toThrow("must load successfully");
    expect(state.files.size).toBe(3);
  });

  it("treats only the documented absent-directory error as first launch", async () => {
    const state = nativeFixture();
    const store = await createNativeSessionStore(state.filesystem);
    state.filesystem.readdir.mockRejectedValueOnce({ code: "OS-PLUG-FILE-0008" });
    expect(await store.read()).toBeNull();
    state.filesystem.readdir.mockRejectedValueOnce({ code: "OS-PLUG-FILE-0013", message: "Device locked" });
    await expect(store.read()).rejects.toMatchObject({ code: "OS-PLUG-FILE-0013" });
  });

  it("reports success after commit even if pruning an older backup fails", async () => {
    const state = nativeFixture({ [snapshot(1)]: "first", [snapshot(2)]: "second" });
    state.filesystem.deleteFile.mockRejectedValueOnce(new Error("Cleanup failed"));
    const store = await createNativeSessionStore(state.filesystem);
    await expect(store.write("third")).resolves.toBeUndefined();
    expect(await store.read()).toBe("third");
  });
});

describe("IndexedDB commit boundary", () => {
  function databaseFixture() {
    let request: { onsuccess?: () => void; result?: unknown };
    const transaction = {
      oncomplete: undefined as undefined | (() => void),
      onabort: undefined as undefined | (() => void),
      onerror: undefined as undefined | (() => void),
      error: null as Error | null,
      objectStore: () => ({ put: () => { request = {}; return request; }, get: () => { request = {}; return request; } }),
      abort: () => transaction.onabort?.(),
    };
    const database = { close: vi.fn(), transaction: () => transaction };
    const indexedDb = {
      open: () => {
        const openRequest = { result: database, onsuccess: undefined as undefined | (() => void) };
        queueMicrotask(() => openRequest.onsuccess?.());
        return openRequest;
      },
    } as unknown as IDBFactory;
    return { store: createIndexedDbSessionStore(indexedDb), database, transaction, request: () => request! };
  }

  it("does not report saved at request success before transaction commit", async () => {
    const state = databaseFixture();
    let saved = false;
    const save = state.store.write("[]").then(() => { saved = true; });
    await Promise.resolve();
    await Promise.resolve();
    state.request().onsuccess?.();
    await Promise.resolve();
    expect(saved).toBe(false);
    state.transaction.oncomplete?.();
    await save;
    expect(saved).toBe(true);
    expect(state.database.close).toHaveBeenCalled();
  });

  it("rejects a transaction abort that happens after request success", async () => {
    const state = databaseFixture();
    const save = state.store.write("[]");
    const failure = expect(save).rejects.toThrow("Quota exceeded");
    await Promise.resolve();
    await Promise.resolve();
    state.request().onsuccess?.();
    state.transaction.error = new Error("Quota exceeded");
    state.transaction.onabort?.();
    await failure;
    expect(state.database.close).toHaveBeenCalled();
  });
});
