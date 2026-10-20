// Tests for the shared-results store and the publishers
// (server/store.js, server/publish.js). Run:  node --test tests/store.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../server/store.js");
const { publishTarget, publishDesign, publishConstruct } = require("../server/publish.js");

const DAY = 86_400_000;
function setup(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbs-"));
  const config = { dataDir, sharedRetentionDays: 7, sharedMaxEntries: 100, sharedMaxEntryBytes: 1_000_000, ...over };
  return { dataDir, config, store: new Store(config) };
}
const entry = (over = {}) => ({ kind: "design", title: "t", pdbId: "1ZVH", summary: {}, data: { a: 1 }, files: {}, ...over });

test("each result expires seven days after it was written, on its own clock", () => {
  const { store } = setup();
  const t0 = 1_000_000_000_000;
  store.put("design-a", entry(), t0);
  store.put("design-b", entry(), t0 + 3 * DAY);
  assert.equal(store.getMeta("design-a", t0 + 6.9 * DAY)?.id, "design-a");
  assert.equal(store.getMeta("design-a", t0 + 7.1 * DAY), null, "a is gone after 7 days");
  assert.equal(store.getMeta("design-b", t0 + 7.1 * DAY)?.id, "design-b", "b, written later, is still there");
  assert.equal(store.getMeta("design-b", t0 + 10.1 * DAY), null);
});

test("sweep deletes expired entries from disk and keeps the rest", () => {
  const { store, dataDir } = setup();
  const t0 = Date.now() - 8 * DAY;
  store.put("design-old", entry({ files: { "x.pdb": "ATOM" } }), t0);
  store.put("design-new", entry());
  assert.equal(store.sweep(), 1);
  assert.equal(fs.existsSync(path.join(dataDir, "shared", "results", "design-old")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "shared", "results", "design-new")), true);
});

test("expired entries are expired even before a sweep, and survive a restart until then", () => {
  const { store, config } = setup();
  store.put("design-a", entry());
  const reopened = new Store(config);
  assert.equal(reopened.getMeta("design-a")?.id, "design-a");
  assert.equal(reopened.list({}, Date.now() + 8 * DAY).length, 0);
});

test("writing the same id again replaces it and restarts its clock", () => {
  const { store } = setup();
  const t0 = Date.now();
  store.put("design-a", entry({ data: { v: 1 } }), t0);
  store.put("design-a", entry({ data: { v: 2 } }), t0 + 5 * DAY);
  assert.equal(store.getData("design-a", t0 + 8 * DAY).data.v, 2);
});

test("ids and file names cannot reach outside the store", () => {
  const { store } = setup();
  for (const id of ["../x", "design-../x", "design-a/b", "x-1", "design-", "design-" + "a".repeat(41)])
    assert.throws(() => store.put(id, entry()), /Bad shared result id/, id);
  for (const name of ["../a.pdb", "a.exe", "a/b.pdb", ".pdb", "a.pdb\0.txt"])
    assert.throws(() => store.put("design-a", entry({ files: { [name]: "x" } })), /Bad shared file name/, name);
  store.put("design-a", entry({ files: { "ok.pdb": "ATOM" } }));
  assert.ok(store.filePath("design-a", "ok.pdb"));
  assert.equal(store.filePath("design-a", "meta.json"), null);
  assert.equal(store.filePath("design-a", "other.pdb"), null, "only files recorded in meta are served");
  assert.equal(store.filePath("../design-a", "ok.pdb"), null);
});

test("an oversized entry is refused, and the entry cap drops the oldest first", () => {
  const { store } = setup({ sharedMaxEntryBytes: 10, sharedMaxEntries: 2 });
  assert.throws(() => store.put("design-a", entry({ files: { "a.pdb": "x".repeat(11) } })), /too large/);
  store.put("design-1", entry(), 1000);
  store.put("design-2", entry(), 2000);
  store.put("design-3", entry(), 3000);
  assert.equal(store.index.has("design-1"), false);
  assert.ok(store.index.has("design-2") && store.index.has("design-3"));
});

test("list filters by kind and PDB id, hides unfinished targets, newest first", () => {
  const { store } = setup();
  const n = Date.now();
  store.put("design-a", entry({ pdbId: "1ZVH" }), n - 4000);
  store.put("design-b", entry({ pdbId: "2Z1P" }), n - 3000);
  store.put("target-1ZVH", entry({ kind: "target", summary: { ready: false } }), n - 2000);
  store.put("target-2Z1P", entry({ kind: "target", pdbId: "2Z1P", summary: { ready: true } }), n - 1000);
  assert.deepEqual(store.list({}).map((m) => m.id), ["target-2Z1P", "design-b", "design-a"]);
  assert.deepEqual(store.list({ kind: "design" }).map((m) => m.id), ["design-b", "design-a"]);
  assert.deepEqual(store.list({ pdbId: "1ZVH" }).map((m) => m.id), ["design-a"]);
});

test("target results from FreeSASA, DiscoTope and InterPro merge into one entry", () => {
  const { store } = setup();
  publishTarget(store, "1ZVH", { title: "A VHH" });
  assert.equal(store.list({}).length, 0, "a title alone is not a result");
  publishTarget(store, "1ZVH", { sasa: [{ resNum: 1, residue: "GLN", sasa: 10.5, rsa: 0.3 }] });
  publishTarget(store, "1ZVH", { discotope: [{ resNum: 1, residue: "GLN", discotopeScore: 0.4, predictedEpitope: true }] });
  publishTarget(store, "1ZVH", { domains: [{ accession: "IPR1", name: "Ig", type: "domain", locations: [{ start: 1 }] }] });
  const { meta, data } = store.getData("target-1ZVH");
  assert.equal(store.list({}).length, 1);
  assert.equal(meta.summary.epitopeResidues, 1);
  assert.equal(data.title, "A VHH");
  assert.equal(data.sasa.length, 1);
  assert.equal(data.domains[0].locations, undefined, "unknown fields are dropped");
});

test("publishers keep only known fields, with numbers as numbers", () => {
  const { store } = setup();
  publishTarget(store, "1ZVH", { sasa: [{ resNum: "1", residue: "<img src=x onerror=1>", sasa: "high", rsa: NaN, evil: 1 }] });
  const r = store.getData("target-1ZVH").data.sasa[0];
  assert.deepEqual(r, { resNum: null, residue: "<img", sasa: null, rsa: null });
});

test("a design is published with its structures, and only from inside the session", () => {
  const { store } = setup();
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), "nbsess-"));
  const outside = path.join(os.tmpdir(), `nb-secret-${process.pid}.pdb`);
  fs.writeFileSync(outside, "SECRET");
  fs.mkdirSync(path.join(sess, "work"));
  fs.writeFileSync(path.join(sess, "work", "d1.pdb"), "ATOM  1");
  fs.symlinkSync(outside, path.join(sess, "work", "link.pdb"));
  const job = {
    id: "abc123",
    params: { pdbId: "1ZVH", designLoops: "H1:7,H2:6,H3:9", hotspotResidues: [50], numDesigns: 1, designsPerBackbone: 1, temperature: 0.2, cdr: { H1: {} } },
    result: {
      candidates: [
        { id: "d1", pdbPath: path.join(sess, "work", "d1.pdb"), plddt: 90.5, pae: 7, dg: -10, junk: "x" },
        { id: "evil", pdbPath: outside, plddt: 1 },
        { id: "link", pdbPath: path.join(sess, "work", "link.pdb"), plddt: 2 },
        { id: "../bad", pdbPath: path.join(sess, "work", "d1.pdb") },
      ],
    },
  };
  publishDesign(store, sess, job);
  const { data, meta } = store.getData("design-abc123");
  assert.deepEqual(data.candidates.map((c) => [c.id, c.file]), [["d1", "d1.pdb"], ["evil", null], ["link", null]]);
  assert.equal(data.candidates[0].junk, undefined);
  assert.equal(data.params.cdr, undefined);
  assert.equal(fs.readFileSync(store.filePath("design-abc123", "d1.pdb"), "utf8"), "ATOM  1");
  assert.deepEqual(meta.files, ["d1.pdb"]);
  assert.ok(!JSON.stringify(data).includes(sess), "no server path leaks into shared data");
});

test("a construct is published with its FASTA, read only from the session", () => {
  const { store } = setup();
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), "nbsess-"));
  fs.mkdirSync(path.join(sess, "output"));
  fs.writeFileSync(path.join(sess, "output", "c.fasta"), ">c\nATG\n");
  const params = { candidateId: "d1", vector: "pET-28a(+)", includePelb: true };
  publishConstruct(store, sess, params, { fastaPath: path.join(sess, "output", "c.fasta"), lengthBp: 3, gcContent: 33.3, cai: 0.9, restrictionFixes: [1] }, "n1");
  const { data } = store.getData("construct-n1");
  assert.equal(data.lengthBp, 3);
  assert.equal(data.restrictionFixes, 1);
  assert.equal(fs.readFileSync(store.filePath("construct-n1", "construct.fasta"), "utf8"), ">c\nATG\n");
  assert.throws(() => publishConstruct(store, sess, params, { fastaPath: "/etc/passwd" }, "n2"));
});

test("search matches every word across title, ids, kind and extra words; ids narrows to a list", () => {
  const { store } = setup();
  const n = Date.now();
  store.put("design-a1", entry({ title: "1ZVH nanobody design", search: "design_0_best design_1_best hotspot 50" }), n - 3000);
  store.put("design-b2", entry({ title: "2Z1P nanobody design", pdbId: "2Z1P", search: "other_0" }), n - 2000);
  store.put("construct-c3", entry({ kind: "construct", title: "design_1 in pET-28a(+)", pdbId: null, search: "design_1 pet-28a(+) pelb" }), n - 1000);
  const ids = (q) => store.list({ q }).map((m) => m.id);
  assert.deepEqual(ids("design_1_best"), ["design-a1"]);
  assert.deepEqual(ids("pet-28a pelb"), ["construct-c3"]);
  assert.deepEqual(ids("DESIGN-B2"), ["design-b2"], "case-insensitive, matches the result id");
  assert.deepEqual(ids("nanobody 2z1p"), ["design-b2"], "all words must match");
  assert.deepEqual(ids("nothing-like-this"), []);
  assert.deepEqual(store.list({ ids: ["design-a1", "construct-c3", "design-zzz"] }).map((m) => m.id), ["construct-c3", "design-a1"]);
  assert.deepEqual(store.list({ ids: [] }), [], "an empty personal list shows nothing, not everything");
});
