// Turns raw errors (mostly Electron IPC rejections) into short, plain-language
// messages. The raw text still goes to the Live Console for debugging.
(function () {
  // Electron prefixes rejected invoke() calls with this.
  const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/;

  function clean(err) {
    const text = String(err?.message ?? err ?? "");
    return text.replace(IPC_PREFIX, "").trim();
  }

  const TOOLS_ACTION = { label: "Download tools image", id: "download-tools" };

  // First match wins. `short` is a one-line form for tight spots such as
  // progress-bar status text.
  const RULES = [
    {
      test: /design tools aren't installed|image isn't built yet|tools image/i,
      tone: "warn",
      title: "The design tools aren't installed yet",
      body: "This step runs inside the tools image (about 19 GB, downloaded once).",
      short: "Needs the tools image. Download it from Settings.",
      action: TOOLS_ACTION,
    },
    {
      test: /cancell?ed by user/i,
      tone: "info",
      title: "Stopped",
      body: "You stopped this run.",
      short: "Stopped.",
    },
    {
      test: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i,
      tone: "warn",
      title: "Couldn't reach the server",
      body: "Check your internet connection, then try again.",
      short: "No connection. Check your internet and try again.",
    },
  ];

  function explain(err, fallbackTitle) {
    const raw = clean(err);
    const rule = RULES.find((r) => r.test.test(raw));
    if (rule) return { ...rule, raw };
    return {
      tone: "error",
      title: fallbackTitle || "Something went wrong",
      body: raw || "No further details were reported.",
      short: raw || "Something went wrong.",
      raw,
    };
  }

  window.Messages = { explain, clean };
})();
