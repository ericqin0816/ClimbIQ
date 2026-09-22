import { Capacitor } from "@capacitor/core";
import type { FilesystemPlugin } from "@capacitor/filesystem";
import type { SavedAnalysisSession } from "../types";

export const LEGACY_SESSION_STORAGE_KEY = "climbiq.analysisSessions.v1";
export type SessionStorageBackend = "indexeddb" | "native-filesystem";
export type SessionDecoder = (value: unknown) => SavedAnalysisSession | null;

export interface SessionLibraryLoadResult {
  sessions: SavedAnalysisSession[];
  backend: SessionStorageBackend;
  migrated: boolean;
  warning?: string;
}

export interface SessionLibrarySaveResult {
  backend: SessionStorageBackend;
}

/** A write must replace the complete library or preserve the previous one. */
export interface SessionStore {
  backend: SessionStorageBackend;
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
}

interface SessionStorageDependencies {
  openStore(): Promise<SessionStore>;
  readLegacy(): string | null;
}

export class SessionStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SessionStorageError";
  }
}

/**
 * Serialize reads and writes within this app instance. Callers must await a
 * successful initial load and gate mutations while their save is pending.
 * Separate browser tabs remain independent editors (last committed save wins).
 */
export function createSessionStorage(dependencies: SessionStorageDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  let loaded = false;
  let store: SessionStore | undefined;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  async function getStore(): Promise<SessionStore> {
    store ??= await dependencies.openStore();
    return store;
  }

  return {
    loadSessionLibrary(decodeSession: SessionDecoder): Promise<SessionLibraryLoadResult> {
      return enqueue(async () => {
        loaded = false;
        try {
          const currentStore = await getStore();
          const current = await currentStore.read();
          if (current !== null) {
            const sessions = decodeLibrary(current, decodeSession);
            loaded = true;
            return { sessions, backend: currentStore.backend, migrated: false };
          }

          // Access may throw (for example, blocked site storage). Do not treat
          // that as an empty legacy library and permit its replacement.
          const legacy = dependencies.readLegacy();
          const sessions = legacy === null ? [] : decodeLibrary(legacy, decodeSession);
          if (legacy !== null) {
            try {
              await currentStore.write(JSON.stringify(sessions));
            } catch (error) {
              loaded = true;
              return {
                sessions,
                backend: currentStore.backend,
                migrated: false,
                warning: "Your previous attempts were loaded, but could not be copied to the new storage. " +
                  "The original library is still intact. Export a library backup before continuing.",
              };
            }
          }

          // Retain the legacy entry even after successful migration so a
          // previous app version or manual recovery can still access it.
          loaded = true;
          return { sessions, backend: currentStore.backend, migrated: legacy !== null };
        } catch (error) {
          if (error instanceof SessionStorageError) throw error;
          throw new SessionStorageError(
            "Saved attempts could not be opened. Saving is disabled to protect the existing library. " +
            "Retry after reopening the app; you can still export your current analysis.",
            error,
          );
        }
      });
    },

    saveSessionLibrary(sessions: SavedAnalysisSession[]): Promise<SessionLibrarySaveResult> {
      // Capture at invocation, before waiting on another save. A later state
      // mutation must not change an already-requested snapshot.
      let serialized: string;
      try {
        serialized = JSON.stringify(sessions);
        if (!Array.isArray(sessions)) throw new Error("Expected a session array.");
      } catch (error) {
        return Promise.reject(new SessionStorageError("This attempt could not be prepared for saving. Export your analysis before closing the app.", error));
      }

      return enqueue(async () => {
        if (!loaded) {
          throw new SessionStorageError("Saved attempts must load successfully before the library can be changed.");
        }
        try {
          const currentStore = await getStore();
          await currentStore.write(serialized);
          return { backend: currentStore.backend };
        } catch (error) {
          throw new SessionStorageError(
            "This change could not be saved on this device. Your previous saved attempts are still intact. " +
            "Free some storage and try again, or export your analysis before closing the app.",
            error,
          );
        }
      });
    },
  };
}

function decodeLibrary(serialized: string, decodeSession: SessionDecoder): SavedAnalysisSession[] {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) throw new Error("Expected an array.");
    const ids = new Set<string>();
    return value.map((item) => {
      const session = decodeSession(item);
      if (!session || ids.has(session.id)) throw new Error("Invalid or duplicate saved attempt.");
      ids.add(session.id);
      return session;
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    throw new SessionStorageError(
      "The saved-attempt library contains unreadable or unsupported data. It has not been replaced. " +
      "Saving is disabled to protect it; export your current analysis for safekeeping.",
      error,
    );
  }
}

const DATABASE_NAME = "climbiq";
const OBJECT_STORE = "session-libraries";
const LIBRARY_KEY = "analysisSessions.v1";

export function createIndexedDbSessionStore(indexedDb: IDBFactory): SessionStore {
  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
          request.result.createObjectStore(OBJECT_STORE);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open saved-attempt storage."));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Close other ClimbIQ tabs and retry opening saved attempts."));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  async function transact(mode: IDBTransactionMode, serialized?: string): Promise<string | null> {
    const database = await openDatabase();
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction(OBJECT_STORE, mode);
        const objectStore = transaction.objectStore(OBJECT_STORE);
        const request = mode === "readonly"
          ? objectStore.get(LIBRARY_KEY)
          : objectStore.put(serialized, LIBRARY_KEY);
        let result: string | null = null;
        request.onsuccess = () => {
          if (mode !== "readonly" || request.result === undefined) return;
          if (typeof request.result !== "string") {
            transaction.abort();
            return;
          }
          result = request.result;
        };
        // Request success is not durability: wait for the transaction commit.
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error("Saved-attempt transaction was aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Saved-attempt transaction failed."));
      });
    } finally {
      database.close();
    }
  }

  return {
    backend: "indexeddb",
    read: () => transact("readonly"),
    write: async (serialized) => { await transact("readwrite", serialized); },
  };
}

type NativeFilesystem = Pick<FilesystemPlugin, "readdir" | "readFile" | "writeFile" | "rename" | "deleteFile">;
const NATIVE_DIRECTORY = "climbiq-sessions";
const SNAPSHOT_PATTERN = /^library-(\d{16})\.json$/;

export async function createNativeSessionStore(filesystem: NativeFilesystem): Promise<SessionStore> {
  const { Directory, Encoding } = await import("@capacitor/filesystem");
  const directory = Directory.Data;
  const encoding = Encoding.UTF8;

  async function snapshotNames(): Promise<string[]> {
    try {
      const listing = await filesystem.readdir({ path: NATIVE_DIRECTORY, directory });
      return listing.files.map((file) => file.name).filter((name) => SNAPSHOT_PATTERN.test(name)).sort().reverse();
    } catch (error) {
      // Capacitor 8's explicit file-not-found code; permission, bridge and I/O
      // failures must not authorize an empty replacement library.
      if (error && typeof error === "object" && "code" in error && error.code === "OS-PLUG-FILE-0008") return [];
      throw error;
    }
  }

  return {
    backend: "native-filesystem",
    async read() {
      const [latest] = await snapshotNames();
      if (!latest) return null;
      const result = await filesystem.readFile({ path: `${NATIVE_DIRECTORY}/${latest}`, directory, encoding });
      if (typeof result.data !== "string") throw new Error("Saved-attempt file was not text.");
      return result.data;
    },
    async write(serialized) {
      const previous = await snapshotNames();
      const sequence = previous.length ? Number(SNAPSHOT_PATTERN.exec(previous[0])![1]) + 1 : 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Saved-attempt revision limit reached.");
      const filename = `library-${String(sequence).padStart(16, "0")}.json`;
      const temporaryPath = `${NATIVE_DIRECTORY}/library.pending.json`;

      // Capacitor's native writeFile itself is not atomic. Write to staging,
      // verify it, then publish a NEW filename; the current snapshot survives
      // every failed write or rename. An interrupted staging file is ignored.
      await filesystem.writeFile({ path: temporaryPath, directory, encoding, data: serialized, recursive: true });
      const written = await filesystem.readFile({ path: temporaryPath, directory, encoding });
      if (written.data !== serialized) throw new Error("Saved-attempt verification failed.");
      await filesystem.rename({ from: temporaryPath, to: `${NATIVE_DIRECTORY}/${filename}`, directory });

      // Keep one prior complete snapshot for recovery. Cleanup cannot turn a
      // successfully committed save into a reported failure.
      await Promise.all(previous.slice(1).map((name) =>
        filesystem.deleteFile({ path: `${NATIVE_DIRECTORY}/${name}`, directory }).catch(() => undefined),
      ));
    },
  };
}

const sessionStorage = createSessionStorage({
  async openStore() {
    if (Capacitor.isNativePlatform()) {
      const { Filesystem } = await import("@capacitor/filesystem");
      return createNativeSessionStore(Filesystem);
    }
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
    return createIndexedDbSessionStore(indexedDB);
  },
  readLegacy: () => window.localStorage.getItem(LEGACY_SESSION_STORAGE_KEY),
});

export const loadSessionLibrary = sessionStorage.loadSessionLibrary;
export const saveSessionLibrary = sessionStorage.saveSessionLibrary;
