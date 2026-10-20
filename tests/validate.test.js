// Tests for server/validate.js: what the API accepts from the browser.
// Run:  node --test tests/validate.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validate, ValidationError } = require("../server/validate.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nbv-"));
fs.mkdirSync(path.join(root, "cache", "pdb"), { recursive: true });
const limits = { maxBackbones: 10, maxSeqs: 1, minLoop: 5, maxLoop: 30 };
const ctx = { root, limits };
const target = path.join(root, "cache", "pdb", "2Z1P_chainA.pdb");

const design = (over = {}) => ({
  targetPdbPath: target,
  pdbId: "2Z1P",
  designLoops: "H1:7,H2:6,H3:9",
  hotspotResidues: [139],
  numDesigns: 10,
  designsPerBackbone: 1,
  temperature: 0.2,
  numRecycles: 10,
  cdr: {},
  ...over,
});
const rejects = (channel, args) =>
  assert.throws(() => validate(channel, args, ctx), ValidationError);

test("a normal design request is accepted and rebuilt from known fields only", () => {
  const [p] = validate("run-design", [{ ...design(), extra: "ignored", outputName: "../x" }], ctx);
  assert.equal(p.numDesigns, 10);
  assert.equal(p.extra, undefined);
  assert.equal(p.outputName, undefined);
});

test("the 10-backbone x 1-sequence limit is enforced", () => {
  rejects("run-design", [design({ numDesigns: 11 })]);
  rejects("run-design", [design({ numDesigns: 0 })]);
  rejects("run-design", [design({ designsPerBackbone: 2 })]);
  rejects("run-design", [design({ numDesigns: "10" })]);
  rejects("run-design", [design({ numDesigns: 1.5 })]);
});

test("values that reach the bash command line cannot carry shell syntax", () => {
  rejects("run-design", [design({ pdbId: "2Z1P;id" })]);
  rejects("run-design", [design({ designLoops: "H1:7,H2:6,H3:9; rm -rf /" })]);
  rejects("run-design", [design({ designLoops: "H1:7,H2:6,H3:9\n" })]);
  rejects("run-design", [design({ hotspotResidues: ["139; id"] })]);
  rejects("run-design", [design({ hotspotResidues: [] })]);
  rejects("run-design", [design({ hotspotResidues: [1.5] })]);
  rejects("run-design", [design({ temperature: "0.2; id" })]);
  rejects("run-design", [design({ temperature: 5 })]);
  rejects("run-design", [design({ temperature: NaN })]);
});

test("loop lengths are bounded", () => {
  rejects("run-design", [design({ designLoops: "H1:2,H2:6,H3:9" })]);
  rejects("run-design", [design({ designLoops: "H1:7,H2:6,H3:99" })]);
  rejects("run-design", [design({ designLoops: "H1:7,H2:6" })]);
});

test("the target path must be this session's chain-A file, nothing else", () => {
  rejects("run-design", [design({ targetPdbPath: "/etc/passwd" })]);
  rejects("run-design", [design({ targetPdbPath: path.join(root, "cache", "pdb", "..", "..", "..", "etc", "passwd") })]);
  rejects("run-design", [design({ targetPdbPath: path.join(root, "work", "2Z1P_chainA.pdb") })]);
  rejects("run-design", [design({ targetPdbPath: path.join(root, "cache", "pdb", "x.pdb") })]);
  rejects("run-design", [design({ targetPdbPath: target + "\0.pdb" })]);
  rejects("run-design", [design({ targetPdbPath: path.join(os.tmpdir(), "other", "cache", "pdb", "2Z1P_chainA.pdb") })]);
  rejects("run-freesasa", [{ chainAPath: "/etc/passwd" }]);
  rejects("run-discotope", [{ chainAPath: "/etc/passwd", pdbId: "2Z1P" }]);
});

test("read-pdb-file stays inside the session, even through a symlink", () => {
  const ok = path.join(root, "cache", "pdb", "2Z1P.pdb");
  fs.writeFileSync(ok, "ATOM\n");
  assert.deepEqual(validate("read-pdb-file", [ok], ctx), [ok]);
  rejects("read-pdb-file", ["/etc/passwd"]);
  rejects("read-pdb-file", [path.join(root, "..", "x.pdb")]);
  rejects("read-pdb-file", [path.join(root, "session.json")]);
  const secret = path.join(os.tmpdir(), `nbv-secret-${process.pid}.pdb`);
  fs.writeFileSync(secret, "SECRET\n");
  const link = path.join(root, "cache", "pdb", "link.pdb");
  fs.symlinkSync(secret, link);
  rejects("read-pdb-file", [link]);
  fs.unlinkSync(secret);
});

test("PDB IDs are exactly four letters or digits", () => {
  assert.deepEqual(validate("fetch-pdb", ["2z1p"], ctx), ["2Z1P"]);
  for (const bad of ["2Z1", "2Z1PX", "../..", "2Z1/", "", null, undefined, 12345, {}, ["2Z1P"]])
    rejects("fetch-pdb", [bad]);
  rejects("run-interpro", [{ pdbId: "../../x" }]);
  rejects("get-structure-title", ["1ZVH/../../x"]);
});

test("unknown, disabled and prototype-chain channel names are refused", () => {
  for (const ch of ["run-docker-build", "pull-docker-image", "run-rfdiffusion", "score-candidates",
    "constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => validate(ch, [], ctx), (e) => e instanceof ValidationError && e.status === 404, ch);
  }
});

test("anchor, vector and organism come from fixed lists", () => {
  assert.equal(validate("fetch-anchor", [{ type: "intimin" }], ctx)[0].type, "intimin");
  rejects("fetch-anchor", [{ type: "constructor" }]);
  rejects("fetch-anchor", [{ type: "__proto__" }]);
  rejects("codon-optimize", [{ aminoAcidSeq: "MKT", organism: "x; id" }]);
  rejects("build-plasmid", [{ constructDna: "ATG", vector: "pUC19", candidateId: "a" }]);
});

test("plasmid candidate id cannot be a path", () => {
  const base = { constructDna: "ATGAAA", vector: "pET-28a(+)" };
  rejects("build-plasmid", [{ ...base, candidateId: "../../etc/x" }]);
  rejects("build-plasmid", [{ ...base, candidateId: "a/b" }]);
  rejects("build-plasmid", [{ ...base, candidateId: "" }]);
  assert.equal(validate("build-plasmid", [{ ...base, candidateId: "design_1-a.b" }], ctx)[0].candidateId, "design_1-a.b");
});

test("sequences are alphabet- and length-checked", () => {
  rejects("codon-optimize", [{ aminoAcidSeq: "MKT; id" }]);
  rejects("codon-optimize", [{ aminoAcidSeq: "M".repeat(2001) }]);
  rejects("calculate-cai", [{ dnaSeq: "ATGX" }]);
  rejects("calculate-cai", [{ dnaSeq: "" }]);
  assert.equal(validate("calculate-cai", [{ dnaSeq: "ATGAAA" }], ctx)[0].dnaSeq, "ATGAAA");
});

test("project ids are plain names", () => {
  for (const bad of ["../x", "a/b", ".hidden", "a..b", "", "x".repeat(65), 5])
    rejects("load-project", [bad]), rejects("delete-project", [bad]);
  assert.deepEqual(validate("load-project", ["project_1700000000000"], ctx), ["project_1700000000000"]);
});

test("metrics upload is size- and type-limited", () => {
  const ok = { candidates: [], fileName: "m.csv", text: "id,x\n" };
  assert.equal(validate("import-metrics-dialog", [ok], ctx)[0].fileName, "m.csv");
  rejects("import-metrics-dialog", [{ ...ok, fileName: "m.exe" }]);
  rejects("import-metrics-dialog", [{ ...ok, text: "x".repeat(2_000_001) }]);
});

test("arguments must be a short array", () => {
  assert.throws(() => validate("fetch-pdb", "2Z1P", ctx), ValidationError);
  assert.throws(() => validate("fetch-pdb", [1, 2, 3, 4, 5], ctx), ValidationError);
});
