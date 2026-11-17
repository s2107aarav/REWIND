import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const execute = promisify(execFile),
  home = await mkdtemp(path.join(await realpath(os.tmpdir()), "rewind-ui-")),
  session = "rewind-smoke-" + process.pid,
  port = 9334;
await mkdir("results", { recursive: true });
const env = { ...process.env, REWIND_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(
  "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${port}`],
  {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let log = "";
app.stderr.on("data", (b) => (log += b));
const start = Date.now();
const checks = [];
async function browser(...args) {
  return (
    await execute("agent-browser", ["--session", session, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    })
  ).stdout;
}
async function evaluate(js) {
  const body =
    js.includes(";") || js.startsWith("try")
      ? js.replace(/; true$/, "; return true")
      : "return (" + js + ")";
  const s = (await browser("eval", "(async()=>{" + body + "})()")).trim();
  return s ? JSON.parse(s) : undefined;
}
async function until(fn) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("UI condition timed out");
}
try {
  await until(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      return r.ok;
    } catch {
      return false;
    }
  });
  await browser("connect", String(port));
  await until(
    async () =>
      await evaluate(
        'Boolean(window.rewind && document.querySelector("button"))',
      ),
  );
  assert.equal(await evaluate("typeof window.require"), "undefined");
  checks.push("Renderer has no Node require");
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Create demo workspace')).click(); true",
  );
  await until(
    async () =>
      await evaluate("document.body.textContent.includes('Made recoverable.')"),
  );
  const state = await evaluate("await window.rewind.request({action:'state'})");
  assert.equal(state.snapshots.length, 3);
  assert.ok(state.snapshots.every((s) => s.state === "VERIFIED_RECOVERABLE"));
  checks.push("UI creates three real snapshots and scans their bytes");
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Disaster laboratory')).click(); true",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Create lab copy')).click(); true",
  );
  await until(
    async () =>
      await evaluate("document.body.textContent.includes('ACTIVE LAB')"),
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Inject fault')).click(); true",
  );
  await until(
    async () =>
      await evaluate("Boolean(document.querySelector('.action-log pre'))"),
  );
  const lab = await evaluate(
    "await window.rewind.request({action:'state',scope:'lab'})",
  );
  assert.equal(lab.lab.actions.length, 1);
  assert.ok(lab.scan.counts.CORRUPT > 0);
  assert.ok(lab.snapshots.every((s) => s.state === "VERIFIED_RECOVERABLE"));
  checks.push(
    "Lab corruption is detected and healthy alternate copy preserves recovery",
  );
  const original = await evaluate(
    "await window.rewind.request({action:'state',scope:'original'})",
  );
  assert.equal(original.scan.counts.CORRUPT || 0, 0);
  checks.push("Original data stays healthy");
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Recovery frontier')).click(); true",
  );
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('.matrix-cell')) || document.body.innerText.includes('snapshot states') || document.body.innerText.includes('six newest')",
      ),
  );
  checks.push("Recovery frontier renders historical file-version evidence");
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Analyze recovery options')).click(); true",
  );
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('.recovery-suggestion')?.textContent.includes('Latest complete verified snapshot:'))",
      ),
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.recovery-suggestion').textContent.includes('not a historical snapshot')",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.recovery-suggestion').textContent.includes('Restore rechecks bytes')",
    ),
    true,
  );
  assert.ok(
    await evaluate(
      "document.querySelectorAll('.recovery-suggestion tbody tr').length <= 25",
    ),
  );
  await evaluate(
    "Array.from(document.querySelectorAll('.recovery-suggestion button')).find(b=>b.textContent.includes('Inspect snapshot')).click(); true",
  );
  checks.push(
    "Recovery suggestion shows a verified complete snapshot, bounded salvage rows, warning and snapshot selection",
  );
  await browser("set", "viewport", "1440", "900");
  await browser("screenshot", "results/ui-frontier.png");
  await browser("set", "viewport", "800", "900");
  assert.equal(
    await evaluate(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
    true,
  );
  await browser("screenshot", "results/compact.png");
  checks.push("Recovery suggestion fits desktop and 800px layouts");
  await evaluate(
    "Array.from(document.querySelectorAll('.scope-switch button')).find(b=>b.textContent.includes('Original')).click(); true",
  );
  await until(
    async () =>
      await evaluate(
        "document.querySelector('.recovery-suggestion')?.textContent.includes('Run a new deep scan')",
      ),
  );
  checks.push("Scope switch clears recovery suggestion");
  const rejected = await evaluate(
    "try{await window.rewind.request({action:'setup',source:'/ungranted',roots:['/ungranted-a','/ungranted-b']});return false}catch{return true}",
  );
  assert.equal(rejected, true);
  checks.push("Main denies filesystem paths without native picker grants");
  await writeFile(
    "results/ui-smoke.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        command: "npm run test:ui",
        success: true,
        durationMs: Date.now() - start,
        checks,
        limitations: [
          "Native file picker restore is tested separately through macOS computer-use; not mocked by this script.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(checks.join("\n"));
} catch (e) {
  try {
    log += "\nDOM: " + (await browser("get", "text", "body"));
    await browser("screenshot", "results/ui-failure.png");
  } catch {
    /* preserve the original smoke failure */
  }
  await writeFile(
    "results/ui-smoke.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        success: false,
        checks,
        error: String(e),
        log,
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  const exited =
    app.exitCode !== null || app.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => app.once("exit", resolve));
  app.kill("SIGTERM");
  try {
    await browser("close");
  } catch {
    /* app already closed */
  }
  await exited;
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
}
