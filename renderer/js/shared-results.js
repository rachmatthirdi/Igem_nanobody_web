// "Shared results": browse what the service has produced for everyone
// (target analyses, designs, constructs). Entries are public and expire seven
// days after they were produced.
//
// Everything shown comes from the server's shared store and is put on the page
// with textContent, never innerHTML, so nothing stored there can run as markup.
(function () {
  const $ = (id) => document.getElementById(id);
  let viewer = null;

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "onclick") node.addEventListener("click", v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return node;
  }

  async function get(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
    return data;
  }

  const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "-");
  const KIND = { target: "Target analysis", design: "Design", construct: "Construct" };

  function timeLeft(expiresAt) {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return "expired";
    const h = Math.floor(ms / 3_600_000);
    return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h} h left` : "under 1 h left";
  }

  function table(headers, rows) {
    const t = el("table", { class: "data-table" });
    t.append(el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, h)))));
    const body = el("tbody");
    for (const r of rows) body.append(el("tr", {}, ...r.map((c) => (c instanceof Node ? el("td", {}, c) : el("td", {}, c)))));
    t.append(body);
    return t;
  }

  function link(label, href) {
    return el("a", { href, target: "_blank", rel: "noopener", class: "btn-link" }, label);
  }

  // ---- list ----------------------------------------------------------------------
  async function showList() {
    const host = $("shared-body");
    host.replaceChildren(el("p", { class: "section-hint" }, "Loading..."));
    const kind = $("shared-kind").value;
    const pdb = $("shared-pdb").value.trim().toUpperCase();
    try {
      const qs = new URLSearchParams();
      if (kind) qs.set("kind", kind);
      if (/^[A-Z0-9]{4}$/.test(pdb)) qs.set("pdb", pdb);
      const q = $("shared-q").value.trim();
      if (q) qs.set("q", q);
      if ($("shared-mine").checked) qs.set("ids", (window.WebResults?.mine() || []).join(","));
      const { entries, retentionDays } = await get(`/api/shared${qs.size ? `?${qs}` : ""}`);
      $("shared-retention").textContent = `${retentionDays} days`;
      if (!entries.length) {
        host.replaceChildren(el("p", { class: "section-hint" }, q || pdb || kind || $("shared-mine").checked ? "No results match. Results disappear 7 days after they were produced." : "Nothing here yet. Results appear after someone runs an analysis, a design or a construct."));
        return;
      }
      host.replaceChildren(
        table(
          ["Type", "Name", "PDB", "Details", "Produced", "Result id", "Expires", ""],
          entries.map((m) => [
            KIND[m.kind] || m.kind,
            m.title,
            m.pdbId || "-",
            summaryText(m),
            new Date(m.createdAt).toLocaleString(),
            m.id,
            timeLeft(m.expiresAt),
            el("button", { class: "btn btn-secondary", onclick: () => showDetail(m.id) }, "Open"),
          ]),
        ),
      );
    } catch (e) {
      host.replaceChildren(el("p", { class: "status-fail" }, e.message));
    }
  }

  function summaryText(m) {
    const s = m.summary || {};
    if (m.kind === "target") return `${s.residues ?? 0} residues, ${s.epitopeResidues ?? "-"} predicted epitope, ${s.domains ?? "-"} domains`;
    if (m.kind === "design")
      return `${s.candidates ?? 0} candidates from ${s.backbones ?? "?"} backbone(s); hotspots ${(s.hotspots || []).join(", ")}`;
    return `${s.lengthBp ?? "?"} bp, ${s.vector ?? ""}`;
  }

  // ---- detail --------------------------------------------------------------------
  async function showDetail(id) {
    const host = $("shared-body");
    host.replaceChildren(el("p", { class: "section-hint" }, "Loading..."));
    try {
      const { meta, data } = await get(`/api/shared/${encodeURIComponent(id)}`);
      const back = el("button", { class: "btn btn-ghost", onclick: showList }, "← Back to the list");
      const head = el("h3", {}, `${KIND[meta.kind] || meta.kind}: ${meta.title}`);
      const sub = el("p", { class: "section-hint" }, `${timeLeft(meta.expiresAt)} - produced ${new Date(meta.createdAt).toLocaleString()}`);
      const url = `${location.origin}${location.pathname}#result=${meta.id}`;
      const copy = el("button", { class: "btn btn-ghost", onclick: () => copyLink(url, copy) }, "Copy link");
      const idLine = el("p", { class: "section-hint" }, `Result id: ${meta.id} - `, copy);
      const body = meta.kind === "target" ? targetView(data) : meta.kind === "design" ? designView(meta, data) : constructView(meta, data);
      history.replaceState(null, "", `#result=${meta.id}`);
      host.replaceChildren(back, head, sub, idLine, body);
    } catch (e) {
      host.replaceChildren(el("p", { class: "status-fail" }, e.message), el("button", { class: "btn btn-ghost", onclick: showList }, "← Back"));
    }
  }

  async function copyLink(url, button) {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Copied";
    } catch {
      button.replaceWith(el("input", { type: "text", value: url, readonly: "", size: "48" }));
    }
  }

  async function continueWith(id) {
    const note = $("shared-continue-note");
    note.textContent = "Copying to your workspace...";
    try {
      const r = await window.api.importShared({ id });
      if (!r.candidates.length) throw new Error("This result has no structures to work with.");
      window.AppState.pdbId = r.pdbId;
      window.AppState.candidates = r.candidates;
      window.AppState.selectedCandidateIds = [];
      window.A11y.closeModal($("shared-modal"));
      window.ConsolePanel?.log("ok", `Loaded ${r.candidates.length} candidate(s) from ${id}. Re-scoring is not available for imported designs.`, "shared");
      window.App.switchTab("screening");
      window.TabScreening?.refresh();
    } catch (e) {
      note.textContent = e.message;
    }
  }

  function targetView(d) {
    const kids = [];
    if (d.domains?.length)
      kids.push(el("h4", {}, "InterPro domains"), table(["Accession", "Name", "Type"], d.domains.map((x) => [x.accession, x.name, x.type])));
    if (d.discotope?.length) {
      const top = [...d.discotope].sort((a, b) => (b.discotopeScore ?? -9) - (a.discotopeScore ?? -9)).slice(0, 15);
      kids.push(
        el("h4", {}, "Top 15 residues by DiscoTope-3.0 score"),
        table(["Residue", "Score", "Calibrated", "RSA", "Epitope"], top.map((r) => [`${r.residue} ${r.resNum}`, fmt(r.discotopeScore, 3), fmt(r.calibratedScore, 3), fmt(r.rsa, 2), r.predictedEpitope ? "yes" : "no"])),
      );
    }
    if (d.sasa?.length) {
      const top = [...d.sasa].sort((a, b) => (b.sasa ?? -1) - (a.sasa ?? -1)).slice(0, 15);
      kids.push(el("h4", {}, "15 most exposed residues (FreeSASA)"), table(["Residue", "SASA (Å²)", "Relative"], top.map((r) => [`${r.residue} ${r.resNum}`, fmt(r.sasa, 1), fmt(r.rsa, 2)])));
    }
    return el("div", {}, ...kids);
  }

  function designView(meta, d) {
    const p = d.params;
    const info = el("p", {}, `Hotspots ${p.hotspotResidues.join(", ")}; loops ${p.designLoops}; ${p.numDesigns} backbone(s) x ${p.designsPerBackbone} sequence(s); temperature ${p.temperature}.`);
    const viewerBox = el("div", { id: "shared-viewer", class: "shared-viewer", hidden: "" });
    const note = el("p", { class: "section-hint", id: "shared-viewer-note" });
    const rows = d.candidates.map((c) => [
      c.id,
      fmt(c.plddt, 1),
      fmt(c.pae, 1),
      fmt(c.cdrRmsd, 2),
      fmt(c.h3Rmsd, 2),
      fmt(c.dg, 1),
      c.file
        ? el(
            "span",
            {},
            el("button", { class: "btn btn-secondary", onclick: () => view3d(meta.id, c.file, viewerBox, note) }, "3D"),
            " ",
            link("PDB", `/api/shared/${encodeURIComponent(meta.id)}/file/${encodeURIComponent(c.file)}?download=1`),
          )
        : "-",
    ]);
    const cont = el("button", { class: "btn btn-primary", onclick: () => continueWith(meta.id) }, "Continue in my workspace (Screening)");
    return el("div", {}, info, el("p", {}, cont, " ", el("span", { id: "shared-continue-note", class: "section-hint" })), table(["Candidate", "pLDDT", "PAE", "CDR RMSD", "H3 RMSD", "ΔG (kcal/mol)", "Structure"], rows), viewerBox, note);
  }

  async function view3d(id, file, box, note) {
    note.textContent = "Loading structure...";
    try {
      const res = await fetch(`/api/shared/${encodeURIComponent(id)}/file/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error("The structure is no longer available.");
      const text = await res.text();
      box.hidden = false;
      if (!viewer || viewer.container !== box) viewer = new window.Viewer3D(box);
      await viewer.loadPdb(text);
      note.textContent = file;
    } catch (e) {
      note.textContent = `Could not show the structure here (${e.message}). Use the PDB link to download it.`;
    }
  }

  function constructView(meta, d) {
    const fasta = el("pre", { class: "fasta-preview" }, "Loading...");
    fetch(`/api/shared/${encodeURIComponent(meta.id)}/file/construct.fasta`)
      .then((r) => r.text())
      .then((t) => (fasta.textContent = t))
      .catch(() => (fasta.textContent = "The FASTA is no longer available."));
    return el(
      "div",
      {},
      el("p", {}, `Candidate ${d.candidateId}; vector ${d.vector}${d.includePelb ? " + PelB" : ""}; ${d.lengthBp} bp; GC ${fmt(d.gcContent, 1)}%; CAI ${fmt(d.cai, 3)}.`),
      d.restrictionUnresolved ? el("p", { class: "status-fail" }, `${d.restrictionUnresolved} internal restriction site(s) could not be removed.`) : "",
      fasta,
      link("Download FASTA", `/api/shared/${encodeURIComponent(meta.id)}/file/construct.fasta?download=1`),
    );
  }

  // ---- wiring --------------------------------------------------------------------
  function open(id) {
    const label = window.WebLimits?.get()?.sessionLabel;
    $("shared-session").textContent = label ? `Your session label is ${label}. Search for it to find the results made in this browser.` : "";
    window.A11y.openModal($("shared-modal"), { onClose: () => history.replaceState(null, "", location.pathname + location.search) });
    if (typeof id === "string") showDetail(id);
    else showList();
  }

  // A link like  /#result=design-ab12cd34  opens that result straight away.
  function openFromHash() {
    const m = /^#result=((?:target|design|construct)-[A-Za-z0-9_-]{1,40})$/.exec(location.hash);
    if (m) open(m[1]);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("btn-shared")?.addEventListener("click", () => open());
    $("btn-shared-close")?.addEventListener("click", () => window.A11y.closeModal($("shared-modal")));
    $("shared-kind")?.addEventListener("change", showList);
    $("shared-pdb")?.addEventListener("change", showList);
    $("shared-mine")?.addEventListener("change", showList);
    let timer = null;
    $("shared-q")?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(showList, 300);
    });
    window.addEventListener("hashchange", openFromHash);
    openFromHash();
  });
})();
