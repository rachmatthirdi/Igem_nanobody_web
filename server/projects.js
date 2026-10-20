// Saves a finished design as a project in the session's own projects/ folder,
// so "Open project" lists it even if the browser tab was closed when the job
// finished. The file has the same shape the app's own Save button writes.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The field list comes from the renderer's own state.js, so it cannot drift:
// a field added there appears here without a second edit.
function defaultState(appDir) {
  const code = fs.readFileSync(path.join(appDir, "renderer", "js", "state.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { timeout: 1000 });
  return JSON.parse(JSON.stringify(sandbox.window.AppState));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Builds the state of a project right after a design finished. What the server
// knows is the job's own parameters and results, plus whatever Target analysis
// the session cached; the rest keeps its default.
function buildProject(appDir, session, job, now = Date.now()) {
  const p = job.params;
  const r = job.result || {};
  const state = defaultState(appDir);
  const cache = (dir, file) => readJson(path.join(session.dir, "cache", dir, file));
  const interpro = cache("interpro", `${p.pdbId}.json`);
  const disco = cache("discotope", `${p.pdbId}.json`);
  Object.assign(state, {
    id: `design_${job.id}`,
    name: `${p.pdbId} design (${new Date(now).toISOString().slice(0, 16).replace("T", " ")})`,
    pdbId: p.pdbId,
    pdbPath: path.join(session.dir, "cache", "pdb", `${p.pdbId}.pdb`),
    chainAPath: p.targetPdbPath,
    domains: Array.isArray(interpro) ? interpro : [],
    discotopeResidues: Array.isArray(disco?.residues) ? disco.residues : [],
    hotspotResidues: p.hotspotResidues,
    scaffoldConfig: {
      scaffold_name: "3DWT",
      cdr_designed: ["H1", "H2", "H3"],
      cdr_config: p.designLoops,
      backbone_number: p.numDesigns,
      mpnn_designs: p.designsPerBackbone,
      mpnn_temperature: p.temperature,
    },
    backbones: r.backbones || [],
    backboneDir: r.backboneDir || null,
    targetTPath: r.targetTPath || null,
    seqDir: r.seqDir || null,
    rf2OutDir: r.rf2OutDir || null,
    candidates: r.candidates || [],
  });
  return { ...state, savedAt: new Date(now).toISOString() };
}

// Writes it with paths in the /nbroot form the app stores (so a project opens
// wherever the workspace lives).
function saveProject(appDir, session, job) {
  const project = buildProject(appDir, session, job);
  const dir = path.join(session.dir, "projects");
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(project, null, 2).split(session.dir).join("/nbroot");
  fs.writeFileSync(path.join(dir, `${project.id}.json`), text, "utf8");
  return project.id;
}

module.exports = { defaultState, buildProject, saveProject };
