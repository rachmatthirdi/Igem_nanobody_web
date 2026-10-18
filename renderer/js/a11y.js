// Shared dialog behaviour for the Settings, Projects and Glossary modals:
// focus moves in, Tab stays inside, Esc closes, focus returns on close.
// (The welcome dialog and the tour keep their own handlers in onboarding.js.)
(function () {
  const open = new Map(); // modal element -> { returnFocus, onKey, onClose }

  function focusables(root) {
    return [
      ...root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (el) =>
        !el.disabled && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0,
    );
  }

  function openModal(modal, { initialFocus, onClose } = {}) {
    if (open.has(modal)) return;
    const content = modal.querySelector(".modal-content") || modal;
    const state = { returnFocus: document.activeElement, onClose };

    state.onKey = (e) => {
      // Only the top-most dialog reacts.
      if ([...open.keys()].pop() !== modal) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal(modal);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(content);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!content.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };

    open.set(modal, state);
    modal.classList.remove("hidden");
    document.addEventListener("keydown", state.onKey);
    const target =
      (initialFocus && content.querySelector(initialFocus)) ||
      focusables(content)[0];
    target?.focus();
  }

  function closeModal(modal) {
    const state = open.get(modal);
    modal.classList.add("hidden");
    if (!state) return;
    open.delete(modal);
    document.removeEventListener("keydown", state.onKey);
    state.onClose?.();
    const back = state.returnFocus;
    if (back && document.contains(back)) back.focus();
  }

  window.A11y = { openModal, closeModal };
})();
