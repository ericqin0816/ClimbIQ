/** Resolve packaged assets with the full document URL, including native schemes.
 * `new URL("capacitor://localhost").origin` is "null", so origin is not a base.
 */
export function resolveAppAssetUrl(relativePath: string, baseUrl: string, documentUrl: string): string {
  const base = baseUrl === "" ? "./" : baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\/+/, ""), new URL(base, documentUrl)).toString();
}
