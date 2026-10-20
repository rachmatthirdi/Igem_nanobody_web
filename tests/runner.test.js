// Tests for the queue, the per-user quota and session expiry
// (server/runner.js, server/sessions.js). The engine call is replaced by a
// fake, so no Docker or GPU is needed.
// Run:  node --test tests/runner.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Sessions, dirSize } = require("../server/sessions.js");
const { Runner, HttpError } = require("../server/runner.js");

function setup(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbr-"));
  const config = {
    dataDir,
    backboneBudget: 10,
    maxQueue: 2,
    sessionTtlMs: 1000,
    sessionDiskBytes: 1_000_000,
    newSessionsPerIpPerHour: 3,
    requestsPerSecond: 4,
    ...over,
  };
  const sessions = new Sessions(config);
  const runner = new Runner(config, sessions);
  runner.ready = true;
  return { config, sessions, runner };
}

// A fake engine call that finishes when the test says so.
function controllable(runner) {
  const pending = [];
  runner.call = (session, channel, args) =>
    new Promise((resolve, reject) => pending.push({ session, resolve, reject }));
  return pending;
}
const tick = () => new Promise((r) => setImmediate(r));
const params = (n) => ({ numDesigns: n });

test("a user cannot exceed the backbone budget, across runs", () => {
  const { runner, sessions } = setup();
  controllable(runner);
  const s = sessions.create();
  runner.submit(s, params(6));
  s.job = null; // pretend the first run ended without being refunded
  assert.throws(() => runner.submit(s, params(5)), (e) => e instanceof HttpError && e.status === 403);
  assert.equal(s.meta.backbonesUsed, 6);
  assert.doesNotThrow(() => runner.submit(s, params(4)));
});

test("a second job from the same session is refused while one is active", () => {
  const { runner, sessions } = setup();
  controllable(runner);
  const s = sessions.create();
  runner.submit(s, params(1));
  assert.throws(() => runner.submit(s, params(1)), (e) => e.status === 409);
});

test("jobs run one at a time, in order, and the queue length is capped", async () => {
  const { runner, sessions } = setup({ maxQueue: 1 });
  const pending = controllable(runner);
  const [a, b, c] = [sessions.create(), sessions.create(), sessions.create()];
  const ja = runner.submit(a, params(1));
  const jb = runner.submit(b, params(1));
  await tick();
  assert.equal(pending.length, 1, "only one engine call at a time");
  assert.equal(ja.status, "running");
  assert.equal(runner.position(jb), 1);
  assert.throws(() => runner.submit(c, params(1)), (e) => e.status === 503, "queue full");
  pending[0].resolve({ candidates: [] });
  await tick(); await tick();
  assert.equal(ja.status, "done");
  assert.equal(jb.status, "running");
  assert.equal(pending.length, 2);
});

test("a failure before any backbone exists refunds the quota; after one, it does not", async () => {
  const { runner, sessions } = setup();
  const pending = controllable(runner);
  const early = sessions.create();
  runner.submit(early, params(5));
  await tick();
  pending[0].reject(new Error("boom"));
  await tick(); await tick();
  assert.equal(early.meta.backbonesUsed, 0, "nothing was produced, nothing is charged");
  assert.equal(early.job, null);

  const late = sessions.create();
  const job = runner.submit(late, params(5));
  await tick();
  job.observe({ stage: "rfdiffusion", status: "done" });
  pending[1].reject(new Error("rf2 died"));
  await tick(); await tick();
  assert.equal(late.meta.backbonesUsed, 5, "GPU time was spent, so it stays charged");
});

test("cancelling a queued job removes it and refunds it", async () => {
  const { runner, sessions } = setup();
  controllable(runner);
  const [a, b] = [sessions.create(), sessions.create()];
  runner.submit(a, params(1));
  const jb = runner.submit(b, params(4));
  await tick();
  assert.equal(b.meta.backbonesUsed, 4);
  const wasRunning = runner.cancel(b);
  assert.equal(wasRunning, false, "it had not started");
  assert.equal(jb.status, "cancelled");
  assert.equal(b.meta.backbonesUsed, 0);
  assert.equal(b.job, null);
  assert.equal(runner.queue.length, 0);
});

test("the quota survives a server restart", () => {
  const { runner, sessions, config } = setup();
  controllable(runner);
  const s = sessions.create();
  runner.submit(s, params(7));
  const reopened = new Sessions(config).find(s.id);
  assert.equal(reopened.meta.backbonesUsed, 7);
});

test("jobs are refused until start-up has finished, or when set-up failed", () => {
  const { runner, sessions } = setup();
  controllable(runner);
  runner.ready = false;
  assert.throws(() => runner.submit(sessions.create(), params(1)), (e) => e.status === 503);
  runner.ready = true;
  runner.bootError = "image missing";
  assert.throws(() => runner.submit(sessions.create(), params(1)), (e) => e.status === 503);
});

test("a full workspace blocks a new design", () => {
  const { runner, sessions } = setup({ sessionDiskBytes: 100 });
  controllable(runner);
  const s = sessions.create();
  fs.writeFileSync(path.join(s.dir, "big.bin"), Buffer.alloc(500));
  assert.throws(() => runner.submit(s, params(1)), (e) => e.status === 413);
  assert.equal(s.meta.backbonesUsed, 0, "a refused job is not charged");
});

test("new sessions per address are rate limited", () => {
  const { sessions } = setup();
  assert.ok(sessions.allowNewSession("1.1.1.1"));
  assert.ok(sessions.allowNewSession("1.1.1.1"));
  assert.ok(sessions.allowNewSession("1.1.1.1"));
  assert.equal(sessions.allowNewSession("1.1.1.1"), false);
  assert.ok(sessions.allowNewSession("2.2.2.2"), "other addresses are unaffected");
});

test("request bucket slows a flood but lets normal use through", () => {
  const { sessions } = setup();
  const s = sessions.create();
  let ok = 0;
  for (let i = 0; i < 100; i++) if (sessions.take(s)) ok++;
  assert.ok(ok >= 20 && ok <= 25, `burst of ~20 allowed, got ${ok}`);
});

test("sweep removes idle workspaces but never one with a job in flight", () => {
  const { sessions } = setup();
  const idle = sessions.create();
  const busy = sessions.create();
  const fresh = sessions.create();
  idle.meta.lastSeen = Date.now() - 5000;
  busy.meta.lastSeen = Date.now() - 5000;
  busy.job = { id: "x" };
  const removed = sessions.sweep();
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(idle.dir), false);
  assert.equal(fs.existsSync(busy.dir), true);
  assert.equal(fs.existsSync(fresh.dir), true);
});

test("session ids from cookies are strictly validated", () => {
  const { sessions } = setup();
  const s = sessions.create();
  assert.equal(sessions.find(s.id).id, s.id);
  for (const bad of ["../x", "", "g".repeat(32), s.id + "0", s.id.toUpperCase(), undefined, null, 5])
    assert.equal(sessions.find(bad), null, String(bad));
});

test("dirSize stops counting once past the cap", () => {
  const { sessions } = setup();
  const s = sessions.create();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(s.dir, `f${i}`), Buffer.alloc(100));
  assert.ok(dirSize(s.dir) >= 500);
  assert.ok(dirSize(s.dir, 150) <= 300, "returns soon after passing the cap");
});
