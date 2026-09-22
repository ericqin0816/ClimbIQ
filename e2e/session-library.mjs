/** Read committed storage, independent of React state or application helpers. */
export async function readSessionLibraryJson(evaluate) {
  return evaluate(`(${readCommittedLibrary.toString()})()`);
}

async function readCommittedLibrary() {
  const legacy = () => localStorage.getItem("climbiq.analysisSessions.v1") ?? "[]";
  if (typeof indexedDB === "undefined") return legacy();
  const databases = await indexedDB.databases();
  if (!databases.some(database => database.name === "climbiq")) return legacy();

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("climbiq");
    let removed = false;
    // The database can disappear between databases() and open(). Abort its
    // creation so inspecting an old public build never creates a new store.
    request.onupgradeneeded = () => { removed = true; request.transaction.abort(); };
    request.onerror = () => removed ? resolve(null) : reject(request.error);
    request.onblocked = () => reject(new Error("Saved-attempt database is blocked."));
    request.onsuccess = () => resolve(request.result);
  });
  if (!database) return legacy();
  try {
    if (!database.objectStoreNames.contains("session-libraries")) {
      throw new Error("Saved-attempt database is missing its library store.");
    }
    const raw = await new Promise((resolve, reject) => {
      const transaction = database.transaction("session-libraries", "readonly");
      const request = transaction.objectStore("session-libraries").get("analysisSessions.v1");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Saved-attempt read aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Saved-attempt read failed."));
    });
    if (raw === undefined) return legacy();
    if (typeof raw !== "string" || !Array.isArray(JSON.parse(raw))) {
      throw new Error("Committed saved-attempt library is malformed.");
    }
    return raw;
  } finally {
    database.close();
  }
}

/** Click the public control and await a changed, committed library snapshot. */
export async function saveCurrentSession(evaluate, timeoutMs = 20000) {
  const ready = `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save Session');
    return Boolean(button && button.getClientRects().length && !button.disabled);
  })()`;
  const started = Date.now();
  while (!(await evaluate(ready))) {
    if (Date.now() - started >= timeoutMs) throw new Error("Save Session did not become available.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const before = await readSessionLibraryJson(evaluate);
  await evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save Session')).click()`);
  return waitForSessionLibraryChange(evaluate, before, timeoutMs);
}

/** Also used for duplicate/import flows before navigation or reload. */
export async function waitForSessionLibraryChange(evaluate, before, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readSessionLibraryJson(evaluate);
    const settled = await evaluate(`(() => {
      const state = document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState;
      return !state || state === 'ready';
    })()`);
    if (current !== before && settled) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = await evaluate(`document.querySelector('[data-session-storage-state]')?.dataset.sessionStorageState ?? ''`);
  throw new Error(`Save Session did not commit a changed library. ${status}`);
}
