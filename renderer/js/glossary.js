// Plain-language tooltips for the terms used in the pipeline.
// DRAFT wording: the dry-lab team should review the science before release.
//
// Markup: <span class="term" data-term="pLDDT">pLDDT</span>, or an empty
// <span class="term term-only" data-term="pLDDT"></span> placed after a label.
// init() adds a small info button after each one; the tooltip opens on click,
// keyboard focus or hover, and closes with Esc.
(function () {
  const TERMS = {
    SASA: {
      name: "SASA",
      short:
        "Solvent-accessible surface area: how much of each residue is exposed on the protein's surface.",
      detail: "Exposed residues are easier for a nanobody to reach.",
    },
    DiscoTope: {
      name: "DiscoTope-3.0",
      short:
        "A prediction of which surface residues are likely to be part of an antibody-binding site (an epitope).",
      detail: "A higher score means a residue is more likely to be in an epitope.",
    },
    hotspot: {
      name: "Hotspot",
      short:
        "A target residue you want the nanobody to touch. The design tools steer new binders toward your hotspots.",
    },
    scaffold: {
      name: "Scaffold",
      short:
        "The nanobody framework that stays fixed. Only its loops (the CDRs) are redesigned.",
    },
    CDR: {
      name: "CDR (H1, H2, H3)",
      short:
        "Complementarity-determining regions: the three loops that touch the target.",
      detail: "H3 is usually the longest and the most variable.",
    },
    redesignLength: {
      name: "Redesign length",
      short: "How many residues the redesigned loop will have.",
    },
    backbones: {
      name: "Backbone number",
      short: "How many different backbone shapes RFdiffusion generates.",
      detail: "More backbones means more candidates, and a longer run.",
    },
    mpnnDesigns: {
      name: "MPNN designs per backbone",
      short: "How many amino-acid sequences ProteinMPNN proposes for each backbone.",
    },
    mpnnTemp: {
      name: "MPNN temperature",
      short:
        "How random ProteinMPNN's sequence choices are. Lower values give safer, more similar sequences; higher values give more variety.",
      detail: "The app's default is 0.2.",
    },
    RFdiffusion: {
      name: "RFdiffusion",
      short: "Generates new nanobody backbone shapes that fit your hotspots.",
    },
    ProteinMPNN: {
      name: "ProteinMPNN",
      short: "Proposes amino-acid sequences that should fold into each backbone.",
    },
    RF2: {
      name: "RF2 (RoseTTAFold2)",
      short:
        "Predicts the structure of each designed sequence again, so it can be scored.",
    },
    pLDDT: {
      name: "pLDDT",
      short: "How confident the prediction is, from 0 to 100. Higher is better.",
      detail: "70 or more is usable; 90 or more is high confidence.",
    },
    PAE: {
      name: "PAE",
      short:
        "Predicted aligned error: how far off the model expects its own geometry to be. Lower is better.",
      detail: "The app's default cutoff is 10.",
    },
    cdrRmsd: {
      name: "CDR RMSD",
      short:
        "How much the loop shape in the RF2 prediction differs from the designed backbone, in Å. Lower is better.",
    },
    h3Rmsd: {
      name: "H3 RMSD",
      short: "The same comparison, for the H3 loop only, in Å. Lower is better.",
    },
    dG: {
      name: "ΔG",
      short:
        "Predicted binding energy in kcal/mol (from PRODIGY). More negative means stronger predicted binding.",
      detail: "The app's default cutoff is −8.",
    },
    composite: {
      name: "Composite score",
      short:
        "One percentage that combines the five metrics with equal weight, so candidates can be ranked. Higher is better.",
    },
    CAI: {
      name: "CAI",
      short:
        "Codon Adaptation Index (0 to 1): how closely the DNA matches the host's preferred codons.",
      detail: "A higher value usually means better expression.",
    },
    anchor: {
      name: "Anchor protein",
      short:
        "The surface protein your nanobody is fused to, so it is displayed on the outside of the bacterial cell.",
    },
    PelB: {
      name: "PelB",
      short: "A signal peptide that sends a protein to the periplasm in E. coli.",
    },
    vector: {
      name: "Vector",
      short: "The plasmid backbone that carries your insert.",
    },
    toolsImage: {
      name: "Tools image",
      short:
        "A packaged copy of all the design software (about 19 GB), run through Docker.",
      detail: "Downloaded once, then reused.",
    },
  };

  let pop = null;
  let activeBtn = null;
  let hoverTimer = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.id = "term-pop";
    pop.className = "term-pop";
    pop.setAttribute("role", "tooltip");
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }

  function show(btn) {
    const entry = TERMS[btn.dataset.term];
    if (!entry) return;
    const p = ensurePop();
    p.replaceChildren();
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const short = document.createElement("span");
    short.textContent = entry.short;
    p.append(name, short);
    if (entry.detail) {
      const detail = document.createElement("span");
      detail.className = "term-pop-detail";
      detail.textContent = entry.detail;
      p.appendChild(detail);
    }
    p.hidden = false;
    activeBtn = btn;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-describedby", p.id);

    const r = btn.getBoundingClientRect();
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - pw / 2),
      window.innerWidth - pw - 8,
    );
    const below = r.bottom + 8 + ph < window.innerHeight;
    p.style.left = `${left}px`;
    p.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - ph - 8)}px`;
  }

  function hide() {
    clearTimeout(hoverTimer);
    if (pop) pop.hidden = true;
    if (activeBtn) {
      activeBtn.setAttribute("aria-expanded", "false");
      activeBtn.removeAttribute("aria-describedby");
      activeBtn = null;
    }
  }

  function makeButton(term) {
    const entry = TERMS[term];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "term-btn";
    btn.dataset.term = term;
    btn.setAttribute("aria-label", `What is ${entry.name}?`);
    btn.setAttribute("aria-expanded", "false");
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", "info");
    btn.appendChild(icon);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeBtn === btn) hide();
      else show(btn);
    });
    btn.addEventListener("focus", () => show(btn));
    btn.addEventListener("blur", hide);
    btn.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => show(btn), 250);
    });
    btn.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      if (document.activeElement !== btn) hide();
    });
    return btn;
  }

  function enhance(root = document) {
    root.querySelectorAll(".term[data-term]").forEach((node) => {
      if (node.dataset.enhanced || !TERMS[node.dataset.term]) return;
      node.dataset.enhanced = "1";
      node.insertAdjacentElement("afterend", makeButton(node.dataset.term));
    });
    window.Icons?.refresh();
  }

  function init() {
    enhance();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pop && !pop.hidden) hide();
    });
    document.addEventListener("click", (e) => {
      if (pop && !pop.hidden && !e.target.closest(".term-btn")) hide();
    });
  }

  window.Glossary = { init, enhance, TERMS };
})();
