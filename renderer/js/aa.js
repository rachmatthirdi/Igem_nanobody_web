// Three-letter -> one-letter amino acid codes (MSE = selenomethionine, read as
// MET). The one copy shared by the main process (require) and the renderer
// (<script> -> window.AA_3TO1). python/run_freesasa.py keeps its own, since it
// can't import JS.
(function (root) {
  const AA_3TO1 = {
    ALA: "A",
    ARG: "R",
    ASN: "N",
    ASP: "D",
    CYS: "C",
    GLN: "Q",
    GLU: "E",
    GLY: "G",
    HIS: "H",
    ILE: "I",
    LEU: "L",
    LYS: "K",
    MET: "M",
    PHE: "F",
    PRO: "P",
    SER: "S",
    THR: "T",
    TRP: "W",
    TYR: "Y",
    VAL: "V",
    MSE: "M",
  };
  if (typeof module !== "undefined" && module.exports) module.exports = AA_3TO1;
  else root.AA_3TO1 = AA_3TO1;
})(typeof window !== "undefined" ? window : globalThis);
