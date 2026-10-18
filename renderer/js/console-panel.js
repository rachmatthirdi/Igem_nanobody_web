(function () {
  const lines = [];

  let lastEntry = null;
  let lastLine = null;
  let unread = 0;

  function footer() {
    return document.getElementById("console-footer");
  }

  function showUnread() {
    const badge = document.getElementById("console-unread");
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
  }

  function setExpanded(open) {
    footer().classList.toggle("collapsed", !open);
    document
      .getElementById("btn-console-toggle")
      .setAttribute("aria-expanded", String(open));
    if (open) {
      unread = 0;
      showUnread();
    }
  }

  function renderLine(entry) {
    const body = document.getElementById("console-body");
    // The same line repeated back to back gets a counter instead of a new row.
    if (
      lastEntry &&
      lastEntry.level === entry.level &&
      lastEntry.source === entry.source &&
      lastEntry.text === entry.text
    ) {
      lastEntry.count = (lastEntry.count || 1) + 1;
      let count = lastLine.querySelector(".console-count");
      if (!count) {
        count = document.createElement("span");
        count.className = "console-count";
        lastLine.appendChild(count);
      }
      count.textContent = `×${lastEntry.count}`;
      return;
    }
    lastEntry = entry;
    const div = document.createElement("div");
    div.className = `console-line level-${entry.level}`;
    const time = new Date(entry.ts).toLocaleTimeString("id-ID", {
      hour12: false,
    });
    div.innerHTML = `<span class="src">[${time}] [${entry.source || "-"}]</span> ${escapeHtml(entry.text)}`;
    lastLine = div;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;

    // Problems must not hide in a collapsed console: open it on an error and
    // count warnings until it is opened.
    if (footer().classList.contains("collapsed")) {
      if (entry.level === "error") setExpanded(true);
      else if (entry.level === "warn") {
        unread += 1;
        showUnread();
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
    );
  }

  window.ConsolePanel = {
    init() {
      window.api.onConsoleLog((entry) => {
        lines.push(entry);
        renderLine(entry);
      });

      document
        .getElementById("console-header")
        .addEventListener("click", (e) => {
          if (e.target.closest(".console-header-actions")) return;
          setExpanded(footer().classList.contains("collapsed"));
        });

      document
        .getElementById("btn-console-toggle")
        .addEventListener("click", () => {
          setExpanded(footer().classList.contains("collapsed"));
        });

      document
        .getElementById("btn-console-clear")
        .addEventListener("click", () => {
          lines.length = 0;
          lastEntry = null;
          lastLine = null;
          document.getElementById("console-body").innerHTML = "";
        });

      document
        .getElementById("btn-console-export")
        .addEventListener("click", () => {
          const text = lines
            .map(
              (l) =>
                `[${new Date(l.ts).toISOString()}] [${l.level}] [${l.source || "-"}] ${l.text}`,
            )
            .join("\n");
          const blob = new Blob([text], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `console-log-${Date.now()}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        });
    },

    log(level, text, source) {
      const entry = { level, text, source, ts: Date.now() };
      lines.push(entry);
      renderLine(entry);
    },
  };
})();
