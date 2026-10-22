import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
const rules = config.headers.map(rule => {
  // These are the repository's regular-expression paths, not arbitrary routing templates.
  if (rule.source.includes(":")) throw new Error(`Unsupported preview header path: ${rule.source}`);
  return { path: new RegExp(`^${rule.source}$`), headers: rule.headers };
});

export function productionHeadersForPath(pathname) {
  const headers = {};
  for (const rule of rules) if (rule.path.test(pathname)) {
    for (const header of rule.headers) headers[header.key] = header.value;
  }
  return headers;
}

export const productionPreviewHeaders = productionHeadersForPath("/");

/** Apply the same checked-in policy to preview HTML, workers, WASM, and media. */
export function productionHeadersPlugin() {
  return {
    name: "production-preview-headers",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://preview.invalid").pathname;
        for (const [key, value] of Object.entries(productionHeadersForPath(pathname))) response.setHeader(key, value);
        next();
      });
    },
  };
}
