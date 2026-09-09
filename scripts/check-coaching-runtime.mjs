import assert from "node:assert/strict";

// Exercise the emitted function with Node's ESM resolver, not Vite/Vitest's
// extensionless-import support. Never enable a provider call in this smoke test.
process.env.COACHING_ENABLED = "0";
const { default: handler } = await import("../test-results/coaching-runtime/api/coaching.js");
const status = await handler.fetch(new Request("https://climbiq.test/api/coaching?status=1"));
assert.equal(status.status, 200);
assert.deepEqual(await status.json(), { enabled: false, provider: "NVIDIA NIM", mode: "private-workspace" });
const disabled = await handler.fetch(new Request("https://climbiq.test/api/coaching", { method: "POST" }));
assert.equal(disabled.status, 503);
console.log("Compiled Node ESM function: status and disabled-request smoke checks passed.");
