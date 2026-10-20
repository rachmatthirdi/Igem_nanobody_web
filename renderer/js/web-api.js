// window.api for the web version.
//
// The desktop app exposed this object through Electron's preload script; every
// method was an IPC call into the main process. Here the same methods call the
// server over HTTP, so the rest of the renderer is unchanged.
//
//   - Most calls are POST /api/<channel> and resolve with the result.
//   - The design pipeline is one queued job: runDesign() submits it and polls
//     until it finishes, reporting queue position as it waits.
//   - Live console lines and stage progress arrive on one server-sent-events
//     stream (GET /api/events).
(function () {
  const HEADERS = { "Content-Type": "application/json", "X-NB-Request": "1" };

  async function request(url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch {
      throw new Error("Cannot reach the server. Check your connection and try again.");
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      // Not JSON (e.g. a proxy error page): fall through to the status text.
    }
    if (!res.ok) {
      const err = new Error(data.error || `The server answered ${res.status}.`);
      err.cancelled = !!data.cancelled;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function post(channel, args) {
    const data = await request(`/api/${channel}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ args }),
    });
    return data.result;
  }

  const call = (channel) => (...args) => post(channel, args);
  const unavailable = (what) => async () => {
    throw new Error(`${what} is not available in the web version.`);
  };

  // ---- settings: fixed by the server, only UI flags live in this browser ----
  const FLAG_KEYS = ["onboardingSeen", "tourSeen"];
  function readFlags() {
    const flags = {};
    for (const k of FLAG_KEYS) {
      try {
        flags[k] = localStorage.getItem(`nb.${k}`) === "1";
      } catch {
        flags[k] = false;
      }
    }
    return flags;
  }
  async function getSettings() {
    return {
      installMode: "docker",
      dockerImage: "(managed by the server)",
      gpuOverride: "auto",
      caiOrganism: "Escherichia coli general",
      ...readFlags(),
    };
  }
  async function saveSettings(settings) {
    for (const k of FLAG_KEYS) {
      if (settings && settings[k] === true) {
        try {
          localStorage.setItem(`nb.${k}`, "1");
        } catch {
          // Private mode: the welcome dialog simply shows again next visit.
        }
      }
    }
    return getSettings();
  }

  // ---- event stream ---------------------------------------------------------
  const listeners = { "console-log": new Set(), "stage-progress": new Set(), job: new Set() };
  let source = null;
  function ensureStream() {
    if (source || typeof EventSource === "undefined") return;
    source = new EventSource("/api/events");
    for (const type of Object.keys(listeners)) {
      source.addEventListener(type, (ev) => {
        let payload;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          return;
        }
        for (const cb of listeners[type]) cb(payload);
      });
    }
  }
  function subscribe(type) {
    return (callback) => {
      ensureStream();
      listeners[type].add(callback);
      return () => listeners[type].delete(callback);
    };
  }

  // ---- the design job -----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runDesign(params, onUpdate) {
    const first = await post("run-design", [params]);
    if (onUpdate) onUpdate(first);
    let failures = 0;
    for (;;) {
      await sleep(2000);
      let view;
      try {
        view = (await request(`/api/job/${first.id}`)) ;
        failures = 0;
      } catch (e) {
        // A job outlives a dropped connection; give the network a minute.
        if (e.status === 404) throw new Error("The server no longer knows this job (it may have restarted).");
        if (++failures > 30) throw e;
        continue;
      }
      if (onUpdate) onUpdate(view);
      if (view.status === "done") {
        refreshLimits();
        return view.result;
      }
      if (view.status === "error" || view.status === "cancelled") {
        refreshLimits();
        const err = new Error(view.error || "The design run failed.");
        err.cancelled = view.status === "cancelled";
        throw err;
      }
    }
  }

  // ---- files ----------------------------------------------------------------------
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.addEventListener("change", () => resolve(input.files[0] || null));
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }

  async function importMetricsDialog({ candidates }) {
    const file = await pickFile(".json,.csv,.sc");
    if (!file) return { candidates, imported: false };
    return post("import-metrics-dialog", [{ candidates, fileName: file.name, text: await file.text() }]);
  }

  async function openOutputFolder() {
    const files = await post("open-output-folder", []);
    if (!files.length) throw new Error("No output file yet. Build the plasmid first.");
    const a = document.createElement("a");
    a.href = `/api/download/${encodeURIComponent(files[0].name)}`;
    a.download = files[0].name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  window.api = {
    fetchPdb: call("fetch-pdb"),
    readPdbFile: call("read-pdb-file"),
    getStructureTitle: call("get-structure-title"),
    runInterpro: call("run-interpro"),
    runFreesasa: call("run-freesasa"),
    runDiscotope: call("run-discotope"),

    getScaffoldSequence: call("get-scaffold-sequence"),
    runDesign,
    beginPipeline: call("begin-pipeline"),
    cancelPipeline: call("cancel-pipeline"),

    importMetricsDialog,
    codonOptimize: call("codon-optimize"),
    calculateCai: call("calculate-cai"),

    fetchAnchor: call("fetch-anchor"),
    buildAnchorConstruct: call("build-anchor-construct"),
    buildPlasmid: call("build-plasmid"),
    openOutputFolder,

    getPlatformInfo: call("get-platform-info"),
    checkGpu: call("check-gpu"),
    saveProject: call("save-project"),
    loadProject: call("load-project"),
    listProjects: call("list-projects"),
    deleteProject: call("delete-project"),
    getSettings,
    saveSettings,
    checkDocker: call("check-docker"),
    getDockerStorageInfo: call("get-docker-storage-info"),
    pullDockerImage: unavailable("Downloading the tools image"),
    cancelDockerPull: unavailable("Downloading the tools image"),
    runDockerBuild: unavailable("Building the tools image"),
    testGpuDocker: unavailable("The Docker GPU test"),

    onConsoleLog: subscribe("console-log"),
    onStageProgress: subscribe("stage-progress"),

    getLimits: () => request("/api/limits"),
  };

  // ---- quota ----------------------------------------------------------------------
  // The sliders' upper ends come from the server, which enforces them anyway.
  let limits = null;
  function applyLimits(l) {
    limits = l;
    // Setting max makes the browser clamp the value on the spot, so comparing
    // the value to max afterwards would never see a change. Always tell the
    // page (and fix the label ourselves, in case its listener is not wired yet).
    const set = (id, labelId, max) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.max = String(max);
      const label = document.getElementById(labelId);
      if (label) label.textContent = el.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("slider-backbone-number", "val-backbone-number", Math.max(1, Math.min(l.maxBackbones, l.remaining)));
    set("slider-mpnn-designs", "val-mpnn-designs", l.maxSeqs);
    const badge = document.getElementById("quota-badge");
    if (badge) {
      badge.textContent = `Backbones left: ${l.remaining} / ${l.budget}`;
      badge.className = l.remaining === 0 ? "badge badge-error" : "badge badge-muted";
    }
    const run = document.getElementById("btn-run-pipeline");
    if (run && l.remaining === 0) run.title = "You have used all your backbones.";
  }
  async function refreshLimits() {
    try {
      applyLimits(await request("/api/limits"));
    } catch {
      // Cosmetic only; the server enforces the limits regardless.
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const right = document.querySelector(".header-right");
    if (right && !document.getElementById("quota-badge")) {
      const badge = document.createElement("span");
      badge.id = "quota-badge";
      badge.className = "badge badge-muted";
      badge.textContent = "Backbones left: ...";
      right.prepend(badge);
    }
    refreshLimits();
  });

  window.WebLimits = { refresh: refreshLimits, get: () => limits };
})();
