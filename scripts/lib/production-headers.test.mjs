import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preview } from "vite";
import { productionHeadersForPath, productionHeadersPlugin, productionPreviewHeaders } from "./production-headers.mjs";

let root, server;
afterEach(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); root = server = undefined; });

describe("production preview policy", () => {
  it("serves HTML and analysis assets under the checked-in security and scoped cache policies", async () => {
    root = await mkdtemp(path.join(tmpdir(), "climbiq-preview-contract-"));
    const dist = path.join(root, "dist");
    await mkdir(path.join(dist, "models"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Policy contract</title>");
    await writeFile(path.join(dist, "models/model.task"), "synthetic asset");
    server = await preview({ root, configFile: false, logLevel: "silent", plugins: [productionHeadersPlugin()],
      preview: { host: "127.0.0.1", port: 0, headers: productionPreviewHeaders } });
    const address = server.httpServer.address();
    for (const pathname of ["/", "/models/model.task"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toContain("worker-src 'self' blob:");
      expect(response.headers.get("Content-Security-Policy")).toContain("'wasm-unsafe-eval'");
      for (const [key, value] of Object.entries(productionHeadersForPath(pathname))) expect(response.headers.get(key)).toBe(value);
      if (pathname.startsWith("/models/")) expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
      await response.arrayBuffer();
    }
  });
});
