(function () {
  function $(id) {
    return document.getElementById(id);
  }

  // ---------------- Tab switching ----------------
  function switchTab(name) {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    document
      .querySelectorAll(".pipeline-steps li")
      .forEach((li) => {
        const active = li.dataset.step === name;
        li.classList.toggle("active", active);
        const btn = li.querySelector(".step-btn");
        if (!btn) return;
        if (active) btn.setAttribute("aria-current", "step");
        else btn.removeAttribute("aria-current");
      });

    if (name === "design" && window.TabDesign?.onActivate)
      window.TabDesign.onActivate();
    if (name === "screening" && window.TabScreening?.refresh)
      window.TabScreening.refresh();
    if (name === "construct" && window.TabConstruct?.onActivate)
      window.TabConstruct.onActivate();
    tick(true);
  }

  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    // The pipeline stepper is the visible navigation; the .tab-btn row above
    // stays in the DOM (hidden by CSS) so both paths share switchTab().
    document.querySelectorAll(".pipeline-steps li").forEach((li) => {
      li.addEventListener("click", () => switchTab(li.dataset.step));
    });
  }

  // ---------------- Stage progress -> progress bars / badges ----------------
  function wireProgress() {
    window.api.onStageProgress(({ stage, percent, status, message }) => {
      const bar = $(`pg-${stage}`);
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.classList.toggle("done", status === "done");
        bar.classList.toggle("error", status === "error");
      }
      const pct = $(`pg-${stage}-pct`);
      if (pct) pct.textContent = `${percent}%`;
      const statusEl = $(`pg-${stage}-status`);
      if (statusEl) statusEl.textContent = message || "";
    });
  }

  // ---------------- OS / WSL detection ----------------
  async function refreshPlatformInfo() {
    try {
      const info = await window.api.getPlatformInfo();
      $("mon-detected-os").textContent = info.label;
    } catch (e) {
      $("mon-detected-os").textContent = "error";
    }
  }

  // ---------------- GPU badge + GPU/OS status (shown in Settings) ----------------
  async function refreshGpuStatus() {
    try {
      const status = await window.api.checkGpu();
      const badge = $("gpu-badge");
      if (status.cudaAvailable) {
        window.Icons.setLabel(badge, "cpu", `GPU: ${status.gpuName || "detected"}`);
        badge.className = "badge badge-ok";
        badge.title = "";
      } else {
        window.Icons.setLabel(badge, "cpu", "GPU: not detected");
        badge.className = "badge badge-error";
        badge.title =
          "Have an NVIDIA GPU? Install nvidia-container-toolkit and " +
          "restart Docker, or click to force it on in Settings.";
      }
      $("mon-gpu").textContent = status.cudaAvailable
        ? status.gpuName || "Yes"
        : "Not detected";
      $("mon-vram").textContent = status.vramTotalGb
        ? `${status.vramTotalGb} GB`
        : "-";
    } catch (e) {
      window.Icons.setLabel($("gpu-badge"), "cpu", "GPU: error");
    }
  }

  async function refreshMonitorSettings() {
    refreshDockerStorageMonitor();
    refreshInstallBanner();
  }

  // Shown in Settings > Docker tools regardless of install status (unlike the
  // install banner, which hides itself once installMode === "docker") - this
  // is the one place in the UI to always check where the ~19GB image actually
  // lives, since that's Docker's own managed storage, not this app's folder.
  // (The image name itself is the "Docker image" field in the same dialog.)
  async function refreshDockerStorageMonitor() {
    const info = await window.api.getDockerStorageInfo();
    const storageEl = $("mon-docker-storage");
    storageEl.textContent = info.dockerRootDir || "not detected";
    storageEl.title = info.dockerRootDir || "Docker not running or not found";
  }

  // ---------------- Install banner (Docker tools image) ----------------
  let installBannerDismissed = false;

  async function refreshInstallBanner() {
    const settings = await window.api.getSettings();
    App.toolsReady = settings.installMode === "docker";
    if (App.toolsReady) {
      $("install-banner").style.display = "none";
      tick(true);
      return;
    }

    const docker = await window.api.checkDocker();
    App.dockerAvailable = !!docker.available;
    tick(true);
    if (installBannerDismissed) return;

    $("install-banner").style.display = "";
    $("install-no-docker").style.display = docker.available ? "none" : "";
    $("install-ready").style.display = docker.available ? "" : "none";
    if (!docker.available) return;

    const info = await window.api.getDockerStorageInfo();
    $("install-storage-path").textContent =
      info.dockerRootDir || "unknown (docker info failed)";
    $("install-image-name").textContent = info.dockerImage;
  }

  function dismissInstallBanner() {
    installBannerDismissed = true;
    $("install-banner").style.display = "none";
  }

  function wireInstallBanner() {
    $("btn-install-dismiss-nodocker").addEventListener(
      "click",
      dismissInstallBanner,
    );
    $("btn-install-dismiss").addEventListener("click", dismissInstallBanner);

    $("btn-install-download").addEventListener("click", async () => {
      const dlBtn = $("btn-install-download");
      const cancelBtn = $("btn-install-cancel");
      dlBtn.disabled = true;
      cancelBtn.disabled = false;
      window.ConsolePanel.log(
        "info",
        "Downloading the pre-built tools image from Docker Hub.",
        "install",
      );
      try {
        await window.api.pullDockerImage();
        window.ConsolePanel.log("ok", "Tools image downloaded.", "install");
        refreshMonitorSettings();
      } catch (e) {
        const cancelled = e.message === "Cancelled by user.";
        window.ConsolePanel.log(
          cancelled ? "warn" : "error",
          cancelled
            ? "Download cancelled."
            : `Tools image download failed: ${window.Messages.clean(e)}`,
          "install",
        );
      } finally {
        dlBtn.disabled = false;
        cancelBtn.disabled = true;
      }
    });

    $("btn-install-cancel").addEventListener("click", async () => {
      $("btn-install-cancel").disabled = true;
      await window.api.cancelDockerPull();
    });

    $("btn-install-build-source").addEventListener("click", async () => {
      const btn = $("btn-install-build-source");
      btn.disabled = true;
      window.ConsolePanel.log(
        "info",
        "Building the tools image from source (this can take 20-30 min).",
        "install",
      );
      try {
        await window.api.runDockerBuild();
        window.ConsolePanel.log(
          "ok",
          "Tools image build complete.",
          "install",
        );
        refreshMonitorSettings();
      } catch (e) {
        window.ConsolePanel.log(
          "error",
          `Tools image build failed: ${window.Messages.clean(e)}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------- Settings modal ----------------
  async function openSettingsModal() {
    const s = await window.api.getSettings();
    $("set-dockerImage").value = s.dockerImage;
    $("set-gpuOverride").value = s.gpuOverride;
    window.A11y.openModal($("settings-modal"));
  }

  function wireSettingsModal() {
    $("btn-settings").addEventListener("click", openSettingsModal);
    $("gpu-badge").addEventListener("click", async () => {
      await openSettingsModal();
      const field = $("set-gpuOverride");
      field.scrollIntoView({ block: "center" });
      field.focus();
    });
    $("btn-settings-close").addEventListener("click", () =>
      window.A11y.closeModal($("settings-modal")),
    );
    $("btn-test-gpu").addEventListener("click", async () => {
      const btn = $("btn-test-gpu");
      const status = $("gpu-test-status");
      btn.disabled = true;
      status.textContent = "Testing...";
      status.className = "";
      try {
        const res = await window.api.testGpuDocker();
        if (res.success) {
          const name = res.message.match(/^\|\s+\d+\s+(.+?)\s{2,}/m)?.[1];
          window.Icons.setLabel(status, "circle-check", `Docker can reach your GPU${name ? `: ${name}` : ""}.`);
          status.className = "status-pass";
          window.ConsolePanel.log(
            "ok",
            `GPU access verified via Docker.\n${res.message}`,
            "gpu-check",
          );
        } else {
          window.Icons.setLabel(
            status,
            "circle-x",
            "Docker cannot reach a GPU (see Live Console).",
          );
          status.className = "status-fail";
          window.ConsolePanel.log(
            "error",
            `Docker GPU test failed: ${res.message}`,
            "gpu-check",
          );
        }
      } finally {
        btn.disabled = false;
      }
    });
    $("btn-build-docker").addEventListener("click", async () => {
      const btn = $("btn-build-docker");
      const status = $("docker-build-status");
      btn.disabled = true;
      status.textContent = "Downloading... see Live Console for progress.";
      window.ConsolePanel.log(
        "info",
        "Downloading the pre-built tools image from Docker Hub.",
        "install",
      );
      try {
        await window.api.pullDockerImage();
        window.Icons.setLabel(status, "circle-check", "Tools image ready.");
        window.ConsolePanel.log("ok", "Tools image downloaded.", "install");
        refreshMonitorSettings();
      } catch (e) {
        window.Icons.setLabel(status, "circle-x", "Download failed.");
        window.ConsolePanel.log(
          "error",
          `Tools image download failed: ${window.Messages.clean(e)}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
    $("btn-build-docker-source").addEventListener("click", async () => {
      const btn = $("btn-build-docker-source");
      const status = $("docker-build-status");
      btn.disabled = true;
      status.textContent = "Building... see Live Console for progress.";
      window.ConsolePanel.log(
        "info",
        "Building the tools image from source (this can take 20-30 min).",
        "install",
      );
      try {
        await window.api.runDockerBuild();
        window.Icons.setLabel(status, "circle-check", "Build complete.");
        window.ConsolePanel.log(
          "ok",
          "Tools image build complete.",
          "install",
        );
        refreshMonitorSettings();
      } catch (e) {
        window.Icons.setLabel(status, "circle-x", "Build failed.");
        window.ConsolePanel.log(
          "error",
          `Tools image build failed: ${window.Messages.clean(e)}`,
          "install",
        );
      } finally {
        btn.disabled = false;
      }
    });
    $("btn-settings-save").addEventListener("click", async () => {
      const settings = {
        dockerImage: $("set-dockerImage").value,
        gpuOverride: $("set-gpuOverride").value,
      };
      await window.api.saveSettings(settings);
      window.A11y.closeModal($("settings-modal"));
      refreshMonitorSettings();
      refreshGpuStatus();
      window.ConsolePanel.log("ok", "Settings saved.", "settings");
    });
  }

  // ---------------- Save / load project ----------------
  function wireProjectButtons() {
    $("btn-save-project").addEventListener("click", async () => {
      const state = window.StateUtils.serialize();
      const res = await window.api.saveProject(state);
      window.AppState.id = res.id;
      window.ConsolePanel.log("ok", `Project saved: ${res.id}`, "project");
    });

    $("btn-load-project").addEventListener("click", async () => {
      const list = await window.api.listProjects();
      const container = $("projects-list");
      container.replaceChildren();
      if (!list.length) {
        const empty = document.createElement("p");
        empty.className = "section-hint";
        empty.textContent =
          "No saved projects yet. Use the save button in the header to keep your work.";
        container.appendChild(empty);
      }
      for (const p of list) {
        const row = document.createElement("div");
        row.className = "project-item";
        const label = document.createElement("span");
        label.textContent = p.name;
        if (p.savedAt) {
          const when = document.createElement("span");
          when.className = "project-when";
          when.textContent = ` (${new Date(p.savedAt).toLocaleString("en-US")})`;
          label.appendChild(when);
        }
        const open = document.createElement("button");
        open.type = "button";
        open.className = "btn btn-secondary";
        open.textContent = "Open";
        open.addEventListener("click", async () => {
          const data = await window.api.loadProject(p.id);
          window.StateUtils.applyLoaded(data);
          window.A11y.closeModal($("projects-modal"));
          // applyLoaded() only replaces window.AppState - each tab must be
          // told to redraw itself from it, or it keeps showing whatever was
          // on screen before the load.
          await window.TabTarget?.refresh();
          window.TabDesign?.refresh();
          window.TabScreening?.refresh();
          window.TabConstruct?.refresh?.();
          tick(true);
          window.ConsolePanel.log(
            "ok",
            `Project "${p.name}" opened.`,
            "project",
          );
        });
        row.append(label, open);
        container.appendChild(row);
      }
      window.A11y.openModal($("projects-modal"));
    });

    $("btn-projects-close").addEventListener("click", () =>
      window.A11y.closeModal($("projects-modal")),
    );
  }

  // ---------------- Tools notices + button gates ----------------
  let lastSignature = "";
  let lastToolsKey = null;

  function refreshToolsNotices() {
    document.querySelectorAll("[data-tools-notice]").forEach((host) => {
      const state = App.toolsReady
        ? "ready"
        : App.dockerAvailable === false
          ? "no-docker"
          : "missing";
      if (host.dataset.state === state) return;
      host.dataset.state = state;
      if (state === "ready") {
        window.Notice.clear(host);
      } else if (state === "no-docker") {
        window.Notice.render(host, {
          tone: "warn",
          title: "Docker isn't running",
          body: "The design tools run inside Docker. Install or start Docker, then reopen this app.",
        });
      } else {
        window.Notice.render(host, {
          tone: "warn",
          title: "The design tools aren't installed yet",
          body: "This step needs them. The tools image is a one-time download of about 19 GB.",
          action: { label: "Download tools image", id: "download-tools" },
        });
      }
    });
  }

  // Cheap enough to run on a timer: it only touches the DOM when something it
  // shows has changed.
  function tick(force) {
    const s = window.AppState;
    const sig = JSON.stringify([
      s.hotspotResidues.length,
      !!s.scaffold,
      s.candidates.length,
      s.candidates.filter((c) => c.dna).length,
      s.selectedCandidateIds.length,
      !!s.anchor,
      !!s.constructDna,
      App.toolsReady,
      App.dockerAvailable,
    ]);
    if (!force && sig === lastSignature) return;
    lastSignature = sig;
    window.Gates.refresh();
    const key = `${App.toolsReady}|${App.dockerAvailable}`;
    if (key !== lastToolsKey) {
      const justReady =
        !!lastToolsKey && lastToolsKey.startsWith("false") && App.toolsReady;
      lastToolsKey = key;
      refreshToolsNotices();
      // Tools finished installing while Design is open: load the scaffold now.
      if (justReady && $("tab-design").classList.contains("active"))
        window.TabDesign?.onActivate?.();
    }
  }

  // ---------------- Bootstrap ----------------
  const App = {
    switchTab,
    openSettingsModal,
    tick,
    toolsReady: false,
    dockerAvailable: null,
  };
  window.App = App;

  document.addEventListener("DOMContentLoaded", () => {
    window.Icons.refresh();
    window.ConsolePanel.init();
    wireTabs();
    wireProgress();
    wireSettingsModal();
    wireProjectButtons();
    wireInstallBanner();

    window.TabTarget.init();
    window.TabDesign.init();
    window.TabScreening.init();
    window.TabConstruct.init();
    window.Glossary.init();

    refreshGpuStatus();
    refreshMonitorSettings();
    refreshPlatformInfo();
    refreshInstallBanner();
    tick(true);
    setInterval(() => tick(false), 600);
  });
})();
