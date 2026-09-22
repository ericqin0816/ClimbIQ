import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedAnalysisSession } from "../types";
import { loadSessionLibrary, saveSessionLibrary } from "./sessionStorage";

/** A write is committed to the UI only after durable storage accepts it. */
export function useSavedAttempts(decodeSession: (value: unknown) => SavedAnalysisSession | null) {
  const [sessions, setSessions] = useState<SavedAnalysisSession[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [backend, setBackend] = useState<string>("");
  const [loadVersion, setLoadVersion] = useState(0);
  const current = useRef<SavedAnalysisSession[]>([]);
  const initialized = useRef(false);
  const writing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    initialized.current = false;
    setReady(false);
    setError("");
    void loadSessionLibrary(decodeSession).then(result => {
      if (cancelled) return;
      current.current = result.sessions;
      setSessions(result.sessions);
      setBackend(result.backend);
      setNotice(result.warning ?? (result.migrated ? "Your existing saved attempts were moved to the new library. The original backup was kept." : ""));
      initialized.current = true;
      setReady(true);
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Saved attempts could not be opened. Your stored library has not been replaced.");
    });
    return () => { cancelled = true; };
  }, [decodeSession, loadVersion]);

  const updateSessions = useCallback(async (update: (previous: SavedAnalysisSession[]) => SavedAnalysisSession[]) => {
    if (!initialized.current) throw new Error("Wait until your saved attempts have loaded. If loading failed, retry before changing the library.");
    if (writing.current) throw new Error("An attempt is still being saved. Please wait for it to finish.");
    writing.current = true;
    setBusy(true);
    try {
      const next = update(current.current);
      const result = await saveSessionLibrary(next);
      current.current = next;
      setSessions(next);
      setBackend(result.backend);
      setError("");
      return next;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not save. Export this analysis to keep a backup.";
      setError(message);
      throw new Error(message);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }, []);

  const reload = useCallback(() => { if (!writing.current) setLoadVersion(value => value + 1); }, []);
  return { sessions, ready, busy, error, notice, backend, updateSessions, reload };
}
