// Inline notices. Everything is built with textContent (no innerHTML), so error
// text can never inject markup.
(function () {
  const ICONS = {
    info: "info",
    warn: "triangle-alert",
    error: "circle-x",
    ok: "circle-check",
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function runAction(action) {
    if (!action) return;
    if (action.id === "download-tools") {
      window.App?.openSettingsModal?.().then(() => {
        document.getElementById("btn-build-docker")?.focus();
      });
    } else if (typeof action.run === "function") {
      action.run();
    }
  }

  const Notice = {
    clear(host) {
      if (host) host.replaceChildren();
    },

    // tone: info | warn | error | ok
    render(host, { tone = "info", title, body, action } = {}) {
      if (!host) return;
      const box = el("div", `notice notice-${tone}`);
      box.setAttribute("role", tone === "error" ? "alert" : "status");

      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", ICONS[tone] || ICONS.info);
      box.appendChild(icon);

      const text = el("div", "notice-text");
      if (title) text.appendChild(el("strong", "notice-title", title));
      if (body) text.appendChild(el("span", "notice-body", body));
      box.appendChild(text);

      if (action) {
        const btn = el("button", "btn btn-secondary", action.label);
        btn.type = "button";
        btn.addEventListener("click", () => runAction(action));
        box.appendChild(btn);
      }
      host.replaceChildren(box);
      window.Icons?.refresh();
    },

    fromError(host, err, fallbackTitle) {
      const m = window.Messages.explain(err, fallbackTitle);
      Notice.render(host, {
        tone: m.tone,
        title: m.title,
        body: m.body,
        action: m.action,
      });
      return m;
    },
  };

  window.Notice = Notice;
})();
