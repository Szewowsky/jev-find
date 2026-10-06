/* JEV Find bar. It runs in its own extension-origin frame, so the page can neither read nor script it:
 * every trusted input here comes from the user or the system. The gate decides on paid searches; this
 * file only wires events, timers and the authenticated port to the content script that owns the page. */
import { createGate, PAUSE_MS } from './gate.js';

const $ = (selector) => document.querySelector(selector);
const ui = { panel: $('.panel'), input: $('.query'), count: $('.count'), status: $('.status'), glyph: $('.glyph'), frames: $('.frames'), framesN: $('.frames-n'), action: $('.action') };
const ICONS = {
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54"></path><path d="M13 2.8v2.8h-2.8"></path></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"></circle><path d="m10.4 10.4 3.1 3.1"></path></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 14.2 13.4H1.8L8 2.6Z"></path><path d="M8 6.5v3M8 11.4v.1"></path></svg>',
};
const GLYPHS = { literal: '<i class="lit"></i>', semantic: '<i class="sem"></i>', mixed: '<i class="lit"></i><i class="sem"></i>', maybe: '<i class="maybe"></i>', busy: '<i class="spin"></i>', warn: ICONS.warn };

const gate = createGate();
// Opening the bar is the user's own gesture: the toolbar action or the shortcut.
gate.grant();
let port = null;
let ready = false;
let timer = null;
let remoteAction = null;
let focused = false;

function post(message) {
  if (!port) return;
  try { port.postMessage(message); } catch { /* the session is over */ }
}

function reportPresence() { post({ type: 'presence', present: gate.state.present, focused }); }

function disarm() { clearTimeout(timer); timer = null; }
function arm() {
  disarm();
  const version = gate.state.version;
  timer = setTimeout(() => { timer = null; send(gate.pauseElapsed(version)); }, PAUSE_MS);
}
// A settings or session update keeps a running pause; a change of the text always restarts it.
function syncTimer() { if (!gate.state.pending) disarm(); else if (!timer) arm(); }
function restartTimer() { if (gate.state.pending) arm(); else disarm(); }

// One permit, one logical search; the content script drops repeated or outdated permits.
function send(permit) {
  if (permit) post({ type: 'semantic', permit: permit.permit, version: permit.version, cause: permit.cause });
  renderAction();
}

function approve(cause) { disarm(); send(gate.approve(cause)); }

function onInput(event) {
  if (!event.isTrusted) return;
  gate.input(ui.input.value, event.isComposing);
  post({ type: 'query', value: ui.input.value, version: gate.state.version });
  restartTimer();
  renderAction();
  renderQueryState();
}

function onKeyDown(event) {
  if (!event.isTrusted) return;
  if (event.key === 'Escape') { event.preventDefault(); post({ type: 'close' }); return; }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (event.target === ui.input || event.target.dataset?.action) {
      event.preventDefault();
      post({ type: 'nav', step: event.key === 'ArrowDown' ? 1 : -1 });
    }
    return;
  }
  // The Enter that ends an IME composition only ends it.
  if (event.key === 'Enter' && event.target === ui.input && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    approve('enter');
  }
}

function onClick(event) {
  if (!event.isTrusted || !ready) return;
  const button = event.target.closest?.('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'close') post({ type: 'close' });
  else if (action === 'prev') post({ type: 'nav', step: -1 });
  else if (action === 'next') post({ type: 'nav', step: 1 });
  else if (action === 'settings') openSettings();
  else if (action === 'action') onAction(button.dataset.kind);
}

function onAction(kind) {
  if (kind === 'closest') post({ type: 'closest' });
  else if (kind === 'reload') post({ type: 'reload' });
  else if (kind === 'settings') openSettings();
  else if (kind === 'retry' || kind === 'semantic') approve(kind);
  else if (kind === 'refresh') {
    // The page snapshot is rebuilt first; the search for the approved text follows in order on the port.
    post({ type: 'refresh' });
    approve('refresh');
  }
}

// Settings open only for a present user in a live session; a copy of this page never gets one.
function openSettings() {
  if (!ready || !gate.state.present) return;
  try { chrome.runtime.openOptionsPage(); } catch { /* extension reloaded */ }
}

function renderAction() {
  if (remoteAction) return showAction(remoteAction.label, remoteAction.kind, Object.hasOwn(ICONS, remoteAction.icon) ? ICONS[remoteAction.icon] : '');
  if (gate.offersSemantic()) return showAction('Szukaj po znaczeniu', 'semantic', ICONS.search);
  hideAction();
}

// Icons come only from the fixed map above; the label is plain text.
function showAction(label, kind, icon) {
  ui.action.innerHTML = icon;
  ui.action.append(String(label));
  ui.action.dataset.kind = kind;
  ui.action.classList.add('visible');
}

function hideAction() {
  ui.action.classList.remove('visible');
  ui.action.dataset.kind = '';
  ui.action.textContent = '';
}

function renderStatus(status) {
  ui.status.textContent = String(status.text || '');
  ui.status.title = status.detail ? ui.status.textContent + status.detail : ui.status.textContent;
  if (Object.hasOwn(GLYPHS, status.tone)) { ui.glyph.dataset.tone = status.tone; ui.glyph.innerHTML = GLYPHS[status.tone]; }
  else { delete ui.glyph.dataset.tone; ui.glyph.textContent = ''; }
  ui.panel.classList.toggle('busy', status.tone === 'busy');
  for (const name of ['diagnostic', 'errorCode', 'httpStatus']) {
    if (typeof status[name] === 'string') ui.status.dataset[name] = status[name];
    else delete ui.status.dataset[name];
  }
}

// textContent stays "current/total" (tests read it); only the slash gets its own muted span.
function renderCount(count) {
  const total = Math.max(0, Number(count.total) || 0);
  const current = total ? Math.max(0, Number(count.index) || 0) + 1 : 0;
  const slash = document.createElement('i');
  slash.textContent = '/';
  ui.count.replaceChildren(String(current), slash, String(total));
  ui.count.classList.toggle('zero', !total);
  renderQueryState();
}

// Key labels help on an empty bar; once there is a query the status needs the room.
function renderQueryState() {
  const hasQuery = Boolean(ui.input.value.trim());
  ui.count.classList.toggle('idle', !hasQuery);
  ui.panel.classList.toggle('has-query', hasQuery);
}

function renderFrames(count) {
  const label = count ? `Niedostępne ramki: ${count}. Ich tekstu nie da się przeszukać.` : '';
  ui.frames.hidden = !count;
  ui.frames.title = label;
  ui.frames.setAttribute('aria-label', label);
  ui.framesN.textContent = count ? String(count) : '';
}

function render(message) {
  if (message.status) renderStatus(message.status);
  if (message.count) renderCount(message.count);
  if ('frames' in message) renderFrames(Number(message.frames) || 0);
  if ('action' in message) remoteAction = message.action && typeof message.action === 'object' ? message.action : null;
  if (message.config) {
    ui.input.disabled = Boolean(message.config.excluded || message.config.unsupported);
    const result = gate.configure(message.config, message.revision);
    if (result.permit) { disarm(); send(result.permit); return; }
    syncTimer();
  }
  renderAction();
}

function onMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ready') {
    ready = true;
    render(message);
    if (gate.ready()) syncTimer();
    if (ui.input.value) post({ type: 'query', value: ui.input.value, version: gate.state.version });
    reportPresence();
    reportHeight();
    renderAction();
  } else if (message.type === 'render') {
    render(message);
  } else if (message.type === 'grant') {
    // The toolbar action or shortcut on an open bar without presence: the user asked for the bar.
    gate.grant();
    ui.input.focus();
    reportPresence();
  }
}

function reportHeight() {
  const height = Math.ceil(ui.panel.getBoundingClientRect().height);
  if (height > 0) post({ type: 'height', value: height });
}

// The worker hands the session token only to the first document in the frame the content script
// created; a copy of this page or a reloaded document stays inert.
async function connect() {
  let reply;
  try { reply = await chrome.runtime.sendMessage({ type: 'JEV_BAR_HELLO' }); } catch { return; }
  if (!reply || reply.ok !== true || !Number.isInteger(reply.tabId) || typeof reply.documentId !== 'string' || typeof reply.token !== 'string') return;
  const next = chrome.tabs.connect(reply.tabId, { name: 'jev-bar', documentId: reply.documentId });
  next.onMessage.addListener(onMessage);
  next.onDisconnect.addListener(() => { port = null; ready = false; disarm(); });
  port = next;
  post({ type: 'hello', token: reply.token });
}

// A trusted pointer press or drop is the user physically in the bar; the page cannot forge either here.
window.addEventListener('pointerdown', (event) => { if (event.isTrusted) { gate.grant(); reportPresence(); } }, true);
ui.input.addEventListener('drop', (event) => { if (event.isTrusted) { gate.grant(); reportPresence(); } }, true);
window.addEventListener('focus', (event) => {
  if (!event.isTrusted || event.target !== window) return;
  focused = true;
  // A cross-origin frame cannot focus its field before it has focus itself, so the field follows here.
  if (!document.activeElement || document.activeElement === document.body) ui.input.focus();
  // A focus without a fresh grant ends presence, and an armed pause with it.
  gate.focus();
  syncTimer();
  renderAction();
  reportPresence();
});
// Any loss of focus ends presence here and now, whatever took it: the page, a tab, a window, a dialog.
window.addEventListener('blur', (event) => {
  if (!event.isTrusted || event.target !== window) return;
  focused = false;
  gate.blur();
  disarm();
  renderAction();
  reportPresence();
});
ui.input.addEventListener('input', onInput);
ui.input.addEventListener('compositionstart', (event) => { if (event.isTrusted) { gate.compositionStart(); disarm(); } });
// Chromium dispatches compositionend untrusted on some commit paths (measured with a committed candidate).
// Nothing but the browser can dispatch events in this frame, and the end of a composition confirms
// nothing: it only arms the pause for text that trusted input events already confirmed.
ui.input.addEventListener('compositionend', () => { gate.compositionEnd(); restartTimer(); renderAction(); });
document.addEventListener('keydown', onKeyDown);
document.addEventListener('click', onClick);
new ResizeObserver(reportHeight).observe(ui.panel);
ui.input.focus();
connect();
