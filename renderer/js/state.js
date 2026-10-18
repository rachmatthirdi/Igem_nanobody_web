// Central, shared application state for the whole 4-tab pipeline.
// Plain object (no framework) - tab modules read/write it directly.
// One factory feeds both the initial state and reset(), so a field added here
// can't be forgotten by reset() (backboneDir was, and survived every reset).
function createDefaultState() {
  return {
    id: null,
    name: null,

    // Tab 1 - Target
    pdbId: null,
    pdbPath: null,
    chainAPath: null,
    structureTitle: "",
    domains: [],
    sasaResidues: [],
    discotopeResidues: [],
    hotspotResidues: [], // array of residue numbers selected by the user

    // Tab 2 - Design
    scaffold: null, // { scaffoldName, filePath, sequence, residueNumbers, cdr }
    scaffoldConfig: null, // { scaffold_name, cdr_designed, cdr_config, backbone_number, mpnn_designs, mpnn_temperature }
    backbones: [],
    backboneDir: null,
    targetTPath: null,
    seqDir: null,
    rf2OutDir: null,
    candidates: [], // [{ id, plddt, pae, cdrRmsd, h3Rmsd, dg, composite, pass, dna, cai, gcContent, pdbPath }]

    // Tab 3 - Screening
    selectedCandidateIds: [],
    filterWeights: { plddt: 0.2, pae: 0.2, cdrRmsd: 0.2, h3Rmsd: 0.2, dg: 0.2 },

    // Tab 4 - Construct
    anchor: null, // { type, sequence, header, label, source }
    constructCandidateId: null,
    constructDna: null,
    constructComponents: null,
    plasmid: null, // { fastaPath, preview, lengthBp, gcContent, cai, vector, includePelb }
  };
}

window.AppState = createDefaultState();

window.StateUtils = {
  reset() {
    Object.assign(window.AppState, createDefaultState());
  },

  serialize() {
    return JSON.parse(JSON.stringify(window.AppState));
  },

  applyLoaded(data) {
    Object.assign(window.AppState, data);
  },
};
