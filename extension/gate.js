// Decisions of the bar frame, free of browser APIs so every focus, composition and settings case can
// be unit-tested. The bar wires events and timers to it; a returned permit is the only way to a paid
// search, and the content script accepts each permit number once, for the current text version only.
export const PAUSE_MS = 450;
// A focus that arrives this long after the last grant came from somewhere else (Tab, the page).
export const GRANT_MS = 1500;

export function createGate({ now = () => Date.now() } = {}) {
  const state = {
    // The user is in the bar: opened it, pressed a pointer in it, dropped text on it or used the
    // toolbar action or shortcut, and has not left it since.
    present: false,
    grantAt: -Infinity,
    ready: false,
    value: '',
    // Raised by every trusted change of the field; permits are bound to it.
    version: 0,
    // The current text came from a present user or was approved; only such text is ever sent.
    confirmed: false,
    composing: false,
    // A pause is armed for the current version.
    pending: false,
    permit: 0,
    issuedVersion: -1,
    config: { hasKey: false, excluded: false, unsupported: false },
    // The last settings revision this bar session knows; the first one is only a baseline.
    revision: null,
  };

  function eligible() {
    return state.ready && state.config.hasKey && !state.config.excluded && !state.config.unsupported && Boolean(state.value.trim());
  }

  function issue(cause) {
    state.pending = false;
    if (!eligible()) return null;
    state.permit += 1;
    state.issuedVersion = state.version;
    return { permit: state.permit, version: state.version, cause };
  }

  // A pause is due for confirmed text that has not been searched in this version yet.
  function rearm() {
    state.pending = state.confirmed && !state.composing && eligible() && state.issuedVersion !== state.version;
    return state.pending;
  }

  // Presence ends: an armed pause dies with it, and text not searched yet needs a present approval
  // again, whatever would re-arm the pause later (session ready, settings, the end of a composition).
  function leave() {
    state.present = false;
    state.pending = false;
    if (state.issuedVersion !== state.version) state.confirmed = false;
  }

  return {
    state,
    eligible,
    // The text is in the field but needs an explicit approval before a paid search.
    offersSemantic() { return eligible() && !state.confirmed; },
    grant() { state.present = true; state.grantAt = now(); },
    // Focus alone never makes the user present; focus without a fresh grant ends presence.
    focus() { if (now() - state.grantAt > GRANT_MS) leave(); },
    // Any loss of focus ends presence at once, and a composition with it.
    blur() {
      leave();
      state.composing = false;
    },
    // A trusted change of the field; returns true when a pause has to be (re)armed.
    input(value, composing) {
      const next = String(value);
      state.composing = Boolean(composing);
      // An event that leaves the text as it was is no new content: no new version, no new pause.
      if (next === state.value) return state.pending;
      state.value = next;
      state.version += 1;
      state.confirmed = state.present;
      state.pending = false;
      return rearm();
    },
    compositionStart() { state.composing = true; state.pending = false; },
    // The final text of a composition gets the pause; the Enter that ends it is not an approval.
    compositionEnd() { state.composing = false; return rearm(); },
    pauseElapsed(version) {
      if (!state.pending || version !== state.version) return null;
      return issue('pause');
    },
    // Enter in the field or a click or key on Ponów, Odśwież or Szukaj po znaczeniu.
    approve(cause) {
      if (!state.present) return null;
      state.confirmed = true;
      return issue(cause);
    },
    // Configuration from the content script. A newer revision is one settings change: at most one
    // search, only for confirmed text. Returns { permit } for that change or { arm } for a pause.
    configure(config, revision) {
      state.config = { hasKey: Boolean(config?.hasKey), excluded: Boolean(config?.excluded), unsupported: Boolean(config?.unsupported) };
      if (Number.isInteger(revision)) {
        if (state.revision === null) state.revision = revision;
        else if (revision > state.revision) {
          state.revision = revision;
          state.pending = false;
          // During a composition the change waits: its end arms the pause for the final text instead.
          return { permit: state.confirmed && !state.composing ? issue('settings') : null, arm: false };
        }
      }
      return { permit: null, arm: rearm() };
    },
    // The content script accepted this bar's session.
    ready() { state.ready = true; return rearm(); },
  };
}
