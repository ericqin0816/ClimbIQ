import { mkdir, writeFile } from "node:fs/promises";
import { createProtocolClient } from "./cdp-client.mjs";
import { startTestBrowser } from "./test-browser.mjs";

// A fresh browser profile owns all test data. Two real tabs exercise the public
// storage service against native IndexedDB transactions; no private footage or
// user-browser library is accessed.
const appUrl = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const browser = await startTestBrowser({ label: "library-race" });
const port = browser.port;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clients = [];
const report = { appUrl, syntheticLibrary: true, scenarios: [] };

async function openClient() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error("Could not open an isolated library test tab.");
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const { send } = createProtocolClient(socket);
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const client = { socket, send, evaluate };
  clients.push(client);
  // /json/new returns before navigation completes. Importing root-relative
  // modules from its initial about:blank races on fast CI debugger connections.
  await send("Runtime.enable");
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      ready = await evaluate(`location.origin === ${JSON.stringify(new URL(appUrl).origin)} && !!document.querySelector('main[data-session-storage-state="ready"]')`);
    } catch (error) {
      if (!/context.*(destroyed|found)|navigat/i.test(String(error))) throw error;
    }
    if (ready) break;
    await delay(50);
  }
  if (!ready) throw new Error("The isolated library test page did not finish navigation and storage initialization.");
  await evaluate(`(${installHarness.toString()})()`);
  return client;
}

function session(id) {
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

try {
  const tabs = await Promise.all([openClient(), openClient()]);

  for (const existing of [false, true]) {
    const initial = existing ? [session("existing")] : [];
    await tabs[0].evaluate(`window.__libraryRace.replace(${existing ? JSON.stringify(JSON.stringify(initial)) : "undefined"})`);
    await Promise.all(tabs.map(tab => tab.evaluate("window.__libraryRace.loadFresh()")));
    const snapshots = tabs.map((_, index) => [...initial, session(`tab-${index}`)]);
    const writes = await Promise.all(tabs.map((tab, index) => tab.evaluate(`window.__libraryRace.save(${JSON.stringify(snapshots[index])})`)));
    if (writes.filter(result => result.saved).length !== 1 || writes.filter(result => result.code === "conflict").length !== 1) {
      throw new Error(`Concurrent ${existing ? "existing" : "absent"} writes did not produce exactly one commit and one conflict: ${JSON.stringify(writes)}`);
    }
    const winner = writes.findIndex(result => result.saved), loser = 1 - winner;
    const stored = await tabs[0].evaluate("window.__libraryRace.readStored()");
    if (!stored.present || stored.value !== JSON.stringify(snapshots[winner])) throw new Error("The failed contender changed the winning library.");
    const blocked = await tabs[loser].evaluate("window.__libraryRace.save([])");
    if (blocked.saved || !blocked.message.includes("must load successfully")) throw new Error("A conflicted tab wrote again without reloading.");
    const current = await tabs[loser].evaluate("window.__libraryRace.reload()");
    const recovered = [...current, session("unsaved-copy")];
    const retry = await tabs[loser].evaluate(`window.__libraryRace.save(${JSON.stringify(recovered)})`);
    if (!retry.saved) throw new Error("A reloaded tab could not save against its current snapshot.");
    const retained = await tabs[winner].evaluate("window.__libraryRace.readStored()");
    if (retained.value !== JSON.stringify(recovered)) throw new Error("Reload-and-retry did not preserve the newer attempts.");
    report.scenarios.push({ existing, oneCommit: true, conflictRetainedWinner: true, reloadRequired: true, retryPreservedNewerAttempts: true });
  }

  for (const foreign of [null, { format: "future-library", data: ["preserve-me"] }, "{broken-json"]) {
    await tabs[0].evaluate("window.__libraryRace.replace(undefined)");
    await tabs[1].evaluate("window.__libraryRace.loadFresh()");
    await tabs[0].evaluate(`window.__libraryRace.replace(${JSON.stringify(foreign)})`);
    const write = await tabs[1].evaluate(`window.__libraryRace.save(${JSON.stringify([session("must-not-replace")])})`);
    if (write.saved || write.code !== "conflict") throw new Error("Foreign stored data was not protected by the comparison.");
    const reload = await tabs[1].evaluate("window.__libraryRace.reload().then(() => ({loaded:true}), error => ({loaded:false,message:error.message}))");
    const stored = await tabs[0].evaluate("window.__libraryRace.readStored()");
    if (reload.loaded || !stored.present || JSON.stringify(stored.value) !== JSON.stringify(foreign)) {
      throw new Error("Unreadable data was replaced or reported as an empty library.");
    }
    report.scenarios.push({ foreignType: foreign === null ? "null" : typeof foreign,
      rejectedStaleWrite: true, refusedUnreadableReload: true, originalRetained: true });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  try { await browser.close(clients[0]?.send); }
  finally { clients.forEach(client => client.socket.close()); }
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/library-concurrency.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function installHarness() {
  const { createSessionStorage, createIndexedDbSessionStore } = await import("/src/lib/sessionStorage.ts");
  let client;
  const decode = value => value && value.version === 1 && typeof value.id === "string" &&
    typeof value.name === "string" && typeof value.updatedAt === "string" ? value : null;
  async function transact(mode, operation, value) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("climbiq", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("session-libraries")) request.result.createObjectStore("session-libraries");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test database unexpectedly blocked."));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("session-libraries", mode);
        const store = transaction.objectStore("session-libraries");
        const request = operation === "read" ? store.get("analysisSessions.v1")
          : value === undefined ? store.delete("analysisSessions.v1") : store.put(value, "analysisSessions.v1");
        transaction.oncomplete = () => resolve({ present: request.result !== undefined, value: request.result ?? null });
        transaction.onabort = () => reject(transaction.error ?? new Error("Test transaction aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Test transaction failed."));
      });
    } finally { database.close(); }
  }
  window.__libraryRace = {
    async loadFresh() {
      client = createSessionStorage({ openStore: async () => createIndexedDbSessionStore(indexedDB), readLegacy: () => null });
      return this.reload();
    },
    async reload() { return (await client.loadSessionLibrary(decode)).sessions; },
    async save(sessions) {
      try { await client.saveSessionLibrary(sessions); return { saved: true }; }
      catch (error) { return { saved: false, code: error.code, name: error.name, message: error.message }; }
    },
    replace: value => transact("readwrite", "replace", value),
    readStored: () => transact("readonly", "read"),
  };
  return true;
}
