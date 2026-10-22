# Browser test ownership

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
