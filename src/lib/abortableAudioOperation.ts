/** Stop waiting for a native operation when its owner cancels. The operation
 * may settle later; callers still own source checks and context cleanup.
 */
export async function waitForAudioOperation<T>(operation: () => Promise<T>, signal: AbortSignal | undefined,
  message: string, onCancel?: () => void): Promise<T> {
  if (!signal) return operation();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      onCancel?.();
      const error = new Error(message);
      error.name = "AbortError"; reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([aborted, signal.aborted ? aborted : operation()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
