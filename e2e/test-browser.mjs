import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => child.exitCode !== null || child.signalCode !== null;

/** One test owns one Chrome process, debugger identity, and disposable profile. */
export async function startTestBrowser({
  label = "browser",
  chromePath = process.env.CLIMBIQ_CHROME ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome"),
  args = [],
  port = process.env.CLIMBIQ_E2E_PORT === undefined ? 0 : Number(process.env.CLIMBIQ_E2E_PORT),
  startupMs = 10_000,
  temporaryParent = tmpdir(),
} = {}) {
  if (!Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new Error("CLIMBIQ_E2E_PORT must be 0 or an integer from 1024 to 65535.");
  if (!Number.isFinite(startupMs) || startupMs <= 0) throw new Error("Browser startup timeout must be positive.");
  if (args.some(arg => /^--(?:remote-debugging-port|user-data-dir)(?:=|$)/.test(arg))) throw new Error("The test browser helper owns the debugger port and profile arguments.");
  const parent = path.resolve(temporaryParent);
  const prefix = `climbiq-${label.replace(/[^a-z0-9-]/gi, "-").slice(0, 40) || "browser"}-`;
  const temporaryRoot = await mkdtemp(path.join(parent, prefix));
  const profile = path.join(temporaryRoot, "profile");
  let child, spawnError, stderr = "", announcedDebugger;
  let closing;
  const close = send => closing ??= (async () => {
    if (child?.pid && !exited(child)) {
      await closeTestBrowser(child, send);
      const deadline = Date.now() + 3000;
      while (!exited(child) && Date.now() < deadline) await delay(25);
      // Never remove a profile that its browser may still be writing.
      if (!exited(child)) throw new Error(`Test Chrome did not exit; its owned profile was retained at ${profile}`);
    }
    const resolved = path.resolve(temporaryRoot);
    const relative = path.relative(parent, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) {
      throw new Error("Refusing to remove a directory outside this test's temporary browser root.");
    }
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  })();
  try {
    child = spawn(chromePath, [...args, "--headless=new", "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    child.once("error", error => { spawnError = error; });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-8000);
      announcedDebugger = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1] ?? announcedDebugger;
    });
    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited(child)) throw new Error(`Test Chrome exited before its debugger was ready. ${stderr.slice(-600)}`);
      let endpoint;
      if (port === 0) {
        try {
          const [portLine, browserPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
          const assignedPort = Number(portLine);
          if (Number.isInteger(assignedPort) && assignedPort > 0 && assignedPort <= 65535 && browserPath?.startsWith("/devtools/browser/")) endpoint = `ws://127.0.0.1:${assignedPort}${browserPath}`;
        } catch { /* This fresh profile has not published its debugger yet. */ }
      } else {
        // Fixed-port overrides cannot trust an unrelated browser already listening.
        // Chrome's own stderr supplies the unique browser identity we must match.
        endpoint = announcedDebugger;
      }
      if (endpoint) {
        const expected = new URL(endpoint);
        const assignedPort = Number(expected.port);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname) || port !== 0 && assignedPort !== port) throw new Error("Test Chrome announced an unexpected debugger address.");
        try {
          const response = await fetch(`http://127.0.0.1:${assignedPort}/json/version`, { signal: AbortSignal.timeout(800) });
          const version = response.ok ? await response.json() : null;
          const actual = version?.webSocketDebuggerUrl ? new URL(version.webSocketDebuggerUrl) : null;
          if (actual?.pathname === expected.pathname && Number(actual.port) === assignedPort) return { child, port: assignedPort, profile, temporaryRoot, close };
        } catch { /* The owned endpoint may still be starting. */ }
      }
      await delay(50);
    }
    throw new Error(`Test Chrome debugger did not become ready within ${startupMs}ms. ${stderr.slice(-600)}`);
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Test browser startup and cleanup failed."); }
    throw error;
  }
}
