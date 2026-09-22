interface UUIDCrypto {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

/** Secure UUID v4, including iOS 15.0–15.3 where randomUUID is unavailable. */
export function createUUID(provider: UUIDCrypto | undefined = globalThis.crypto): string {
  // Keep the Crypto receiver: Web Crypto methods cannot be called unbound.
  if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  if (typeof provider?.getRandomValues !== "function") {
    throw new Error("Secure random IDs are unavailable. Update iOS or use a supported browser, then try again.");
  }

  const bytes = new Uint8Array(16);
  provider.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
