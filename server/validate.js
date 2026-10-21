// Input validation for every API channel.
//
// The desktop app trusted its own renderer. A web service cannot: anything in
// a request body may have been written by an attacker, and several of these
// values end up in a `bash -lc` command line (the RFantibody stages), in a
// file name, or in a URL. So each channel has an explicit shape here, the
// request is rebuilt from only the fields that shape names, and anything else
// is dropped or rejected.
//
// validate(channel, args, ctx) returns the cleaned argument list, or throws a
// ValidationError (HTTP 400). ctx = { root, limits }.

const fs = require("fs");
const path = require("path");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

const bad = (msg) => {
  throw new ValidationError(msg);
};

const PDB_ID = /^[A-Z0-9]{4}$/;
const ORGANISMS = new Set(["Escherichia coli general", "Homo sapiens", "Pichia pastoris"]);
const VECTORS = new Set(["pET-28a(+)", "pET-22b(+)"]);
const ANCHORS = new Set(["lpp-ompa", "intimin"]);
const CDR_LABELS = ["H1", "H2", "H3", "L1", "L2", "L3"];
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CANDIDATE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function obj(v, what = "request") {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    bad(`${what} must be an object.`);
  return v;
}

function pdbId(v) {
  // typeof first: String(["2Z1P"]) is "2Z1P" and would slip through.
  const id = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!PDB_ID.test(id)) bad("Invalid PDB ID: expected four letters or digits.");
  return id;
}

function bool(v) {
  return v === true;
}

function int(v, min, max, what) {
  if (!Number.isInteger(v) || v < min || v > max)
    bad(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}

function num(v, min, max, what) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    bad(`${what} must be a number from ${min} to ${max}.`);
  return v;
}

function seq(v, alphabet, maxLen, what) {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen || !alphabet.test(v))
    bad(`${what} is not a valid sequence (up to ${maxLen} characters).`);
  return v;
}

function oneOf(v, allowed, what) {
  if (typeof v !== "string" || !allowed.has(v)) bad(`Unknown ${what}.`);
  return v;
}

// The one place a client-supplied path is accepted. It must be a regular file
// directly under the session's cache/pdb folder and be named like the files
// fetch-pdb writes, so no other path shape can reach a container or fs call.
function chainAPath(v, root) {
  if (typeof v !== "string" || v.length > 512 || v.includes("\0"))
    bad("Invalid structure path.");
  const abs = path.resolve(v);
  const dir = path.join(root, "cache", "pdb");
  if (path.dirname(abs) !== dir || !/^[A-Z0-9]{4}_chainA\.pdb$/.test(path.basename(abs)))
    bad("Invalid structure path.");
  return abs;
}

// Any .pdb inside the session workspace (viewer reads of designs/backbones).
// Resolves symlinks so a link planted in the workspace cannot point out of it.
function sessionPdbPath(v, root) {
  if (typeof v !== "string" || v.length > 512 || v.includes("\0"))
    bad("Invalid file path.");
  const abs = path.resolve(v);
  if (!abs.endsWith(".pdb")) bad("Only .pdb files can be read.");
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) bad("Invalid file path.");
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return abs; // missing file: let the handler report it
  }
  const realRoot = fs.realpathSync(root);
  const relReal = path.relative(realRoot, real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) bad("Invalid file path.");
  return abs;
}

// A result folder the design job wrote: directly under the session's work/
// folder and named like the engine names them (<PDBID>_<digits> for backbones,
// rf2_out_<digits> for RF2 predictions). It is passed to a container, so it
// must be a real directory inside the session, not a link pointing out of it.
function workDir(v, root, namePattern, what) {
  if (typeof v !== "string" || v.length > 512 || v.includes("\0")) bad(`Invalid ${what}.`);
  const abs = path.resolve(v);
  const dir = path.join(root, "work");
  if (path.dirname(abs) !== dir || !namePattern.test(path.basename(abs))) bad(`Invalid ${what}.`);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    bad(`There is no ${what} to score in this session.`);
  }
  if (!st.isDirectory()) bad(`Invalid ${what}.`);
  return abs;
}

function cdr(v) {
  obj(v, "cdr");
  const out = {};
  for (const [label, r] of Object.entries(v)) {
    if (!CDR_LABELS.includes(label)) bad("cdr contains an unknown loop.");
    obj(r, "cdr loop");
    if (!Array.isArray(r.residues) || r.residues.length > 200) bad("cdr loop is invalid.");
    out[label] = {
      start: int(r.start, 0, 99999, "cdr start"),
      end: int(r.end, 0, 99999, "cdr end"),
      residues: r.residues.map((n) => int(n, 0, 99999, "cdr residue")),
    };
  }
  return out;
}

function loops(v, limits) {
  const m = /^H1:(\d{1,2}),H2:(\d{1,2}),H3:(\d{1,2})$/.exec(String(v));
  if (!m) bad("Loop lengths must look like H1:7,H2:6,H3:9.");
  for (const n of m.slice(1))
    int(Number(n), limits.minLoop, limits.maxLoop, "Each loop length");
  return `H1:${m[1]},H2:${m[2]},H3:${m[3]}`;
}

const DNA = /^[ACGTUNacgtun]+$/;
const PROTEIN = /^[A-Za-z*]+$/;

// One entry per channel the browser may call. `run` is the cleaner.
const SHAPES = {
  "fetch-pdb": (a) => [pdbId(a[0])],
  "get-structure-title": (a) => [pdbId(a[0])],
  "read-pdb-file": (a, ctx) => [sessionPdbPath(a[0], ctx.root)],
  "run-interpro": (a) => {
    const p = obj(a[0]);
    return [{ pdbId: pdbId(p.pdbId), forceRefresh: bool(p.forceRefresh) }];
  },
  "run-freesasa": (a, ctx) => {
    const p = obj(a[0]);
    return [{ chainAPath: chainAPath(p.chainAPath, ctx.root) }];
  },
  "run-discotope": (a, ctx) => {
    const p = obj(a[0]);
    return [
      {
        chainAPath: chainAPath(p.chainAPath, ctx.root),
        pdbId: pdbId(p.pdbId),
        forceRefresh: bool(p.forceRefresh),
      },
    ];
  },
  // Scores the designs of this session's last run again. Only the two result
  // folders and the loop positions are taken from the request.
  "score-candidates": (a, ctx) => {
    const p = obj(a[0]);
    return [
      {
        rf2OutDir: workDir(p.rf2OutDir, ctx.root, /^rf2_out_\d{1,16}$/, "RF2 output folder"),
        backboneDir: workDir(p.backboneDir, ctx.root, /^[A-Z0-9]{4}_\d{1,16}$/, "backbone folder"),
        cdr: cdr(p.cdr ?? {}),
      },
    ];
  },
  "get-scaffold-sequence": () => [{ scaffoldName: "3DWT" }],
  "codon-optimize": (a) => {
    const p = obj(a[0]);
    return [
      {
        aminoAcidSeq: seq(p.aminoAcidSeq, PROTEIN, 2000, "Amino-acid sequence"),
        organism: oneOf(p.organism ?? "Escherichia coli general", ORGANISMS, "organism"),
      },
    ];
  },
  "calculate-cai": (a) => [{ dnaSeq: seq(obj(a[0]).dnaSeq, DNA, 20000, "DNA sequence") }],
  "fetch-anchor": (a) => {
    const p = obj(a[0]);
    return [{ type: oneOf(p.type, ANCHORS, "anchor type"), forceRefresh: bool(p.forceRefresh) }];
  },
  "build-anchor-construct": (a) => {
    const p = obj(a[0]);
    return [
      {
        anchorSeq: seq(p.anchorSeq, PROTEIN, 3000, "Anchor sequence"),
        nanobodyDna: seq(p.nanobodyDna, DNA, 20000, "Nanobody DNA"),
        organism: oneOf(p.organism ?? "Escherichia coli general", ORGANISMS, "organism"),
      },
    ];
  },
  "build-plasmid": (a) => {
    const p = obj(a[0]);
    if (typeof p.candidateId !== "string" || !CANDIDATE_ID.test(p.candidateId))
      bad("Invalid candidate id.");
    const out = {
      constructDna: seq(p.constructDna, DNA, 30000, "Construct DNA"),
      vector: oneOf(p.vector ?? "pET-28a(+)", VECTORS, "vector"),
      includePelb: bool(p.includePelb),
      anchorHasNativeSignal: bool(p.anchorHasNativeSignal),
      candidateId: p.candidateId,
    };
    if (p.cai !== undefined && p.cai !== null) out.cai = num(p.cai, 0, 1, "cai");
    return [out];
  },
  "import-metrics-dialog": (a) => {
    const p = obj(a[0]);
    if (!Array.isArray(p.candidates) || p.candidates.length > 500) bad("Too many candidates.");
    if (typeof p.fileName !== "string" || p.fileName.length > 200) bad("Invalid file name.");
    if (!/\.(json|csv|sc)$/i.test(p.fileName)) bad("Metrics files must be .json, .csv or .sc.");
    if (typeof p.text !== "string" || p.text.length > 2_000_000) bad("Metrics file is too large.");
    return [{ candidates: p.candidates, fileName: p.fileName, text: p.text }];
  },
  "open-output-folder": () => [],
  "save-project": (a) => [obj(a[0], "project")],
  "load-project": (a) => {
    if (typeof a[0] !== "string" || !PROJECT_ID.test(a[0]) || a[0].includes(".."))
      bad("Invalid project id.");
    return [a[0]];
  },
  "delete-project": (a) => {
    if (typeof a[0] !== "string" || !PROJECT_ID.test(a[0]) || a[0].includes(".."))
      bad("Invalid project id.");
    return [a[0]];
  },
  "list-projects": () => [],
  "import-shared": (a) => {
    const p = obj(a[0]);
    if (typeof p.id !== "string" || !/^design-[A-Za-z0-9_-]{1,40}$/.test(p.id)) bad("Invalid result id.");
    return [{ id: p.id }];
  },

  // The whole design pipeline as one job (RFdiffusion -> ProteinMPNN -> RF2
  // -> scoring). Its numbers are what the quota is about.
  "run-design": (a, ctx) => {
    const p = obj(a[0]);
    const L = ctx.limits;
    const hot = p.hotspotResidues;
    if (!Array.isArray(hot) || hot.length < 1 || hot.length > 20)
      bad("Pick between 1 and 20 hotspot residues.");
    return [
      {
        targetPdbPath: chainAPath(p.targetPdbPath, ctx.root),
        pdbId: pdbId(p.pdbId),
        designLoops: loops(p.designLoops, L),
        hotspotResidues: [...new Set(hot.map((n) => int(n, 1, 9999, "Hotspot residue")))],
        numDesigns: int(p.numDesigns, 1, L.maxBackbones, "Number of backbones"),
        designsPerBackbone: int(p.designsPerBackbone, 1, L.maxSeqs, "Sequences per backbone"),
        temperature: num(p.temperature, 0.05, 1, "Sampling temperature"),
        numRecycles: int(p.numRecycles ?? 10, 1, 10, "Recycles"),
        cdr: cdr(p.cdr ?? {}),
      },
    ];
  },
};

// Channels the server answers itself (no engine call). Listed so the router
// can tell "known but local" from "unknown".
const LOCAL_CHANNELS = new Set([
  "get-settings",
  "save-settings",
  "get-platform-info",
  "check-gpu",
  "check-docker",
  "get-docker-storage-info",
  "test-gpu-docker",
  "pull-docker-image",
  "cancel-docker-pull",
  "run-docker-build",
  "cancel-pipeline",
  "begin-pipeline",
]);

// Channels that occupy the GPU and therefore go through the queue.
const QUEUED_CHANNELS = new Set(["run-design"]);

function validate(channel, args, ctx) {
  if (!Array.isArray(args) || args.length > 4) bad("Arguments must be a short array.");
  const shape = Object.prototype.hasOwnProperty.call(SHAPES, channel) ? SHAPES[channel] : null;
  if (!shape) {
    const e = new ValidationError(`Unknown or disabled channel: ${String(channel).slice(0, 40)}`);
    e.status = 404;
    throw e;
  }
  return shape(args, ctx);
}

module.exports = { validate, ValidationError, LOCAL_CHANNELS, QUEUED_CHANNELS, SHAPES };
