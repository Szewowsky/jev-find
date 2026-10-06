/* JEV Find content surface. Deliberately dependency-free: the page is the data source. The bar lives in
 * an extension-origin frame; this script owns the page side (snapshot, literal search, highlights,
 * scrolling) and talks to the bar only over an extension port authenticated with a session token. */
(function () {
  'use strict';

  var KEY = '__JEV_FIND__';
  var old = window[KEY];
  // The toolbar action or shortcut on an open bar: close it when the user is in it, otherwise bring the
  // user back into it.
  if (old && typeof old.toggle === 'function') {
    old.toggle();
    return;
  }

  var state = {
    closed: false,
    stale: false,
    query: '',
    // Internal generation: any reset makes older answers void.
    version: 0,
    // The bar's text version and the last permit used; a permit counts once, for the current text only.
    uiVersion: -1,
    lastPermit: 0,
    requestId: null,
    observer: null,
    hostObserver: null,
    runtimeListener: null,
    connectListener: null,
    snapshot: null,
    items: [],
    index: -1,
    config: { hasKey: false, excluded: false },
    revision: null,
    host: null,
    frame: null,
    fallback: null,
    port: null,
    token: null,
    bootTimer: null,
    barPresent: true,
    // What the bar shows; sent in full when the session starts and in parts afterwards.
    view: { status: { text: '', tone: '', detail: '' }, count: { index: -1, total: 0 }, action: null, frames: 0 },
    styles: [],
    contexts: [],
    pendingPossible: [],
    escapeWindows: [],
    localScrollTimer: null,
    verifyTimer: null,
    highlights: [],
    close: close,
    toggle: toggle
  };
  window[KEY] = state;

  var CHANGED_STATUS = 'Treść strony się zmieniła';
  var EMPTY_STATUS = 'Wpisz słowo albo opisz, czego szukasz';
  var LITERAL_STILL_WORKS = '. Dosłowne działają.';

  // The frame carries elevation and the focus ring, so the panel's shadow is never clipped by the iframe.
  var HOST_CSS = [
    ':host{all:initial;display:block}',
    '.ui-frame{display:block;width:100%;height:94px;border:0;border-radius:12px;background:transparent;overflow:hidden;color-scheme:light dark;box-shadow:0 18px 44px -14px rgba(28,22,48,.24),0 3px 10px rgba(28,22,48,.07);animation:jf-in .14s ease-out}',
    '.ui-frame.focused{box-shadow:0 0 0 3px rgba(124,58,237,.17),0 18px 44px -14px rgba(28,22,48,.24),0 3px 10px rgba(28,22,48,.07)}',
    '@media (prefers-color-scheme:dark){.ui-frame{box-shadow:0 24px 54px -14px rgba(0,0,0,.6),0 4px 14px rgba(0,0,0,.32)}.ui-frame.focused{box-shadow:0 0 0 3px rgba(139,92,246,.26),0 24px 54px -14px rgba(0,0,0,.6),0 4px 14px rgba(0,0,0,.32)}}',
    '@keyframes jf-in{from{opacity:0;transform:translateY(-4px)}}@media (prefers-reduced-motion:reduce){.ui-frame{animation:none}}',
    '.fallback{position:fixed;inset:0;pointer-events:none}.fallback i{position:fixed;display:block;border-radius:2px}',
    '.fallback i.lit{background:rgba(251,146,60,.45);box-shadow:0 0 0 1px rgba(234,88,12,.35)}.fallback i.sem{background:rgba(124,58,237,.3);box-shadow:0 0 0 1px rgba(93,49,168,.25)}'
  ].join('');

  function semanticCountLabel(n) {
    var mod10 = n % 10, mod100 = n % 100;
    return n + ' ' + (n === 1 || (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? 'semantyczne' : 'semantycznych');
  }

  function safeSend(message) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return Promise.resolve(connectionError());
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(function (error) {
        return connectionError(error);
      });
    } catch (error) {
      return Promise.resolve(connectionError(error));
    }
  }

  function connectionError() { return { ok: false, kind: 'connection', code: 'extension-context', error: 'Połączenie z rozszerzeniem przerwane.' }; }

  function randomMark() {
    var bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  // The frame sits in a closed shadow root, so it is not in the page's frame list and the page gets no
  // handle to it. The boundary is its extension origin plus the session: the worker finds this exact
  // frame by a mark that exists only in the extension's isolated world and hands the token to it alone.
  function makeUi() {
    var host = document.createElement('div');
    host.dataset.jevFind = 'true';
    host.style.cssText = 'position:fixed;top:16px;right:16px;width:min(440px,calc(100vw - 32px));z-index:2147483647;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + HOST_CSS + '</style>';
    var frame = document.createElement('iframe');
    frame.className = 'ui-frame';
    frame.title = 'JEV Find';
    frame.setAttribute('aria-label', 'JEV Find');
    shadow.appendChild(frame);
    var fallback = document.createElement('div');
    fallback.className = 'fallback';
    fallback.setAttribute('aria-hidden', 'true');
    shadow.appendChild(fallback);
    document.documentElement.appendChild(host);
    state.host = host;
    state.frame = frame;
    state.fallback = fallback;
    var mark = randomMark();
    try { frame.contentWindow.__JEV_BAR_MARK__ = mark; } catch (_) {}
    addEscapeListener(window);
    window.addEventListener('scroll', positionFallback, true);
    window.addEventListener('resize', positionFallback);
    // A removed host ends the session; a moved one reloads the frame, which closes the port.
    state.hostObserver = new MutationObserver(function () { if (!host.isConnected) close(); });
    state.hostObserver.observe(document.documentElement, { childList: true });
    frame.addEventListener('load', function () { if (!state.closed && frame.getAttribute('src')) focusBar(); });
    safeSend({ type: 'JEV_BAR_BIND', mark: mark }).then(function (reply) {
      if (state.closed) return;
      if (!reply || reply.ok !== true || typeof reply.token !== 'string') { close(); return; }
      state.token = reply.token;
      frame.src = chrome.runtime.getURL('bar.html');
      state.bootTimer = setTimeout(function () { if (!state.port) close(); }, 5000);
    });
  }

  // Exactly one port with the session token becomes the bar; any other port is dropped.
  function onConnect(port) {
    if (!port || port.name !== 'jev-bar') return;
    if (state.closed || state.port || !state.token) { try { port.disconnect(); } catch (_) {} return; }
    var expected = state.token;
    var timer = setTimeout(function () { try { port.disconnect(); } catch (_) {} }, 3000);
    var first = function (message) {
      port.onMessage.removeListener(first);
      clearTimeout(timer);
      if (state.closed || state.port || state.token !== expected || !message || message.type !== 'hello' || message.token !== expected) { try { port.disconnect(); } catch (_) {} return; }
      state.token = null;
      state.port = port;
      clearTimeout(state.bootTimer);
      port.onMessage.addListener(onBarMessage);
      port.onDisconnect.addListener(function () { if (state.port === port) { state.port = null; close(); } });
      post({ type: 'ready', status: state.view.status, count: state.view.count, action: state.view.action, frames: state.view.frames, config: configView(), revision: state.revision });
    };
    port.onMessage.addListener(first);
    port.onDisconnect.addListener(function () { clearTimeout(timer); });
  }

  function onBarMessage(message) {
    if (state.closed || !message || typeof message !== 'object') return;
    var type = message.type;
    if (type === 'query') {
      if (typeof message.value !== 'string' || !Number.isInteger(message.version) || message.version <= state.uiVersion) return;
      state.uiVersion = message.version;
      onQuery(message.value);
    } else if (type === 'semantic') {
      // One permit, one logical search, only for the text version the bar issued it for.
      if (!Number.isInteger(message.permit) || message.permit <= state.lastPermit || message.version !== state.uiVersion) return;
      state.lastPermit = message.permit;
      runSemantic(state.query.trim());
    } else if (type === 'nav') navigate(message.step === -1 ? -1 : 1);
    else if (type === 'closest') selectClosest();
    else if (type === 'refresh') refreshSnapshot();
    else if (type === 'reload') window.location.reload();
    else if (type === 'close') close();
    else if (type === 'height') {
      var height = Number(message.value);
      if (height > 0 && height < 1000) state.frame.style.height = Math.ceil(height) + 'px';
    } else if (type === 'presence') {
      state.barPresent = Boolean(message.present);
      state.frame.classList.toggle('focused', Boolean(message.focused));
    }
  }

  function barFocused() { return document.hasFocus() && document.activeElement === state.host; }

  // Focusing a frame that already has focus blurs and refocuses it, which the bar rightly reads as a
  // loss of presence; so the frame is focused from here only when it does not have focus.
  function focusBar() {
    if (barFocused()) return;
    try { state.frame.focus(); } catch (_) {}
  }

  function toggle() {
    if (state.closed) return;
    if (!state.port) { close(); return; }
    if (state.barPresent && barFocused()) { close(); return; }
    focusBar();
    post({ type: 'grant' });
  }

  function post(message) {
    if (!state.port) return;
    try { state.port.postMessage(message); } catch (_) {}
  }

  function render(partial) { post(Object.assign({ type: 'render' }, partial)); }

  function configView() {
    return { hasKey: state.config.hasKey, excluded: state.config.excluded, unsupported: Boolean(state.snapshot && state.snapshot.unsupported) };
  }

  function onGlobalKeyDown(event) {
    if (state.closed || !event.isTrusted || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function navigate(step) {
    cancelLocalScroll();
    flushVerify();
    selectIndex(state.index + step, true);
  }

  function addEscapeListener(win) {
    if (!win || state.escapeWindows.indexOf(win) >= 0) return;
    try { win.addEventListener('keydown', onGlobalKeyDown, true); state.escapeWindows.push(win); } catch (_) {}
  }

  function installContextEscapeListeners() {
    addEscapeListener(window);
    state.contexts.forEach(function (context) { addEscapeListener(context.win); });
  }

  // The bar sent its text: literal results now, a paid search only on a separate permit.
  function onQuery(value) {
    if (state.closed) return;
    state.query = value;
    state.version += 1;
    cancelRequest();
    cancelLocalScroll();
    cancelVerify();
    hideAction();
    clearHighlights();
    state.items = [];
    state.index = -1;
    state.pendingPossible = [];
    updateCount();
    var query = state.query.trim();
    if (!query) {
      setStatus(EMPTY_STATUS);
      return;
    }
    // A new query always searches the page as it is now, not as it was when the bar opened.
    if (state.stale || !state.snapshot) rebaseSnapshot();
    if (state.snapshot.unsupported) {
      setStatus('Ta strona nie udostępnia tekstu do wyszukiwania');
      return;
    }
    if (!state.snapshot.chunks.length) {
      setStatus('Na tej stronie nie ma tekstu do wyszukania');
      return;
    }
    renderItems(findLiteral(query), [], [], true);
  }

  function runSemantic(query) {
    if (state.closed || !query || !state.config.hasKey || state.config.excluded) return;
    if (state.stale) rebaseSnapshot();
    if (!state.snapshot || state.snapshot.unsupported || !state.snapshot.chunks.length) return;
    cancelRequest();
    var version = state.version;
    var snapshot = state.snapshot;
    var requestId = 'jev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    state.requestId = requestId;
    setStatus('Szukam po znaczeniu…', 'busy');
    var blocks = snapshot.chunks.map(function (chunk) { return { id: chunk.id, text: chunk.text }; });
    safeSend({ type: 'JEV_SEARCH', requestId: requestId, query: query, blocks: blocks }).then(function (response) {
      if (state.closed || version !== state.version || requestId !== state.requestId) return;
      state.requestId = null;
      flushVerify();
      if (!response || !response.ok) {
        var kind = errorKind(response);
        var diagnostic = errorDiagnostic(response);
        if (kind === 'cancelled') return;
        // The visible line stays short; HTTP status and error code live in the tooltip and data attributes.
        if (kind === 'auth') {
          setStatus('Nieprawidłowy klucz TypeSafe', 'warn', diagnostic);
          showAction('Ustawienia', 'settings', '');
        } else if (kind === 'missing-key') {
          setStatus('Dodaj klucz TypeSafe w ustawieniach', 'warn', diagnostic);
          showAction('Ustawienia', 'settings', '');
        } else if (kind === 'budget') {
          budgetStatus(response, diagnostic);
        } else if (kind === 'limit') {
          setStatus('Przekroczony limit' + LITERAL_STILL_WORKS, 'warn', diagnostic);
          showAction('Ponów', 'retry', 'refresh');
        } else if (kind === 'invalid' || kind === 'invalid-request') {
          setStatus((kind === 'invalid' ? 'Błąd odpowiedzi' : 'Błąd żądania') + LITERAL_STILL_WORKS, 'warn', diagnostic);
          showAction('Ponów', 'retry', 'refresh');
        } else if (kind === 'settings') {
          setStatus('Błąd ustawień' + LITERAL_STILL_WORKS, 'warn', diagnostic);
          showAction('Ponów', 'retry', 'refresh');
        } else if (kind === 'domain') {
          setStatus('Ta strona jest wykluczona w ustawieniach');
          hideAction();
        } else if (kind === 'connection') {
          setStatus('Rozszerzenie przeładowane. Odśwież stronę.', 'warn');
          showAction('Odśwież stronę', 'reload', 'refresh');
        } else {
          setStatus('TypeSafe niedostępny' + LITERAL_STILL_WORKS, 'warn', diagnostic);
          showAction('Ponów', 'retry', 'refresh');
        }
        attachDiagnostic(response);
        return;
      }
      var good = Array.isArray(response.results) ? response.results : [];
      var possible = Array.isArray(response.possible) ? response.possible : [];
      if (state.stale) rebaseSnapshot();
      var literal = findLiteral(query);
      // IDs belong to the snapshot that was sent; renderItems keeps only fragments whose text is still on the page.
      renderItems(literal, good, possible, false, snapshot);
    });
  }

  // The worker refused or stopped before a request: the page is too long, the search used its budget,
  // the tab used its budget or the budget store failed. Literal results stay.
  function budgetStatus(response, diagnostic) {
    var code = response && response.code;
    if (code === 'budget-page') {
      setStatus('Strona za długa na wyszukiwanie po znaczeniu' + LITERAL_STILL_WORKS, 'warn', diagnostic);
      hideAction();
    } else if (code === 'budget-tab') {
      var minutes = Math.max(1, Math.ceil((Number(response.retryAfterMs) || 60000) / 60000));
      setStatus('Limit wyszukiwań na tej karcie. Spróbuj za ' + minutes + ' min.', 'warn', diagnostic);
      hideAction();
    } else {
      setStatus((code === 'budget-storage' ? 'Błąd licznika wyszukiwań' : 'Wyczerpano budżet wyszukiwania') + LITERAL_STILL_WORKS, 'warn', diagnostic);
      showAction('Ponów', 'retry', 'refresh');
    }
  }

  function errorKind(response) {
    var explicit = response && (response.kind || response.errorKind);
    if (['auth', 'missing-key', 'limit', 'budget', 'service', 'invalid', 'invalid-request', 'settings', 'domain', 'cancelled', 'connection'].indexOf(explicit) >= 0) return explicit;
    var message = String(response && response.error || '').toLocaleLowerCase();
    if (/dodaj klucz|brak klucza/.test(message)) return 'missing-key';
    if (/401|403|klucz|autoryz|uwierzyteln/.test(message)) return 'auth';
    if (/nieprawidłow|invalid|odpowiedzi|json/.test(message)) return 'invalid';
    if (/limit|budżet|budget|413|429|529|rozmiar|bytes/.test(message)) return 'limit';
    return 'service';
  }

  function errorDiagnostic(response) {
    var status = response && Number(response.status);
    var code = response && response.code;
    var labels = { 'response-contract': ' (format odpowiedzi)', request: ' (żądanie)', settings: ' (ustawienia)', domain: ' (domena)' };
    var label = labels[code] || '';
    if (Number.isInteger(status) && status >= 100 && status <= 599) return label ? label.slice(0, -1) + '; HTTP ' + status + ')' : ' (HTTP ' + status + ')';
    return label;
  }

  function attachDiagnostic(response) {
    var status = response && Number(response.status);
    var view = Object.assign({}, state.view.status);
    try {
      view.diagnostic = JSON.stringify(response && response.diagnostic || {});
      view.errorCode = response && typeof response.code === 'string' ? response.code : '';
      view.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : '';
    } catch (_) {
      view.diagnostic = '{}'; view.errorCode = ''; view.httpStatus = '';
    }
    state.view.status = view;
    render({ status: view });
  }

  function renderItems(literal, good, possible, immediate, source) {
    source = source || state.snapshot;
    hideAction();
    var previousRange = entryRange(state.items[state.index]);
    var hadPreviousSelection = Boolean(previousRange);
    var cache = new WeakMap();
    var changed = 0;
    var entries = literal.map(function (match) { return { type: 'literal', match: match }; });
    var seen = entries.map(function (entry) { return entry.match.range; });
    function resultEntry(result, type) {
      var chunk = source && source.byId.get(String(result.id));
      if (!chunk) return null;
      // A fragment edited while the request was in flight is stale; unchanged fragments stay valid.
      if (!charsIntact(chunk.chars, cache)) { if (type === 'semantic') changed += 1; return null; }
      var range = chunkRange(chunk, 0, chunk.text.length);
      if (!range || seen.some(function (existing) { return rangesOverlap(existing, range); })) return null;
      seen.push(range);
      return { type: type, score: Number(result.score) || 0, range: range, chunk: chunk, chars: chunk.chars };
    }
    function byScore(a, b) { return (Number(b.score) || 0) - (Number(a.score) || 0); }
    good.slice().sort(byScore).forEach(function (result) {
      var entry = resultEntry(result, 'semantic');
      if (entry) entries.push(entry);
    });
    var pending = [];
    possible.slice().sort(byScore).forEach(function (result) {
      var entry = resultEntry(result, 'possible');
      if (entry) pending.push(entry);
    });
    var semanticCount = entries.length - literal.length;
    state.items = entries;
    state.pendingPossible = pending;
    if (state.snapshot) state.snapshot.possible = pending;
    var preservedIndex = previousRange ? entries.findIndex(function (entry) { return sameRange(entryRange(entry), previousRange); }) : -1;
    state.index = preservedIndex >= 0 ? preservedIndex : (entries.length ? 0 : -1);
    clearHighlights();
    drawHighlights(entries, []);
    updateCount();
    if (!entries.length && pending.length) {
      setStatus('Brak pewnego dopasowania', 'maybe');
      showAction('Pokaż najbliższe', 'closest', '');
    } else if (!entries.length && changed) {
      setStatus(CHANGED_STATUS, 'warn');
      showAction('Odśwież', 'refresh', 'refresh');
    } else if (!entries.length) {
      setStatus('Nie znaleziono dopasowania');
    } else {
      // The dots in front of the status are the colour legend for the highlights on the page.
      if (!literal.length) setStatus('Najlepsze dopasowanie', 'semantic');
      else if (semanticCount) setStatus('Dosłowne trafienia + ' + semanticCountLabel(semanticCount), 'mixed');
      else setStatus('Dosłowne trafienia', 'literal');
      if (immediate) {
        selectIndex(state.index < 0 ? 0 : state.index, false);
        scheduleLocalScroll();
      }
      else if (!hadPreviousSelection && literal.length === 0) selectIndex(0, true);
      else if (state.index >= 0) selectIndex(state.index, false);
    }
    if (changed && entries.length) {
      setStatus(CHANGED_STATUS, 'warn');
      showAction('Odśwież', 'refresh', 'refresh');
    } else if (pending.length && entries.length) showAction('Najbliższe', 'closest', '');
  }

  function selectClosest() {
    flushVerify();
    while (state.pendingPossible.length) {
      var entry = state.pendingPossible.shift();
      if (!entry || state.items.some(function (shown) { return rangesOverlap(entryRange(shown), entry.range); })) continue;
    state.items.push(entry);
    drawHighlights(state.items, []);
      selectIndex(state.items.length - 1, true);
      if (state.pendingPossible.length) showAction('Pokaż następny', 'closest', '');
      else hideAction();
      setStatus('Najbliższy fragment, wynik niepewny', 'maybe');
      return;
    }
    hideAction();
  }

  function cancelLocalScroll() {
    clearTimeout(state.localScrollTimer);
    state.localScrollTimer = null;
  }

  function scheduleLocalScroll() {
    cancelLocalScroll();
    if (!state.query.trim() || !state.items.length) return;
    state.localScrollTimer = setTimeout(function () {
      state.localScrollTimer = null;
      flushVerify();
      if (state.closed || !state.items.length) return;
      var range = entryRange(state.items[state.index]);
      if (range && state.items[state.index].type !== 'possible') scrollRange(range);
    }, 450);
  }

  function findLiteral(query) {
    if (!state.snapshot) return [];
    var needle = normalizeText(query).text;
    if (!needle) return [];
    var found = [];
    state.snapshot.blocks.forEach(function (block) {
      var normalized = normalizeText(block.text);
      var text = normalized.text;
      var from = 0;
      while (from <= text.length - needle.length) {
        var at = text.indexOf(needle, from);
        if (at < 0) break;
        var first = normalized.map[at];
        var last = normalized.map[at + needle.length - 1];
        var range = first && last ? chunkRange(block, first.from, last.to) : null;
        if (range) found.push({ range: range, block: block, chars: block.chars.slice(first.from, last.to) });
        from = at + Math.max(1, needle.length);
      }
    });
    return found;
  }

  function drawHighlights(entries, possible) {
    if (!state.snapshot) return;
    var literal = [], semantic = [], possibleRanges = [];
    entries.forEach(function (entry) {
      if (entry.type === 'literal') literal.push(entry.match.range);
      else if (entry.type === 'possible') possibleRanges.push(entry.range);
      else semantic.push(entry.range);
    });
    possible.forEach(function (result) {
      var chunk = state.snapshot.byId.get(String(result.id));
      if (chunk) { var range = chunkRange(chunk, 0, chunk.text.length); if (range) possibleRanges.push(range); }
    });
    var canHighlight = state.contexts.length > 0;
    state.contexts.forEach(function (context) {
      if (!context.win.CSS || !context.win.CSS.highlights || !context.win.Highlight) { canHighlight = false; return; }
      var addForContext = function (ranges) { return ranges.filter(function (range) { return range.startContainer.ownerDocument === context.doc; }); };
      if (!setNativeHighlight(context, 'jev-find-literal', addForContext(literal))) canHighlight = false;
      if (!setNativeHighlight(context, 'jev-find-semantic', addForContext(semantic))) canHighlight = false;
      if (!setNativeHighlight(context, 'jev-find-possible', addForContext(possibleRanges))) canHighlight = false;
    });
    state.native = canHighlight;
    if (!canHighlight) positionFallback();
  }

  function setNativeHighlight(context, name, ranges) {
    var highlights = context.win.CSS.highlights;
    try {
      highlights.delete(name);
      if (ranges.length) {
        var h = new context.win.Highlight();
        ranges.forEach(function (range) { h.add(range); });
        highlights.set(name, h);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearHighlights() {
    state.contexts.forEach(function (context) {
      if (context.win.CSS && context.win.CSS.highlights) ['jev-find-literal', 'jev-find-semantic', 'jev-find-possible', 'jev-find-active', 'jev-find-active-semantic'].forEach(function (name) { try { context.win.CSS.highlights.delete(name); } catch (_) {} });
    });
    state.fallback.replaceChildren();
  }

  function entryRange(entry) {
    return entry && (entry.range || entry.match && entry.match.range) || null;
  }

  function contextForRange(range) {
    return range ? contextForNode(range.startContainer) : null;
  }

  function contextForNode(node) {
    var root = node.getRootNode ? node.getRootNode() : node.ownerDocument;
    for (var i = 0; i < state.contexts.length; i += 1) {
      var context = state.contexts[i];
      if (context.root === root || (context.root.nodeType === 1 && context.root.contains(node))) return context;
    }
    return null;
  }

  function clearActiveHighlights() {
    state.contexts.forEach(function (context) {
      if (context.win.CSS && context.win.CSS.highlights) {
        try { context.win.CSS.highlights.delete('jev-find-active'); context.win.CSS.highlights.delete('jev-find-active-semantic'); } catch (_) {}
      }
    });
  }

  function selectIndex(index, shouldScroll) {
    if (!state.items.length) { updateCount(); return; }
    index = (index + state.items.length) % state.items.length;
    state.index = index;
    var entry = state.items[index];
    var range = entryRange(entry);
    clearActiveHighlights();
    state.contexts.forEach(function (context) {
      if (!context.win.CSS || !context.win.CSS.highlights || !context.win.Highlight) return;
      if (range && range.startContainer.ownerDocument === context.doc) {
        try {
          // jev-find-active always marks the current hit (orange); a semantic or possible hit gets
          // a violet layer with higher priority on top of the same range.
          var active = new context.win.Highlight(range);
          active.priority = 1;
          context.win.CSS.highlights.set('jev-find-active', active);
          if (entry.type !== 'literal') {
            var semantic = new context.win.Highlight(range);
            semantic.priority = 2;
            context.win.CSS.highlights.set('jev-find-active-semantic', semantic);
          }
        } catch (_) {}
      }
    });
    positionFallback();
    updateCount();
    if (shouldScroll && range && entry.type !== 'possible') scrollRange(range);
  }

  function scrollRange(range) {
    var target = range.startContainer && range.startContainer.parentElement;
    if (target && target.scrollIntoView) {
      try { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (_) { try { target.scrollIntoView(); } catch (__) {} }
    }
    var context = contextForRange(range);
    while (context && context.owner) {
      try { context.owner.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (_) { try { context.owner.scrollIntoView(); } catch (__) {} }
      context = context.parent;
    }
  }

  function updateCount() {
    state.view.count = { index: state.index, total: state.items.length };
    render({ count: state.view.count });
  }

  // tone: literal | semantic | mixed | maybe | busy | warn, or nothing for a neutral line.
  function setStatus(text, tone, detail) {
    state.view.status = { text: text, tone: tone || '', detail: detail || '' };
    render({ status: state.view.status });
  }

  function updateFrames() {
    state.view.frames = state.snapshot ? state.snapshot.inaccessible : 0;
    render({ frames: state.view.frames });
  }

  // icon names one of the bar's fixed icons; the bar renders the label as plain text.
  function showAction(label, kind, icon) { state.view.action = { label: label, kind: kind, icon: icon || '' }; render({ action: state.view.action }); }
  function hideAction() { state.view.action = null; render({ action: null }); }

  function normalizeText(value) {
    var tokens = [], lastSpace = false, offset = 0;
    for (const char of String(value)) {
      var end = offset + char.length;
      if (/\s/u.test(char)) {
        if (!lastSpace && tokens.length) tokens.push({ raw: ' ', from: offset, to: end });
        lastSpace = true;
      } else {
        tokens.push({ raw: char, from: offset, to: end });
        lastSpace = false;
      }
      offset = end;
    }
    var raw = tokens.map(function (token) { return token.raw; }).join('');
    var text = foldCase(raw), map = [], foldedOffset = 0;
    tokens.forEach(function (token) {
      var folded = foldCase(token.raw);
      for (var i = 0; i < folded.length; i += 1) map[foldedOffset + i] = { from: token.from, to: token.to };
      foldedOffset += folded.length;
    });
    return { text: text, map: map };
  }

  function foldCase(value) { return String(value).toLocaleLowerCase().replace(/\u0307/g, ''); }

  function sameRange(a, b) {
    if (!a || !b || rangeRoot(a) !== rangeRoot(b)) return false;
    try {
      return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
    } catch (_) {
      return rangeKey(a) === rangeKey(b);
    }
  }

  function rangeKey(range) {
    if (!range) return '';
    return [nodeKey(range.startContainer), range.startOffset, nodeKey(range.endContainer), range.endOffset].join(':');
  }
  function nodeKey(node) { return node && node.__jevKey || ''; }
  function rangeRoot(range) {
    var node = range && range.startContainer;
    return node && (node.getRootNode ? node.getRootNode() : node.ownerDocument);
  }
  function rangesOverlap(a, b) {
    if (!a || !b || rangeRoot(a) !== rangeRoot(b)) return false;
    try {
      return a.compareBoundaryPoints(Range.START_TO_END, b) > 0 && b.compareBoundaryPoints(Range.START_TO_END, a) > 0;
    } catch (_) { return rangeKey(a) === rangeKey(b); }
  }

  function chunkRange(chunk, from, to) {
    if (!chunk || !chunk.chars || !chunk.chars.length || to <= from) return null;
    from = Math.max(0, Math.min(from, chunk.chars.length - 1));
    to = Math.max(from + 1, Math.min(to, chunk.chars.length));
    var first = chunk.chars[from], last = chunk.chars[to - 1];
    try { var range = chunk.doc.createRange(); range.setStart(first.startNode, first.startOffset); range.setEnd(last.endNode, last.endOffset); return range; } catch (_) { return null; }
  }

  function positionFallback() {
    if (!state.fallback || state.native) return;
    state.fallback.replaceChildren();
    var entry = state.items[state.index];
    var range = entryRange(entry);
    if (!range) return;
    var context = contextForRange(range);
    var tone = entry.type === 'literal' ? 'lit' : 'sem';
    try { Array.from(range.getClientRects()).forEach(function (rect) {
      var translated = translateRect(rect, context);
      var box = document.createElement('i');
      box.className = tone;
      box.style.left = translated.left + 'px'; box.style.top = translated.top + 'px'; box.style.width = translated.width + 'px'; box.style.height = translated.height + 'px';
      state.fallback.appendChild(box);
    }); } catch (_) {}
  }

  function translateRect(rect, context) {
    var left = rect.left, top = rect.top;
    while (context && context.owner) {
      var frame = context.owner;
      var frameRect = frame.getBoundingClientRect();
      left += frameRect.left + (frame.clientLeft || 0);
      top += frameRect.top + (frame.clientTop || 0);
      context = context.parent;
    }
    return { left: left, top: top, width: rect.width, height: rect.height };
  }

  function isOwn(node) {
    if (!node) return false;
    if (state.host && (node === state.host || state.host.contains(node))) return true;
    return state.styles.some(function (style) { return node === style || (style.contains && style.contains(node)); });
  }

  function isVisible(node, cache) {
    if (!node || node.nodeType !== 1) return true;
    if (cache.has(node)) return cache.get(node);
    var visible = !node.hidden && node.getAttribute('aria-hidden') !== 'true' && !node.inert;
    if (visible) { try { var style = node.ownerDocument.defaultView.getComputedStyle(node); visible = style.display !== 'none' && style.visibility !== 'hidden' && style.contentVisibility !== 'hidden'; } catch (_) {} }
    cache.set(node, visible);
    return visible;
  }

  function excludedTextNode(node, cache, context) {
    if (!context.visible) return true;
    var parent = node.parentElement;
    while (parent) {
      if (isOwn(parent) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'VIDEO', 'AUDIO', 'CANVAS', 'PROGRESS', 'METER'].indexOf(parent.tagName) >= 0 || parent.getAttribute('role') === 'progressbar' || !isVisible(parent, cache)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function blockFor(node, root) {
    var current = node.parentElement;
    while (current && current !== root) {
      var tag = current.tagName;
      if (/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/.test(tag)) return current;
      try {
        if (/^(block|flow-root|list-item|table|table-row|table-cell|flex|grid)$/i.test(current.ownerDocument.defaultView.getComputedStyle(current).display)) return current;
      } catch (_) {}
      current = current.parentElement;
    }
    return root.nodeType === 9 ? root.body : root;
  }

  function collectContexts() {
    var contexts = [], inaccessible = 0, visited = new Set(), visibilityCache = new WeakMap();
    function add(doc, root, owner, parent) {
      if (!doc || !root || visited.has(root)) return;
      var visible = (!parent || parent.visible) && (!owner || isVisible(owner, visibilityCache));
      if (!visible) return;
      visited.add(root); contexts.push({ doc: doc, root: root, win: doc.defaultView || window, owner: owner || null, parent: parent || null, visible: true });
    }
    add(document, document.body || document.documentElement, null, null);
    for (var cursor = 0; cursor < contexts.length; cursor += 1) {
      var context = contexts[cursor];
      var elements = context.root.querySelectorAll ? Array.from(context.root.querySelectorAll('*')) : [];
      elements.forEach(function (element) {
        if (isOwn(element)) return;
        if (element.shadowRoot) add(context.doc, element.shadowRoot, element, context);
        if (!/^(IFRAME|FRAME)$/.test(element.tagName)) return;
        if (!isVisible(element, visibilityCache)) return;
        try { if (element.contentDocument && element.contentDocument.body) add(element.contentDocument, element.contentDocument.body, element, context); else inaccessible += 1; } catch (_) { inaccessible += 1; }
      });
    }
    return { contexts: contexts, inaccessible: inaccessible, visibilityCache: visibilityCache };
  }

  function extractSnapshot() {
    var collected = collectContexts();
    var blocks = [], nodeNumber = 0;
    var blockStates = new Map();
    function addNode(node, root, context) {
      if (node.nodeType !== 3 || !node.data || excludedTextNode(node, context.cache, context)) return;
      var blockElement = blockFor(node, root);
      var blockState = blockStates.get(blockElement);
      if (!blockState || (blockState.breakPending && blockState.block.text)) {
        blockState = { block: { id: 'b' + blocks.length.toString(36), doc: context.doc, root: root, chars: [], text: '' }, breakPending: false };
        blockStates.set(blockElement, blockState); blocks.push(blockState.block);
      }
      blockState.breakPending = false;
      var block = blockState.block;
      node.__jevKey = node.__jevKey || 'n' + (++nodeNumber);
      var lastSpace = block.text.endsWith(' ');
      for (var i = 0; i < node.data.length; i += 1) {
        var char = node.data[i];
        if (/\s/.test(char)) {
          if (lastSpace || !block.text) continue;
          block.text += ' '; block.chars.push({ char: ' ', startNode: node, startOffset: i, endNode: node, endOffset: i + 1 }); lastSpace = true;
        } else {
          block.text += char; block.chars.push({ char: char, startNode: node, startOffset: i, endNode: node, endOffset: i + 1 }); lastSpace = false;
        }
      }
    }
    function addBreak(node, root, context) {
      var blockElement = blockFor(node, root);
      var blockState = blockStates.get(blockElement);
      if (blockState && blockState.block.text && context.visible) blockState.breakPending = true;
    }
    collected.contexts.forEach(function (context) {
      context.cache = collected.visibilityCache;
      var walker = context.doc.createTreeWalker(context.root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 1 && node.tagName === 'BR') addBreak(node, context.root, context);
        else if (node.nodeType === 3) addNode(node, context.root, context);
      }
    });
    blocks = blocks.filter(function (block) { return block.text.trim(); });
    var chunks = [], byId = new Map();
    blocks.forEach(function (block) {
      var max = 6000, overlap = 240, start = 0, part = 0;
      while (start < block.text.length) {
        var end = Math.min(block.text.length, start + max);
        var chunk = { id: block.id + '-' + part.toString(36), text: block.text.slice(start, end), chars: block.chars.slice(start, end), doc: block.doc };
        chunks.push(chunk); byId.set(chunk.id, chunk); part += 1;
        if (end >= block.text.length) break;
        start = end - overlap;
      }
    });
    return { blocks: blocks, chunks: chunks, byId: byId, contexts: collected.contexts, inaccessible: collected.inaccessible, unsupported: !/^https?:$/i.test(location.protocol) || document.contentType === 'application/pdf' };
  }

  function refreshSnapshot(opening) {
    if (state.closed) return;
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    cancelLocalScroll();
    cancelVerify();
    clearHighlights();
    takeSnapshot();
    installContextEscapeListeners();
    installHighlightStyles();
    state.version += 1;
    cancelRequest();
    state.items = []; state.index = -1; state.pendingPossible = []; updateCount();
    render({ config: configView() });
    if (state.snapshot.unsupported) setStatus('Ta strona nie udostępnia tekstu do wyszukiwania');
    else if (!state.snapshot.chunks.length) setStatus('Na tej stronie nie ma tekstu do wyszukania');
    else setStatus(opening ? EMPTY_STATUS : 'Strona odświeżona');
    hideAction();
    if (state.query.trim()) onQuery(state.query);
    if (!state.closed) startObserver();
  }

  function takeSnapshot() {
    state.snapshot = extractSnapshot();
    state.stale = false;
    state.contexts = state.snapshot.contexts;
    updateFrames();
  }

  // Follows page changes for the next search without touching results on screen;
  // verifyResults alone decides which of those still match the page.
  function rebaseSnapshot() {
    var previous = state.contexts;
    takeSnapshot();
    var sameSurfaces = previous.length === state.contexts.length && previous.every(function (context, index) { return context.root === state.contexts[index].root; });
    if (sameSurfaces) return;
    installContextEscapeListeners();
    installHighlightStyles();
    startObserver();
    if (state.items.length) {
      drawHighlights(state.items, []);
      if (state.index >= 0) selectIndex(state.index, false);
    }
  }

  function installHighlightStyles() {
    state.styles.forEach(function (style) { try { style.remove(); } catch (_) {} }); state.styles = [];
    state.contexts.forEach(function (context) {
      try {
        var style = context.doc.createElement('style');
        style.dataset.jevFindStyle = 'true';
        // Yellow = literal, violet = semantic; the current hit is solid: orange for literal, violet for semantic.
        style.textContent = '::highlight(jev-find-literal){background-color:rgba(250,204,21,.45);color:inherit}::highlight(jev-find-semantic){background-color:rgba(139,92,246,.24);color:inherit}::highlight(jev-find-possible){background-color:rgba(139,92,246,.14);color:inherit;text-decoration:underline dotted #7C3AED}::highlight(jev-find-active){background-color:#FB923C;color:#1F1200}::highlight(jev-find-active-semantic){background-color:#7C3AED;color:#FFFFFF}';
        if (context.root.nodeType === 11) context.root.appendChild(style);
        else (context.doc.head || context.doc.documentElement).appendChild(style);
        state.styles.push(style);
      } catch (_) {}
    });
  }

  function cancelVerify() {
    clearTimeout(state.verifyTimer);
    state.verifyTimer = null;
  }

  function scheduleVerify() {
    if (!state.verifyTimer) state.verifyTimer = setTimeout(function () { state.verifyTimer = null; verifyResults(); }, 150);
  }

  function flushVerify() {
    if (!state.verifyTimer) return;
    cancelVerify();
    verifyResults();
  }

  // Pages rewrite progress bars, buttons and menus while scrolling. Such mutations never wipe the
  // result list: only hits whose own text changed, vanished or became hidden are dropped.
  function verifyResults() {
    if (state.closed || (!state.items.length && !state.pendingPossible.length)) return;
    var cache = new WeakMap();
    var intact = function (entry) { return charsIntact(entry.chars || entry.match && entry.match.chars, cache); };
    var hadPossible = state.pendingPossible.length > 0;
    state.pendingPossible = state.pendingPossible.filter(intact);
    if (state.snapshot) state.snapshot.possible = state.pendingPossible;
    if (hadPossible && !state.pendingPossible.length && state.view.action && state.view.action.kind === 'closest') hideAction();
    var kept = state.items.filter(intact);
    if (kept.length === state.items.length) return;
    var removedBefore = state.items.slice(0, Math.max(state.index, 0)).filter(function (entry) { return kept.indexOf(entry) < 0; }).length;
    var index = kept.indexOf(state.items[state.index]);
    if (index < 0) index = Math.min(Math.max(state.index - removedBefore, 0), kept.length - 1);
    state.items = kept;
    state.index = kept.length ? index : -1;
    clearHighlights();
    drawHighlights(kept, []);
    if (kept.length) selectIndex(state.index, false); else updateCount();
    setStatus(CHANGED_STATUS, 'warn');
    showAction('Odśwież', 'refresh', 'refresh');
  }

  function charsIntact(chars, cache) {
    if (!chars || !chars.length) return false;
    var included = new Map();
    for (var i = 0; i < chars.length; i += 1) {
      var item = chars[i], node = item.startNode;
      if (!included.has(node)) included.set(node, textNodeIncluded(node, cache));
      if (!included.get(node)) return false;
      var actual = node.data.charAt(item.startOffset);
      if (item.char === ' ' ? !/\s/.test(actual) : actual !== item.char) return false;
    }
    return true;
  }

  function textNodeIncluded(node, cache) {
    if (!node || node.nodeType !== 3 || !node.isConnected) return false;
    var context = contextForNode(node);
    if (!context) return false;
    for (var current = context; current; current = current.parent) {
      if (current.owner && (!current.owner.isConnected || !isVisible(current.owner, cache))) return false;
    }
    return !excludedTextNode(node, cache, context);
  }

  function clearResultState() {
    clearHighlights();
    state.items = [];
    state.index = -1;
    state.pendingPossible = [];
    if (state.snapshot) state.snapshot.possible = [];
    updateCount();
  }

  function mutationIsOwn(mutation) {
    if (isOwn(mutation.target)) return true;
    var touched = Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes));
    return touched.length > 0 && touched.every(isOwn);
  }

  // Cheap on purpose: some pages mutate on every scroll frame, so extraction waits for the next search.
  function onMutations(mutations) {
    if (state.closed || !mutations.some(function (mutation) { return !mutationIsOwn(mutation); })) return;
    state.stale = true;
    scheduleVerify();
  }

  function startObserver() {
    if (state.observer) { onMutations(state.observer.takeRecords()); state.observer.disconnect(); }
    state.observer = new MutationObserver(onMutations);
    var options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'contenteditable'] };
    state.contexts.forEach(function (context) { try { state.observer.observe(context.root, options); } catch (_) {} });
  }

  function cancelRequest() {
    if (!state.requestId) return;
    var requestId = state.requestId; state.requestId = null;
    safeSend({ type: 'JEV_CANCEL', requestId: requestId });
  }

  function close() {
    if (state.closed) return;
    state.closed = true; state.version += 1; cancelRequest(); cancelLocalScroll(); cancelVerify();
    clearTimeout(state.bootTimer);
    if (state.observer) state.observer.disconnect();
    if (state.hostObserver) state.hostObserver.disconnect();
    try {
      if (state.runtimeListener) chrome.runtime.onMessage.removeListener(state.runtimeListener);
      if (state.connectListener) chrome.runtime.onConnect.removeListener(state.connectListener);
    } catch (_) {}
    var port = state.port;
    state.port = null;
    state.token = null;
    if (port) { try { port.disconnect(); } catch (_) {} }
    clearHighlights(); state.styles.forEach(function (style) { try { style.remove(); } catch (_) {} });
    state.escapeWindows.forEach(function (win) { try { win.removeEventListener('keydown', onGlobalKeyDown, true); } catch (_) {} });
    state.escapeWindows = [];
    window.removeEventListener('scroll', positionFallback, true); window.removeEventListener('resize', positionFallback);
    if (state.host) state.host.remove();
    try { delete window[KEY]; } catch (_) { window[KEY] = null; }
  }

  function setConfig(config) {
    if (!config || state.closed) return;
    if (config.ok === false) {
      if (errorKind(config) === 'connection') {
        setStatus('Rozszerzenie przeładowane. Odśwież stronę.', 'warn');
        showAction('Odśwież stronę', 'reload', 'refresh');
      }
      return;
    }
    var revision = Number.isInteger(config.revision) ? config.revision : null;
    // Only a newer revision is a settings change; a repeated broadcast or a late first answer is not.
    if (revision !== null && state.revision !== null && revision <= state.revision) return;
    var baseline = state.revision === null;
    var next = { hasKey: !!config.hasKey, excluded: !!config.excluded };
    var changed = next.hasKey !== state.config.hasKey || next.excluded !== state.config.excluded;
    if (revision !== null) state.revision = revision;
    state.config = next;
    var renew = changed || !baseline;
    if (renew) {
      state.version += 1;
      cancelRequest();
      cancelLocalScroll();
      clearResultState();
    }
    var unsupported = state.snapshot && state.snapshot.unsupported;
    if (next.excluded) { setStatus('Ta domena jest wykluczona w ustawieniach'); hideAction(); }
    else if (unsupported) { setStatus('Ta strona nie udostępnia tekstu do wyszukiwania'); hideAction(); }
    else if (state.snapshot && !state.snapshot.chunks.length) { setStatus('Na tej stronie nie ma tekstu do wyszukania'); hideAction(); }
    else {
      // Literal results follow at once; whether the change also searches by meaning is the bar's decision.
      if (renew && state.query.trim()) onQuery(state.query);
      if (!next.hasKey) { setStatus('Bez klucza działa tylko szukanie dosłowne'); showAction('Dodaj klucz', 'settings', ''); }
    }
    render({ config: configView(), revision: state.revision });
  }

  function boot() {
    state.connectListener = onConnect;
    if (chrome.runtime && chrome.runtime.onConnect) chrome.runtime.onConnect.addListener(onConnect);
    makeUi();
    refreshSnapshot(true);
    state.runtimeListener = function (message) { if (message && message.type === 'JEV_CONFIG_UPDATED') setConfig(message); };
    if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(state.runtimeListener);
    safeSend({ type: 'JEV_CONFIG' }).then(setConfig);
    startObserver();
  }

  boot();
})();
