# Browser test ownership

## Production user workflows

Run `npx playwright install chromium webkit` once, then `npm run test:workflow`.
This builds `dist` and starts an owned production preview on port 5188. Tests
exercise the shipped app without Vite source imports: practice → frame review →
save → synchronized comparison → reload, invalid replacements, filename/metadata
collisions, two-tab conflicts, JSON backups, and annotation lineage. A 320px
Chromium viewport and a WebKit phone viewport check narrow layouts.

Playwright clears only `test-results/production/`. Keep independent benchmark
reports and visual review evidence elsewhere, such as `test-results/reviews/`;
the browser suite must not delete those records when it starts.

The two bundled MP4s are original CC0 geometric animations with authored timing,
not real climbs or independent labels. `npm run fixtures:generate` regenerates
them with FFmpeg (`CLIMBIQ_FFMPEG` overrides its location). The manifest contains
their SHA-256 hashes and explicit synthetic provenance.

CI runs Chromium on Ubuntu and both WebKit projects on macOS. Windows Playwright
WebKit in this development environment returns media error 4 for both MP4 and
WebM. Its media scenarios are explicitly skipped locally; saved-JSON scenarios
still run in that engine. macOS WebKit has no such skip. A green local Windows
run therefore does not establish Safari video compatibility or native iPhone
readiness. CI preserves traces/screenshots when checks fail.

Production previews apply the security and asset-cache headers from
`vercel.json`, including the deployed Content Security Policy. The standalone
production worker smoke uses the same policy and checks it on the HTML, worker,
model, and WASM responses before executing the worker. It verifies bundled
execution under that policy, not pose accuracy or native readiness. Builds emit
`build-info.json` with the package version, full Git commit, and dirty/unknown
source state; this identifies the actual build without embedding private paths
or environment variables.

## Existing detector and browser harnesses

New browser runners should use `startTestBrowser` from `test-browser.mjs`:

```js
const browser = await startTestBrowser({
  label: "my-check",
  args: ["--disable-background-timer-throttling"],
});
let socket, send;
try {
  // Open a page through http://127.0.0.1:${browser.port}/json/new?...,
  // then create the CDP socket/client as needed by the test.
} finally {
  try { await browser.close(send); } finally { socket?.close(); }
}
```

Each invocation creates a fresh temporary directory and profile. Chrome chooses
an available debugger port by default; the helper reads `DevToolsActivePort` from
that profile and verifies the browser identity before returning. Startup failure
also closes the owned process and cleans up its directory.

`close` is idempotent. It first requests `Browser.close` when a CDP sender is
available, then falls back to terminating only the child it launched. It waits
for that child to exit before removing the checked temporary directory. If the
child cannot be stopped, the helper reports the retained profile instead of
deleting files that the browser might still be writing. It never searches for or
deletes historical profiles.

The upload, cancellation, finish-review, real-video timing, and coaching runners
use this helper. Existing test assertions and workflow modes are retained.

- `CLIMBIQ_CHROME` overrides the Chrome executable.
- `CLIMBIQ_E2E_URL` selects the app URL in each runner.
- `CLIMBIQ_E2E_PORT=0` uses an available port (the default). A fixed port from
  1024 through 65535 is supported, but its endpoint must match the unique browser
  identity announced by the launched child. An unrelated debugger on the same
  port is never accepted.
- Pass extra browser flags through `args`; the helper owns the debugger and
  profile flags. `profile`, `temporaryRoot`, and `child` are available for
  diagnostics.

Run the helper's process/HTTP fixture tests with:

```sh
npx vitest run e2e/test-browser.test.mjs
```

These tests cover concurrent isolation, launch errors, occupied override ports,
identity mismatches, timeout cleanup, and invalid configuration without running
video inference. For a short real-browser interruption smoke:

```sh
node e2e/analysis-cancellation.mjs --stage-only=start
```

`--stage-only` accepts `start`, `detail`, `motion`, `target`, `finish`, or `pose`.
It explicitly selects a single cancellation phase. Omit it to keep the full
cancellation, prior-evidence, and replacement suite; `--target-only` and
`--rerun-only` retain their existing behavior.
