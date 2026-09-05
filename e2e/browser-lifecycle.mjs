/** Close only the browser process this test spawned; never kill shared browsers. */
export async function closeTestBrowser(child, send, { graceMs = 1500, requestMs = 1500 } = {}) {
  if (hasExited(child)) return;
  if (send) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => send("Browser.close")).catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, requestMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  if (hasExited(child)) return;
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
    child.once("exit", done);
    timer = setTimeout(done, graceMs);
    if (hasExited(child)) done();
  });
  if (!hasExited(child)) child.kill();
}

function hasExited(child) { return child.exitCode !== null || child.signalCode !== null; }
