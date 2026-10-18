// Prerequisite gates for action buttons.
//
// A gated button stays focusable (aria-disabled, not `disabled`) and a line of
// text next to it says what is missing. Clicking it explains instead of doing
// nothing. `disabled` stays reserved for "busy" states set by the tab scripts.
(function () {
  function S() {
    return window.AppState;
  }

  const toolsReady = () => !!window.App?.toolsReady;

  // First failing check wins; return null when the button may be used.
  const GATES = {
    "btn-run-pipeline": () => {
      if (!toolsReady()) return "Download the tools image first.";
      if (!S().hotspotResidues.length)
        return "Pick hotspots on the Target step first.";
      if (!S().scaffold) return "Waiting for the scaffold to load.";
      return null;
    },
    "btn-goto-screening": () =>
      S().candidates.length ? null : "Run the design first.",
    "btn-goto-construct": () =>
      S().selectedCandidateIds.length
        ? null
        : "Select at least one candidate first.",
    "btn-codon-optimize": () => {
      if (!S().selectedCandidateIds.length)
        return "Select candidates on the Screening step first.";
      if (!toolsReady()) return "Download the tools image first.";
      return null;
    },
    "btn-build-anchor-construct": () => {
      if (!S().anchor) return "Choose an anchor first.";
      if (!S().candidates.some((c) => c.dna))
        return "Optimize codons for a candidate first.";
      return null;
    },
    "btn-build-plasmid": () =>
      S().constructDna ? null : "Build the anchor construct first.",
  };

  const reasonEls = {};

  function reasonFor(btn) {
    let node = reasonEls[btn.id];
    if (!node) {
      node = document.createElement("span");
      node.className = "gate-reason";
      node.id = `gate-${btn.id}`;
      node.setAttribute("role", "status");
      node.hidden = true;
      btn.insertAdjacentElement("afterend", node);
      btn.setAttribute("aria-describedby", node.id);
      reasonEls[btn.id] = node;
    }
    return node;
  }

  function refresh() {
    for (const [id, check] of Object.entries(GATES)) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const reason = check();
      const node = reasonFor(btn);
      btn.setAttribute("aria-disabled", reason ? "true" : "false");
      node.textContent = reason || "";
      node.hidden = !reason;
    }
  }

  // Capture phase so a gated button's own click handler never runs.
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest?.('[aria-disabled="true"]');
      if (!btn || !GATES[btn.id]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const node = reasonEls[btn.id];
      if (!node) return;
      node.classList.remove("flash");
      void node.offsetWidth; // restart the animation
      node.classList.add("flash");
    },
    true,
  );

  window.Gates = { refresh };
})();
