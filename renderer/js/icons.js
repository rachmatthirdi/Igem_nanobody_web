// Thin wrapper around the vanilla `lucide` package (loaded before this file).
// Markup uses <i data-lucide="name"></i>; refresh() swaps those for inline SVG.
(function () {
  function refresh() {
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  // Replace an element's content with an icon plus a text label. The text goes
  // in as a text node, so it is never parsed as markup.
  function setLabel(el, icon, text, { iconAfter = false } = {}) {
    const i = document.createElement("i");
    i.setAttribute("data-lucide", icon);
    const label = document.createTextNode(iconAfter ? `${text} ` : ` ${text}`);
    el.replaceChildren(...(iconAfter ? [label, i] : [i, label]));
    refresh();
  }

  window.Icons = { refresh, setLabel };
})();
