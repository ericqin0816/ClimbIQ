import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestBrowser } from "./test-browser.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root), relative = path.relative(path.resolve(tmpdir()), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("climbiq-browser-unit-")) throw new Error("Unsafe test fixture cleanup");
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});

// A small child-process HTTP fixture exercises ownership and exit ordering without
// launching Chrome, opening user state, or contending with video performance tests.
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "climbiq-browser-unit-"));
  roots.push(root);
  const script = path.join(root, "fake-browser.mjs");
  await writeFile(script, `
    import { createServer } from 'node:http';
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const arg = prefix => process.argv.find(value=>value.startsWith(prefix))?.slice(prefix.length);
    const requested = Number(arg('--remote-debugging-port='));
    const profile = arg('--user-data-dir=');
    const noIdentity = process.argv.includes('--fake-no-identity');
    const wrongIdentity = process.argv.includes('--fake-wrong-identity');
    const identity = '/devtools/browser/owned-' + process.pid;
    await mkdir(profile, {recursive:true});
    const server = createServer((request,response)=>{
      if(request.url === '/close') { response.end('closing',()=>{server.close();server.closeAllConnections();setTimeout(()=>process.exit(0),5);}); return; }
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+(wrongIdentity?'/devtools/browser/unrelated':identity)}));
    });
    server.on('error',error=>{console.error(error.message);process.exit(1);});
    server.listen(requested,'127.0.0.1',async()=>{
      const port=server.address().port;
      if(!noIdentity) {
        if(requested===0) await writeFile(path.join(profile,'DevToolsActivePort'),port+'\\n'+identity+'\\n');
        console.error('DevTools listening on ws://127.0.0.1:'+port+identity);
      }
    });
  `);
  return { root, options: { chromePath: process.execPath, args: [script], temporaryParent: root, port: 0 } };
}

describe("owned browser test lifecycle", () => {
  it("gives simultaneous tests different profiles/ports and removes each only after its child exits", async () => {
    const { root, options } = await fixture();
    const browsers = [];
    try {
      browsers.push(...await Promise.all([startTestBrowser({ ...options, label: "first" }), startTestBrowser({ ...options, label: "second" })]));
      expect(browsers[0].port).not.toBe(browsers[1].port);
      expect(browsers[0].temporaryRoot).not.toBe(browsers[1].temporaryRoot);
      for (const browser of browsers) {
        expect(await readFile(path.join(browser.profile, "DevToolsActivePort"), "utf8")).toContain(String(browser.port));
        await browser.close(() => fetch(`http://127.0.0.1:${browser.port}/close`));
        expect(browser.child.exitCode).toBe(0);
        await expect(access(browser.temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await browser.close();
      }
      expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
    } finally { await Promise.all(browsers.map(browser => browser.close())); }
  });

  it("cleans its temporary root when the executable cannot spawn", async () => {
    const { root, options } = await fixture();
    await expect(startTestBrowser({ ...options, chromePath: path.join(root, "missing-browser") })).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
  });

  it("supports a fixed-port override only after the child announces the matching debugger identity", async () => {
    const { root, options } = await fixture();
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const browser = await startTestBrowser({ ...options, port });
    try { expect(browser.port).toBe(port); }
    finally { await browser.close(() => fetch(`http://127.0.0.1:${port}/close`)); }
    expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
  });

  it("never attaches to or closes an unrelated debugger on an occupied override port", async () => {
    const { root, options } = await fixture();
    let requests = 0;
    const unrelated = createServer((_request, response) => { requests++; response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${unrelated.address().port}/devtools/browser/unrelated` })); });
    await new Promise(resolve => unrelated.listen(0, "127.0.0.1", resolve));
    try {
      await expect(startTestBrowser({ ...options, port: unrelated.address().port })).rejects.toThrow("exited before");
      expect(requests).toBe(0);
      expect(unrelated.listening).toBe(true);
      expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
    } finally { await new Promise(resolve => unrelated.close(resolve)); }
  });

  it("rejects a mismatched debugger identity and cleans up the owned child/profile", async () => {
    const { root, options } = await fixture();
    await expect(startTestBrowser({ ...options, args: [...options.args, "--fake-wrong-identity"], startupMs: 300 })).rejects.toThrow("did not become ready");
    expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
  });

  it("times out a child that never publishes an endpoint and cleans its owned directory", async () => {
    const { root, options } = await fixture();
    await expect(startTestBrowser({ ...options, args: [...options.args, "--fake-no-identity"], startupMs: 300 })).rejects.toThrow("did not become ready");
    expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
  });

  it("rejects invalid port and caller profile overrides before spawning", async () => {
    const { root, options } = await fixture();
    await expect(startTestBrowser({ ...options, port: -1 })).rejects.toThrow("CLIMBIQ_E2E_PORT");
    await expect(startTestBrowser({ ...options, args: [...options.args, "--user-data-dir=unowned"] })).rejects.toThrow("owns the debugger port and profile");
    expect(await readdir(root)).toEqual(["fake-browser.mjs"]);
  });
});
