(function () {
  function $(id) {
    return document.getElementById(id);
  }
  let cdrAuto = {}; // auto-detected {H1:{start,end,residues}, ...}, kept for the reset button
  let gpuAvailable = null; // null = unknown yet

  // Per-unit durations backing the Phase 5 ETA hint. CPU figures are measured
  // end-to-end on a real (no-GPU) run of this app; GPU figures are typical
  // published benchmarks for these models, not measured here - both are
  // rough guides, not guarantees (actual time depends on target/scaffold size).
  const ETA = {
    rfdiffusionPerBackbone: { gpu: 20, cpu: 610 },
    proteinmpnnPerSequence: { gpu: 1.5, cpu: 1.5 },
    rf2PerSequence: { gpu: 10, cpu: 180 },
  };

  function formatDuration(totalSeconds) {
    if (totalSeconds < 60) return `~${Math.round(totalSeconds)}s`;
    const totalMinutes = totalSeconds / 60;
    if (totalMinutes < 60) return `~${Math.round(totalMinutes)} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = Math.round(totalMinutes % 60);
    return `~${hours}h${minutes ? ` ${minutes}min` : ""}`;
  }

  function updatePipelineEta() {
    const el = $("pipeline-eta-hint");
    if (!el) return;
    const backboneNumber = Number($("slider-backbone-number").value);
    const mpnnDesigns = Number($("slider-mpnn-designs").value);
    const totalSequences = backboneNumber * mpnnDesigns;
    const mode = gpuAvailable ? "gpu" : "cpu";

    const rfdiffusionSec = backboneNumber * ETA.rfdiffusionPerBackbone[mode];
    const proteinmpnnSec = totalSequences * ETA.proteinmpnnPerSequence[mode];
    const rf2Sec = totalSequences * ETA.rf2PerSequence[mode];
    const totalSec = rfdiffusionSec + proteinmpnnSec + rf2Sec;

    const modeLabel =
      gpuAvailable === null
        ? "checking GPU..."
        : gpuAvailable
          ? "GPU"
          : "CPU (GPU not detected)";
    el.textContent = `Phase 5 time estimate: ${formatDuration(totalSec)} (${modeLabel}) - RFdiffusion ${formatDuration(rfdiffusionSec)}, ProteinMPNN ${formatDuration(proteinmpnnSec)}, RF2 ${formatDuration(rf2Sec)}. Rough estimate, depends on target/scaffold size.`;
  }

  function wireSliders() {
    const pairs = [
      ["slider-backbone-number", "val-backbone-number", (v) => v],
      ["slider-mpnn-designs", "val-mpnn-designs", (v) => v],
      ["slider-mpnn-temp", "val-mpnn-temp", (v) => Number(v).toFixed(2)],
    ];
    for (const [sliderId, valId, fmt] of pairs) {
      const slider = $(sliderId);
      slider.addEventListener("input", () => {
        $(valId).textContent = fmt(slider.value);
        updatePipelineEta();
      });
    }
  }

  async function loadScaffold() {
    if (window.AppState.scaffold) return;
    const host = $("scaffold-notice");
    // Without the tools image there is nothing to ask; the tools notice at the
    // top of this step already says what to do.
    if (!window.App.toolsReady) {
      window.Notice.clear(host);
      return;
    }
    const scaffoldName = $("scaffold-select").value;
    try {
      const result = await window.api.getScaffoldSequence({ scaffoldName });
      window.AppState.scaffold = result;
      cdrAuto = JSON.parse(JSON.stringify(result.cdr || {}));
      window.Notice.clear(host);
      renderScaffoldSequence(result);
      renderCdrRanges(result.cdr);
    } catch (e) {
      window.Notice.fromError(host, e, "Couldn't load the scaffold");
      window.ConsolePanel.log(
        "warn",
        `Failed to load scaffold: ${window.Messages.clean(e)}`,
        "design",
      );
    }
  }

  function renderScaffoldSequence(scaffold) {
    const cdrResidues = new Set();
    for (const key of Object.keys(scaffold.cdr || {})) {
      for (const r of scaffold.cdr[key].residues) cdrResidues.add(r);
    }
    let html = "";
    scaffold.sequence.split("").forEach((aa, i) => {
      const resNum = scaffold.residueNumbers[i];
      html += cdrResidues.has(resNum)
        ? `<span class="aa-cdr" title="${resNum}">${aa}</span>`
        : `<span title="${resNum}">${aa}</span>`;
    });
    $("scaffold-sequence").innerHTML = html;
  }

  function range(start, end) {
    const arr = [];
    for (let r = start; r <= end; r++) arr.push(r);
    return arr;
  }

  function renderCdrRanges(cdr) {
    for (const label of ["H1", "H2", "H3"]) {
      const startEl = $(`cdr-${label.toLowerCase()}-start`);
      const endEl = $(`cdr-${label.toLowerCase()}-end`);
      const entry = cdr && cdr[label];
      startEl.value = entry ? entry.start : "";
      endEl.value = entry ? entry.end : "";
      updateCdrEditedMark(label);
    }
  }

  function updateCdrEditedMark(label) {
    const startEl = $(`cdr-${label.toLowerCase()}-start`);
    const endEl = $(`cdr-${label.toLowerCase()}-end`);
    const auto = cdrAuto[label];
    const edited =
      !auto ||
      String(auto.start) !== startEl.value ||
      String(auto.end) !== endEl.value;
    startEl.classList.toggle("cdr-edited", edited);
    endEl.classList.toggle("cdr-edited", edited);
  }

  // User-edited CDR boundaries override the auto-detected ones (from the
  // scaffold's REMARK PDBinfo-LABEL lines) in AppState.scaffold.cdr, which
  // feeds both the sequence highlight and the final candidate scoring step.
  function onCdrRangeEdit(label) {
    const startEl = $(`cdr-${label.toLowerCase()}-start`);
    const endEl = $(`cdr-${label.toLowerCase()}-end`);
    const start = parseInt(startEl.value, 10);
    const end = parseInt(endEl.value, 10);
    if (
      !window.AppState.scaffold ||
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end
    ) {
      updateCdrEditedMark(label);
      return;
    }
    window.AppState.scaffold.cdr = window.AppState.scaffold.cdr || {};
    window.AppState.scaffold.cdr[label] = {
      start,
      end,
      residues: range(start, end),
    };
    updateCdrEditedMark(label);
    renderScaffoldSequence(window.AppState.scaffold);
    window.ConsolePanel.log(
      "info",
      `CDR ${label} range manually changed: ${start}-${end}.`,
      "design",
    );
  }

  function resetCdrRange(label) {
    if (!window.AppState.scaffold) return;
    const auto = cdrAuto[label];
    window.AppState.scaffold.cdr = window.AppState.scaffold.cdr || {};
    if (auto)
      window.AppState.scaffold.cdr[label] = JSON.parse(JSON.stringify(auto));
    else delete window.AppState.scaffold.cdr[label];
    renderCdrRanges(window.AppState.scaffold.cdr);
    renderScaffoldSequence(window.AppState.scaffold);
  }

  function wireCdrRangeEditing() {
    for (const label of ["H1", "H2", "H3"]) {
      $(`cdr-${label.toLowerCase()}-start`).addEventListener("change", () =>
        onCdrRangeEdit(label),
      );
      $(`cdr-${label.toLowerCase()}-end`).addEventListener("change", () =>
        onCdrRangeEdit(label),
      );
    }
    document.querySelectorAll(".btn-reset-cdr").forEach((btn) => {
      btn.addEventListener("click", () => resetCdrRange(btn.dataset.cdr));
    });
  }

  function setBadge(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  const PIPELINE_BADGES = [
    "badge-rfdiffusion",
    "badge-proteinmpnn",
    "badge-rf2-weights",
    "badge-rf2",
  ];
  const PIPELINE_STAGES = ["rfdiffusion", "proteinmpnn", "rf2-weights", "rf2"];
  let pipelineRunning = false;

  function resetPipelineUi() {
    PIPELINE_BADGES.forEach((id) => setBadge(id, "Waiting", "badge-muted"));
    for (const stage of PIPELINE_STAGES) {
      const bar = $(`pg-${stage}`);
      if (bar) {
        bar.style.width = "0%";
        bar.classList.remove("done", "error");
      }
      const status = $(`pg-${stage}-status`);
      if (status) status.textContent = "";
    }
  }

  // Clears the design run without touching the Target tab's work (PDB,
  // hotspots) or the scaffold - those are inputs to a design, not part of it.
  async function cancelDesign() {
    const hasResults =
      pipelineRunning || window.AppState.candidates.length > 0;
    if (
      hasResults &&
      !window.confirm(
        "Start over? This clears the design results and everything after them. Your target and scaffold are kept.",
      )
    )
      return;
    if (pipelineRunning) await window.api.cancelPipeline();
    const s = window.AppState;
    s.scaffoldConfig = null;
    s.backbones = [];
    s.backboneDir = null;
    s.targetTPath = null;
    s.seqDir = null;
    s.rf2OutDir = null;
    s.candidates = [];
    s.selectedCandidateIds = [];
    // Downstream of the candidates, so no longer valid either.
    s.constructCandidateId = null;
    s.constructDna = null;
    s.constructComponents = null;
    s.plasmid = null;
    resetPipelineUi();
    window.Notice.clear($("design-notice"));
    window.TabScreening?.refresh();
    window.TabConstruct?.refreshCandidateOptions?.();
    window.ConsolePanel.log(
      "ok",
      "Started over. Your target and scaffold are kept. Press Run design to try again.",
      "design",
    );
  }

  function buildScaffoldConfig() {
    const cdrLengths = Object.fromEntries(
      ["H1", "H2", "H3"].map((label) => [
        label,
        Number($(`cdr-${label.toLowerCase()}-len`).value),
      ]),
    );
    const invalid = Object.entries(cdrLengths).find(
      ([, length]) => !Number.isInteger(length) || length < 5,
    );
    if (invalid) {
      window.ConsolePanel.log(
        "error",
        `${invalid[0]} loop length must be at least 5 residues.`,
        "design",
      );
      return null;
    }
    const cdrConfig = `H1:${cdrLengths.H1},H2:${cdrLengths.H2},H3:${cdrLengths.H3}`;
    return {
      scaffold_name: $("scaffold-select").value,
      cdr_designed: ["H1", "H2", "H3"],
      cdr_config: cdrConfig,
      backbone_number: Number($("slider-backbone-number").value),
      mpnn_designs: Number($("slider-mpnn-designs").value),
      mpnn_temperature: Number($("slider-mpnn-temp").value),
    };
  }

  async function runPipeline() {
    if (
      !window.AppState.chainAPath ||
      !window.AppState.hotspotResidues.length
    ) {
      window.ConsolePanel.log(
        "error",
        "Pick hotspots on the Target step before running the design.",
        "design",
      );
      return;
    }
    if (!window.AppState.scaffold) {
      window.ConsolePanel.log(
        "error",
        "The scaffold hasn't loaded yet. Check the tools image in Settings.",
        "design",
      );
      return;
    }

    const cfg = buildScaffoldConfig();
    if (!cfg) return;
    window.AppState.scaffoldConfig = cfg;
    // Clear any cancel left over from the previous run. The main process keeps
    // that flag set between stages on purpose, so starting a run is the only
    // thing allowed to reset it.
    await window.api.beginPipeline();
    pipelineRunning = true;
    window.Notice.clear($("design-notice"));
    $("btn-run-pipeline").disabled = true;
    $("btn-stop-pipeline").disabled = false;

    // Badges follow the server's stage-progress events: the four stages now run
    // as one queued job instead of four calls from this page.
    const STAGE_BADGE = {
      rfdiffusion: ["badge-rfdiffusion"],
      proteinmpnn: ["badge-proteinmpnn"],
      "rf2-weights": ["badge-rf2-weights"],
      rf2: ["badge-rf2"],
    };
    const stopStageEvents = window.api.onStageProgress((p) => {
      for (const id of STAGE_BADGE[p.stage] || []) {
        if (p.status === "running") setBadge(id, "Running...", "badge-running");
        else if (p.status === "done") setBadge(id, "Done", "badge-ok");
      }
    });

    try {
      PIPELINE_BADGES.forEach((id) => setBadge(id, "Queued...", "badge-running"));
      const run = await window.api.runDesign(
        {
          targetPdbPath: window.AppState.chainAPath,
          pdbId: window.AppState.pdbId,
          designLoops: cfg.cdr_config,
          hotspotResidues: window.AppState.hotspotResidues,
          numDesigns: cfg.backbone_number,
          designsPerBackbone: cfg.mpnn_designs,
          temperature: cfg.mpnn_temperature,
          numRecycles: 10,
          cdr: window.AppState.scaffold.cdr,
        },
        (job) => {
          // Waiting behind other users' designs on the shared GPU.
          if (job.status === "queued") {
            const where = job.position
              ? `Queued (position ${job.position} of ${job.queueLength})`
              : "Queued...";
            PIPELINE_BADGES.forEach((id) => setBadge(id, where, "badge-running"));
          }
        },
      );
      window.AppState.backbones = run.backbones;
      window.AppState.backboneDir = run.backboneDir;
      window.AppState.targetTPath = run.targetTPath;
      window.AppState.seqDir = run.seqDir;
      window.AppState.rf2OutDir = run.rf2OutDir;
      setBadge(
        "badge-rfdiffusion",
        `Done (${run.backbones.length} backbones)`,
        "badge-ok",
      );
      setBadge("badge-proteinmpnn", "Done", "badge-ok");
      setBadge("badge-rf2-weights", "Done", "badge-ok");
      setBadge("badge-rf2", "Done", "badge-ok");
      window.AppState.candidates = run.candidates || [];
      window.ConsolePanel.log(
        "ok",
        `${window.AppState.candidates.length} candidates ready for screening.`,
        "design",
      );
      if (window.TabScreening) window.TabScreening.refresh();

      // Auto-save so a finished design run survives even if the user
      // forgets to click "Save Project" - reuses the same project id on a
      // second run in this session instead of piling up duplicates.
      try {
        const state = window.StateUtils.serialize();
        const res = await window.api.saveProject(state);
        window.AppState.id = res.id;
        window.ConsolePanel.log(
          "info",
          `Design results auto-saved (project ${res.id}).`,
          "design",
        );
      } catch (e) {
        window.ConsolePanel.log(
          "warn",
          `Auto-save failed: ${window.Messages.clean(e)}`,
          "design",
        );
      }
    } catch (e) {
      const stopped = e.message === "Cancelled by user.";
      window.ConsolePanel.log(
        stopped ? "warn" : "error",
        stopped ? "Run stopped." : `Design failed: ${window.Messages.clean(e)}`,
        "design",
      );
      if (!stopped)
        window.Notice.fromError($("design-notice"), e, "The design run failed");
      PIPELINE_BADGES.forEach((id) => {
        if (/Running|Queued/.test($(id).textContent))
          setBadge(
            id,
            stopped ? "Stopped" : "Failed",
            stopped ? "badge-muted" : "badge-error",
          );
      });
    } finally {
      stopStageEvents();
      pipelineRunning = false;
      $("btn-run-pipeline").disabled = false;
      $("btn-stop-pipeline").disabled = true;
    }
  }

  async function checkGpuWarning() {
    try {
      const status = await window.api.checkGpu();
      gpuAvailable = !!status.cudaAvailable;
      $("gpu-warning-banner").style.display = status.cudaAvailable
        ? "none"
        : "";
    } catch {
      gpuAvailable = false;
      $("gpu-warning-banner").style.display = "";
    }
    updatePipelineEta();
  }

  // Repopulates the Design tab's DOM (scaffold sequence, CDR ranges,
  // sliders, pipeline badges) from window.AppState after a project load -
  // applyLoaded() only replaces the in-memory state, it never touches the
  // DOM itself. Uses the scaffold/config already in AppState rather than
  // calling loadScaffold(), which only fetches a fresh default and bails
  // out early whenever a scaffold is already present.
  function refresh() {
    const scaffold = window.AppState.scaffold;
    if (scaffold) {
      // The true auto-detected ranges aren't in AppState (only the possibly
      // user-edited ones are) - treating the loaded ranges as "auto" means
      // the ↺ reset button resets to what was saved, not to what RFantibody
      // originally detected. Good enough: it's the same gap applyLoaded()
      // already leaves in every other tab-local, non-persisted variable.
      cdrAuto = JSON.parse(JSON.stringify(scaffold.cdr || {}));
      renderScaffoldSequence(scaffold);
      renderCdrRanges(scaffold.cdr);
    }

    const cfg = window.AppState.scaffoldConfig;
    if (cfg) {
      $("scaffold-select").value = cfg.scaffold_name;
      $("slider-backbone-number").value = cfg.backbone_number;
      $("val-backbone-number").textContent = cfg.backbone_number;
      $("slider-mpnn-designs").value = cfg.mpnn_designs;
      $("val-mpnn-designs").textContent = cfg.mpnn_designs;
      $("slider-mpnn-temp").value = cfg.mpnn_temperature;
      $("val-mpnn-temp").textContent = Number(cfg.mpnn_temperature).toFixed(2);
      for (const part of (cfg.cdr_config || "").split(",")) {
        const [label, len] = part.split(":");
        const el = label && $(`cdr-${label.toLowerCase()}-len`);
        if (el) el.value = len;
      }
    }
    updatePipelineEta();

    // A loaded project with candidates already ran its design in a past
    // session - show the pipeline as finished instead of "Waiting", and
    // unlock Screening, rather than making the user re-run it to get there.
    if (window.AppState.candidates?.length) {
      setBadge(
        "badge-rfdiffusion",
        `Done (${(window.AppState.backbones || []).length} backbones)`,
        "badge-ok",
      );
      setBadge("badge-proteinmpnn", "Done", "badge-ok");
      setBadge("badge-rf2-weights", "Done", "badge-ok");
      setBadge("badge-rf2", "Done", "badge-ok");
      $("btn-goto-screening").disabled = false;
    } else {
      resetPipelineUi();
      $("btn-goto-screening").disabled = true;
    }
  }

  window.TabDesign = {
    init() {
      wireSliders();
      wireCdrRangeEditing();
      updatePipelineEta();
      $("btn-run-pipeline").addEventListener("click", runPipeline);
      $("btn-stop-pipeline").addEventListener("click", async () => {
        const res = await window.api.cancelPipeline();
        // Don't disable the button here. Stop pressed between two stages kills
        // nothing, and disabling on that click took away the only control that
        // could stop the stage about to start. The pipeline's own finally
        // block disables it once the run has actually finished.
        if (!pipelineRunning) {
          $("btn-stop-pipeline").disabled = true;
          window.ConsolePanel.log(
            "warn",
            "Nothing is running right now.",
            "design",
          );
        } else {
          window.ConsolePanel.log(
            "warn",
            res.wasRunning
              ? "Stopping the current stage..."
              : "Stop requested. The run will halt before the next stage starts.",
            "design",
          );
        }
      });
      $("btn-cancel-design").addEventListener("click", cancelDesign);
      $("btn-goto-screening").addEventListener("click", () =>
        window.App.switchTab("screening"),
      );
      $("btn-gpu-warning-settings").addEventListener("click", async () => {
        await window.App.openSettingsModal();
        const field = $("set-gpuOverride");
        field.scrollIntoView({ block: "center" });
        field.focus();
      });
    },
    onActivate() {
      loadScaffold();
      checkGpuWarning();
    },
    refresh,
  };
})();
