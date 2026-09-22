interface VisibilitySource {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
interface ScreenLock {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}
interface ScreenLockProvider { request(type: "screen"): Promise<ScreenLock> }

/** Best effort only: an unsupported or denied wake lock never blocks analysis. */
export function holdScreenForAnalysis(document: VisibilitySource, provider?: ScreenLockProvider): () => void {
  if (!provider) return () => {};
  let stopped = false;
  let pending = false;
  let current: ScreenLock | undefined;
  let removeReleaseListener: (() => void) | undefined;

  const release = () => {
    removeReleaseListener?.();
    removeReleaseListener = undefined;
    const lock = current;
    current = undefined;
    if (lock) void lock.release().catch(() => undefined);
  };
  const request = async () => {
    if (stopped || pending || current || document.visibilityState !== "visible") return;
    pending = true;
    try {
      const lock = await provider.request("screen");
      if (stopped || document.visibilityState !== "visible") {
        await lock.release().catch(() => undefined);
        return;
      }
      current = lock;
      const onRelease = () => {
        if (current === lock) { current = undefined; removeReleaseListener?.(); removeReleaseListener = undefined; }
      };
      lock.addEventListener("release", onRelease);
      removeReleaseListener = () => lock.removeEventListener("release", onRelease);
    } catch { /* Permission, battery, or browser policy may deny this request. */ }
    finally { pending = false; }
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void request();
    else release();
  };
  document.addEventListener("visibilitychange", onVisibility);
  void request();
  return () => { stopped = true; document.removeEventListener("visibilitychange", onVisibility); release(); };
}
