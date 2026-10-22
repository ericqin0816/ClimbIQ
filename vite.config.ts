import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createLocalCoachingHandler } from "./server/localCoaching";
import { fileURLToPath } from "node:url";
import { readAppBuild } from "./scripts/lib/app-build.mjs";
import { productionHeadersPlugin, productionPreviewHeaders } from "./scripts/lib/production-headers.mjs";

export default defineConfig(({ mode }) => {
  const build = readAppBuild(fileURLToPath(new URL(".", import.meta.url)));
  return {
    define: { __CLIMBIQ_BUILD__: JSON.stringify(build) },
    preview: { headers: productionPreviewHeaders },
    plugins: [react(), productionHeadersPlugin(), {
      name: "app-build-provenance",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(build, null, 2) + "\n" });
      },
    }, {
      name: "local-coaching-api",
      configureServer(server) {
        // These variables are used only in this Node middleware, never Vite's client define.
        const handler = createLocalCoachingHandler({ ...loadEnv(mode, process.cwd(), ""), ...process.env });
        server.middlewares.use("/api/coaching", async (req, res) => {
          try {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 8192) { res.statusCode = 413; res.end('{"error":"Request too large."}'); return; }
              chunks.push(Buffer.from(chunk));
            }
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
            const response = await handler(new Request(`http://localhost/api/coaching${req.url ?? ""}`, {
              method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
            }), req.socket.remoteAddress);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(await response.text());
          } catch { res.statusCode = 503; res.end('{"error":"Local coaching unavailable."}'); }
        });
      },
    }],
  };
});
