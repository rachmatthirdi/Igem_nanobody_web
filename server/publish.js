// Turns engine results into shared entries. Every function here takes what the
// server's own engine returned, copies out only known fields, and checks that
// any file it reads lies inside the session's workspace.

const fs = require("fs");
const path = require("path");

const MAX_PDB_BYTES = 5_000_000;
const STEM = /^[A-Za-z0-9_.-]{1,100}$/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Reads a regular file that really is inside `root` (symlinks resolved).
function readInside(root, file, maxBytes) {
  const real = fs.realpathSync(file);
  const rel = path.relative(fs.realpathSync(root), real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("file outside the session");
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > maxBytes) throw new Error("not a regular file, or too large");
  return fs.readFileSync(real, "utf8");
}

// ---- Target analysis ---------------------------------------------------------
// FreeSASA, DiscoTope and InterPro each finish separately, so they fill one
// entry per PDB ID in turn. The entry is hidden from the list until at least
// one of them has produced something.
function publishTarget(store, pdbId, patch) {
  const id = `target-${pdbId}`;
  const prev = store.getData(id)?.data || {};
  const data = { ...prev };
  if (typeof patch.title === "string") data.title = patch.title.slice(0, 300);
  if (Array.isArray(patch.sasa))
    data.sasa = patch.sasa.slice(0, 5000).map((r) => ({ resNum: num(r.resNum), residue: String(r.residue ?? "").slice(0, 4), sasa: num(r.sasa), rsa: num(r.rsa) }));
  if (Array.isArray(patch.discotope))
    data.discotope = patch.discotope.slice(0, 5000).map((r) => ({
      resNum: num(r.resNum),
      residue: String(r.residue ?? "").slice(0, 4),
      discotopeScore: num(r.discotopeScore),
      calibratedScore: num(r.calibratedScore),
      rsa: num(r.rsa),
      predictedEpitope: r.predictedEpitope === true,
    }));
  if (Array.isArray(patch.domains))
    data.domains = patch.domains.slice(0, 200).map((d) => ({
      accession: String(d.accession ?? "").slice(0, 30),
      name: String(d.name ?? "").slice(0, 200),
      type: String(d.type ?? "").slice(0, 40),
    }));
  const ready = !!(data.sasa?.length || data.discotope?.length || data.domains?.length);
  return store.put(id, {
    kind: "target",
    title: data.title || pdbId,
    pdbId,
    summary: {
      ready,
      residues: data.sasa?.length ?? data.discotope?.length ?? 0,
      epitopeResidues: data.discotope ? data.discotope.filter((r) => r.predictedEpitope).length : null,
      domains: data.domains?.length ?? null,
    },
    data,
  });
}

// ---- Design ------------------------------------------------------------------
function publishDesign(store, sessionDir, job) {
  const p = job.params;
  const files = {};
  const candidates = [];
  for (const c of job.result?.candidates || []) {
    if (typeof c.id !== "string" || !STEM.test(c.id)) continue;
    const entry = {
      id: c.id,
      plddt: num(c.plddt),
      pae: num(c.pae),
      interactionPae: num(c.interactionPae),
      cdrRmsd: num(c.cdrRmsd),
      h3Rmsd: num(c.h3Rmsd),
      dg: num(c.dg),
      file: null,
    };
    try {
      files[`${c.id}.pdb`] = readInside(sessionDir, c.pdbPath, MAX_PDB_BYTES);
      entry.file = `${c.id}.pdb`;
    } catch {
      // Metrics are still worth showing without the structure.
    }
    candidates.push(entry);
  }
  return store.put(`design-${job.id}`, {
    kind: "design",
    title: `${p.pdbId} nanobody design`,
    pdbId: p.pdbId,
    summary: { candidates: candidates.length, backbones: p.numDesigns },
    data: {
      params: {
        pdbId: p.pdbId,
        designLoops: p.designLoops,
        hotspotResidues: p.hotspotResidues,
        numDesigns: p.numDesigns,
        designsPerBackbone: p.designsPerBackbone,
        temperature: p.temperature,
      },
      candidates,
    },
    files,
  });
}

// ---- Construct ---------------------------------------------------------------
function publishConstruct(store, sessionDir, params, result, nonce) {
  const fasta = readInside(sessionDir, result.fastaPath, 200_000);
  return store.put(`construct-${nonce}`, {
    kind: "construct",
    title: `${params.candidateId} in ${params.vector}`,
    pdbId: null,
    summary: { lengthBp: num(result.lengthBp), vector: params.vector },
    data: {
      candidateId: params.candidateId,
      vector: params.vector,
      includePelb: params.includePelb === true,
      lengthBp: num(result.lengthBp),
      gcContent: num(result.gcContent),
      cai: num(result.cai),
      restrictionFixes: Array.isArray(result.restrictionFixes) ? result.restrictionFixes.length : 0,
      restrictionUnresolved: Array.isArray(result.restrictionUnresolved) ? result.restrictionUnresolved.length : 0,
    },
    files: { "construct.fasta": fasta },
  });
}

module.exports = { publishTarget, publishDesign, publishConstruct, readInside };
