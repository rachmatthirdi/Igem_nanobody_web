// Tests for job persistence, restart recovery and the auto-saved project
// (server/runner.js, server/projects.js). Run:  node --test tests/jobs.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Sessions } = require("../server/sessions.js");
const { Runner } = require("../server/runner.js");
const { defaultState, buildProject, saveProject } = require("../server/projects.js");

const appDir = path.resolve(__dirname, "..");
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbj-"));
  const config = { dataDir, appDir, backboneBudget: 10, maxQueue: 3, sessionTtlMs: 1e9, sessionDiskBytes: 1e9, newSessionsPerIpPerHour: 99, requestsPerSecond: 4 };
  const sessions = new Sessions(config);
  const runner = new Runner(config, sessions);
  runner.ready = true;
  return { config, sessions, runner };
}
const tick = () => new Promise((r) => setImmediate(r));
const params = (s, n = 2) => ({ targetPdbPath: path.join(s.dir, "cache", "pdb", "1ZVH_chainA.pdb"), pdbId: "1ZVH", designLoops: "H1:7,H2:6,H3:9", hotspotResidues: [50], numDesigns: n, designsPerBackbone: 1, temperature: 0.2, numRecycles: 10, cdr: {} });

test("a job can be looked up from its file after memory forgets it, and only by its owner", async () => {
  const { runner, sessions } = setup();
  runner.call = async () => ({ backbones: ["b"], candidates: [{ id: "d_0" }] });
  const a = sessions.create(), b = sessions.create();
  const job = runner.submit(a, params(a));
  await tick(); await tick(); await tick();
  assert.equal(job.status, "done");
  assert.equal(runner.getJob(b, job.id), null, "another session cannot read it while it is in memory either");
  runner.jobs.clear(); // as after the hour in memory, or a restart
  const view = runner.getJob(a, job.id);
  assert.equal(view.status, "done");
  assert.deepEqual(view.result.candidates, [{ id: "d_0" }]);
  assert.equal(view.params.pdbId, "1ZVH");
  assert.equal(runner.getJob(b, job.id), null, "another session cannot read it");
  assert.equal(runner.getJob(a, "../../session"), null);
  assert.equal(runner.getJob(a, "0123456789abcdef"), null);
});

test("a fresh page is told about the running job and the last finished one", async () => {
  const { runner, sessions } = setup();
  const pending = [];
  runner.call = () => new Promise((res, rej) => pending.push({ res, rej }));
  const s = sessions.create();
  const first = runner.submit(s, params(s, 1));
  await tick();
  assert.equal(runner.jobsFor(s).activeJob.status, "running");
  assert.equal(runner.jobsFor(s).lastJob, null, "the running job is not also 'last'");
  pending[0].res({ backbones: [], candidates: [] });
  await tick(); await tick(); await tick();
  const j = runner.jobsFor(s);
  assert.equal(j.activeJob, null);
  assert.equal(j.lastJob.id, first.id);
  assert.equal(j.lastJob.status, "done");
});

test("after a restart, interrupted jobs are marked failed and refunded", () => {
  const { runner, sessions, config } = setup();
  runner.call = () => new Promise(() => {});
  const s = sessions.create();
  const job = runner.submit(s, params(s, 4)); // charged 4, persisted as queued/running
  assert.equal(s.meta.backbonesUsed, 4);
  const restarted = new Runner(config, new Sessions(config));
  restarted.recoverJobs(() => {});
  const s2 = restarted.sessions.find(s.id);
  assert.equal(s2.meta.backbonesUsed, 0, "nothing was produced, so nothing is charged");
  const v = restarted.getJob(s2, job.id);
  assert.equal(v.status, "error");
  assert.match(v.error, /restarted/);
});

test("an interrupted job that had produced backbones stays charged", async () => {
  const { runner, sessions, config } = setup();
  runner.call = () => new Promise(() => {});
  const s = sessions.create();
  const job = runner.submit(s, params(s, 3));
  await tick();
  job.observe({ stage: "rfdiffusion", status: "done" });
  runner.announce(job); // persist the new fact, as a real stage event does on the next status change
  const restarted = new Runner(config, new Sessions(config));
  restarted.recoverJobs(() => {});
  assert.equal(restarted.sessions.find(s.id).meta.backbonesUsed, 3);
});

test("recovery leaves finished jobs alone", async () => {
  const { runner, sessions, config } = setup();
  runner.call = async () => ({ backbones: [], candidates: [] });
  const s = sessions.create();
  const job = runner.submit(s, params(s, 1));
  await tick(); await tick(); await tick();
  const restarted = new Runner(config, new Sessions(config));
  restarted.recoverJobs(() => {});
  assert.equal(restarted.getJob(restarted.sessions.find(s.id), job.id).status, "done");
});

test("the saved project has exactly the fields the renderer's state has", () => {
  const { sessions } = setup();
  const s = sessions.create();
  const job = { id: "abc", params: params(s), result: { backbones: [path.join(s.dir, "work", "x", "design_0.pdb")], backboneDir: path.join(s.dir, "work", "x"), targetTPath: path.join(s.dir, "work", "t.pdb"), seqDir: path.join(s.dir, "work", "m"), rf2OutDir: path.join(s.dir, "work", "r"), candidates: [{ id: "d_0", pdbPath: path.join(s.dir, "work", "r", "d_0.pdb"), plddt: 90 }] } };
  const project = buildProject(appDir, s, job);
  const keys = Object.keys(defaultState(appDir));
  for (const k of keys) assert.ok(k in project, `missing ${k}`);
  for (const k of Object.keys(project)) assert.ok(k === "savedAt" || keys.includes(k), `unexpected ${k}`);
  assert.equal(project.pdbId, "1ZVH");
  assert.deepEqual(project.hotspotResidues, [50]);
  assert.equal(project.scaffoldConfig.cdr_config, "H1:7,H2:6,H3:9");
  assert.equal(project.sasaResidues.length, 0, "unknown parts stay at their default");
});

test("saveProject writes it where the Open project list looks, with portable paths", () => {
  const { sessions } = setup();
  const s = sessions.create();
  const job = { id: "abc", params: params(s), result: { backbones: [], backboneDir: path.join(s.dir, "work", "x"), candidates: [{ id: "d_0", pdbPath: path.join(s.dir, "work", "r", "d_0.pdb") }] } };
  const id = saveProject(appDir, s, job);
  const file = path.join(s.dir, "projects", `${id}.json`);
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(s.dir), "no server path in the file");
  const data = JSON.parse(text);
  assert.equal(data.candidates[0].pdbPath, "/nbroot/work/r/d_0.pdb");
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "a valid project id for load-project");
});

test("a job's view reports which stages have started, for pages opened mid-run", async () => {
  const { runner, sessions } = setup();
  runner.call = () => new Promise(() => {});
  const s = sessions.create();
  const job = runner.submit(s, params(s, 1));
  await tick();
  job.observe({ stage: "rfdiffusion", status: "done" });
  job.observe({ stage: "proteinmpnn", status: "running" });
  assert.deepEqual(runner.view(job).stages, { rfdiffusion: "done", proteinmpnn: "running" });
});
