import { buildInitialRequests, buildShortlistBatches, buildShortlistRequest, isExcluded, normalizeDomain, parseInitialResponse, parseShortlistResponse, validateBlocks, validateQuery } from './core.js';
import { createBudget } from './budget.js';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_MS = 250;
// Messages accepted only from the content script in the top frame of an http(s) tab.
const CONTENT_MESSAGES = new Set(['JEV_CONFIG', 'JEV_SEARCH', 'JEV_CANCEL', 'JEV_BAR_BIND']);
const BAR_URL = chrome.runtime.getURL('bar.html');
const MARK_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const ERROR_TEXT = Object.freeze({
  auth: 'Klucz TypeSafe jest nieprawidłowy.',
  'missing-key': 'Dodaj klucz TypeSafe w ustawieniach.',
  limit: 'TypeSafe odrzucił żądanie z powodu limitu.',
  service: 'TypeSafe jest chwilowo niedostępny. Spróbuj ponownie.',
  invalid: 'TypeSafe zwrócił nieprawidłową odpowiedź.',
  'invalid-request': 'Żądanie TypeSafe jest nieprawidłowe.',
  settings: 'Nie udało się odczytać bezpiecznych ustawień.',
  domain: 'Ta strona jest wykluczona albo nie udostępnia tekstu.',
  cancelled: 'Wyszukiwanie anulowane.',
  budget: 'Wyczerpany budżet zapytań JEV Find.',
});
const CONTRACT_REASONS = new Set(['invalid JEV response: answers missing', 'choice probabilities missing', 'choice probabilities have invalid IDs', 'choice probabilities out of range', 'invalid JEV choice answer', 'invalid JEV Noul answer', 'JEV answers have missing or foreign IDs']);
const active = new Map();
const generations = new Map();
const knownTabs = new Map();
// tabId -> the one bar frame the content script created there, its page document and session token.
const bars = new Map();
const ready = Promise.resolve().then(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
const budget = createBudget({ storage: chrome.storage.session });

// Runs tasks one after another, so a read-modify-write of shared state is never interleaved by await.
function serialized() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

// Settings changes get an ordered revision kept in session storage: a woken worker never goes back,
// so an open bar can tell a new change from a repeated or late message.
const configQueue = serialized();
let configRevision = null;
async function loadRevision() {
  if (configRevision === null) {
    const stored = await chrome.storage.session.get({ configRevision: 0 });
    configRevision = Number.isInteger(stored?.configRevision) && stored.configRevision >= 0 ? stored.configRevision : 0;
  }
  return configRevision;
}
function readRevision() { return configQueue(loadRevision); }
function bumpRevision() {
  return configQueue(async () => {
    await loadRevision();
    configRevision += 1;
    await chrome.storage.session.set({ configRevision });
    return configRevision;
  });
}

function safeRequestId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : ''; }
function errorCode(kind) { return { auth: 'http', 'missing-key': 'settings', limit: 'http', service: 'http', invalid: 'response-contract', 'invalid-request': 'request', settings: 'settings', domain: 'domain', cancelled: 'cancelled' }[kind] || 'internal'; }
function typedError(kind, status, code = errorCode(kind)) { const error = new Error(ERROR_TEXT[kind] || ERROR_TEXT.service); error.kind = kind; error.code = code; if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status; return error; }
function cancelledError() { const error = typedError('cancelled'); error.name = 'AbortError'; return error; }
function contractDiagnostic(response, error, allowedIds = []) {
  const answers = response && typeof response === 'object' && !Array.isArray(response) && response.answers && typeof response.answers === 'object' && !Array.isArray(response.answers) ? response.answers : null;
  const choice = answers?.best_match && typeof answers.best_match === 'object' && !Array.isArray(answers.best_match) ? answers.best_match : null;
  const presence = answers?.has_match && typeof answers.has_match === 'object' && !Array.isArray(answers.has_match) ? answers.has_match : null;
  const probabilities = choice?.probabilities;
  const probabilityObject = probabilities !== null && typeof probabilities === 'object' && !Array.isArray(probabilities) ? probabilities : null;
  const values = probabilityObject ? Object.values(probabilityObject) : [];
  const numericValues = values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value));
  const keys = probabilityObject ? Object.keys(probabilityObject) : [];
  const allowed = new Set(allowedIds);
  return {
    reason: CONTRACT_REASONS.has(error?.message) ? error.message : 'unknown-contract-error',
    confidenceType: typeof choice?.confidence,
    choiceType: typeof choice?.choice,
    noulType: typeof presence?.noul,
    probabilitiesObjectType: typeof probabilities,
    probabilitiesArray: Array.isArray(probabilities),
    probabilityCount: keys.length,
    allowedCount: allowed.size,
    keysCoverage: Boolean(probabilityObject && keys.length === allowed.size && keys.every((key) => allowed.has(key))),
    numericValues,
    probabilitySum: numericValues ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
  };
}
function responseError(requestId, kind, cancelled = false, status, code = errorCode(kind), diagnostic) { return { ok: false, requestId: safeRequestId(requestId), kind, code, error: ERROR_TEXT[kind] || ERROR_TEXT.service, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}), ...(code === 'response-contract' && diagnostic ? { diagnostic } : {}), ...(cancelled ? { cancelled: true } : {}) }; }

async function settings() {
  await ready;
  let stored;
  let revision;
  try {
    stored = await chrome.storage.local.get({ apiKey: '', excludedDomains: [] });
    revision = await readRevision();
  } catch {
    throw typedError('settings');
  }
  if (!stored || (stored.apiKey !== undefined && typeof stored.apiKey !== 'string') || (stored.excludedDomains !== undefined && !Array.isArray(stored.excludedDomains))) throw typedError('settings');
  return { apiKey: typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '', excludedDomains: (stored.excludedDomains || []).map(normalizeDomain).filter(Boolean), revision };
}

function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''); }

// The content script marked its own empty frame in the extension's isolated world; only an injection
// result tells which frame that is. The token goes back to the content script and later to the first
// bar document in exactly that frame, never through the page.
async function bindBar(message, sender) {
  const mark = typeof message.mark === 'string' && MARK_PATTERN.test(message.mark) ? message.mark : '';
  if (!mark || typeof sender.documentId !== 'string') return { ok: false };
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: (value) => globalThis.__JEV_BAR_MARK__ === value, args: [mark] });
  } catch {
    return { ok: false };
  }
  const marked = (Array.isArray(results) ? results : []).filter((result) => result?.result === true && Number.isInteger(result.frameId) && result.frameId !== 0);
  if (marked.length !== 1) { bars.delete(sender.tab.id); return { ok: false }; }
  const token = randomToken();
  bars.set(sender.tab.id, { frameId: marked[0].frameId, documentId: sender.documentId, token, greeted: false });
  return { ok: true, token };
}

// Only the first bar document in the bound frame gets the session; a copy, another frame or a
// reloaded document in the same frame stays inert.
function greetBar(sender) {
  const tabId = sender?.tab?.id;
  if (sender?.id !== chrome.runtime.id || sender.url !== BAR_URL || !Number.isInteger(tabId) || !Number.isInteger(sender.frameId) || sender.frameId === 0) return { ok: false };
  const bar = bars.get(tabId);
  if (!bar || bar.greeted || bar.frameId !== sender.frameId) return { ok: false };
  bar.greeted = true;
  return { ok: true, tabId, documentId: bar.documentId, token: bar.token };
}

function validSender(sender) {
  const tabUrl = sender?.tab?.url;
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !/^https?:\/\//i.test(tabUrl || '') || typeof sender.url !== 'string') return false;
  try { return new URL(sender.url).origin === new URL(tabUrl).origin; } catch { return false; }
}
function validSearch(message) { if (!safeRequestId(message?.requestId)) return false; try { validateQuery(message.query); validateBlocks(message.blocks); return true; } catch { return false; } }
function pageAllowed(sender, excludedDomains) { return validSender(sender) && !isExcluded(sender.tab.url, excludedDomains); }
function addUsage(total, usage) { if (usage) { total.input_tokens += typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0; total.output_tokens += typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0; } }

async function waitMs(ms, signal) {
  if (signal.aborted) throw cancelledError();
  await new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); reject(cancelledError()); };
    timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function retryAfterMs(response) {
  const value = response.headers?.get?.('Retry-After');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, REQUEST_TIMEOUT_MS);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), REQUEST_TIMEOUT_MS));
  }
  return DEFAULT_RETRY_MS;
}

async function fetchWithTimeout(body, signal, apiKey) {
  if (signal.aborted) throw cancelledError();
  const requestController = new AbortController();
  let timedOut = false;
  const abort = () => requestController.abort();
  const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, REQUEST_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: requestController.signal });
    let payload;
    if (response.ok) {
      try { payload = await response.json(); } catch (error) {
        if (signal.aborted) throw cancelledError();
        if (timedOut) throw typedError('service');
        if (error?.kind) throw error;
        throw typedError('invalid', response.status, 'json');
      }
    }
    return { response, payload };
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    if (timedOut) throw typedError('service');
    if (error?.kind) throw error;
    throw typedError(error?.kind || 'service');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

// spend reserves one attempt in the request budget; nothing is sent without it.
async function callJev(body, signal, apiKey, spend) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) throw cancelledError();
    await spend();
    const result = await fetchWithTimeout(body, signal, apiKey);
    const { response, payload } = result;
    if (response.ok) return { payload, status: response.status };
    if (response.status === 401 || response.status === 403) throw typedError('auth', response.status);
    if (response.status === 402) throw typedError('service', response.status);
    if (response.status === 400 || response.status === 422) throw typedError('invalid-request', response.status, 'http');
    if ((response.status === 429 || response.status === 529) && attempt === 0) { await waitMs(retryAfterMs(response), signal); continue; }
    if (response.status === 413 || response.status === 429) throw typedError('limit', response.status);
    throw typedError(response.status >= 500 || response.status === 529 ? 'service' : 'invalid-request', response.status, 'http');
  }
  throw typedError('service');
}

function ensureCurrent(tabId, generation, controller) {
  if (controller.signal.aborted || generations.get(tabId) !== generation) throw cancelledError();
}

function classifyError(error) {
  if (error?.kind) return error.kind;
  if (error instanceof RangeError) return 'limit';
  if (error instanceof TypeError) return 'invalid';
  return 'service';
}

async function search(message, sender, generation, controller) {
  const tabId = sender.tab.id;
  try {
    const blocks = validateBlocks(message.blocks);
    const { apiKey, excludedDomains } = await settings();
    ensureCurrent(tabId, generation, controller);
    if (!pageAllowed(sender, excludedDomains)) throw typedError('domain');
    if (!apiKey) throw typedError('missing-key');
    const usage = { input_tokens: 0, output_tokens: 0 };
    const ranked = [];
    const run = { used: 0 };
    const spend = () => budget.reserve(tabId, run);
    const requests = buildInitialRequests(message.query, blocks);
    await budget.preflight(tabId, requests.length);
    for (const request of requests) {
      ensureCurrent(tabId, generation, controller);
      const provider = await callJev(request, controller.signal, apiKey, spend);
      let parsed;
      try { parsed = parseInitialResponse(provider.payload, request.state.blocks); } catch (error) { error.status = provider.status; error.code = 'response-contract'; error.diagnostic = contractDiagnostic(provider.payload, error, ['no_match', ...request.state.blocks.map(({ id }) => id)]); throw error; }
      ensureCurrent(tabId, generation, controller);
      ranked.push(...parsed.candidates);
      addUsage(usage, parsed.usage);
    }
    // Best candidates first, so a confirmation stage trimmed to the budget keeps the strongest ones.
    const unique = [...new Map(ranked.map((item) => [item.id, item])).values()].sort((a, b) => b.score - a.score);
    if (!unique.length) return { ok: true, requestId: message.requestId, results: [], possible: [], usage };
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const possible = [];
    const good = [];
    const room = await budget.allowance(tabId, run);
    const allowed = Math.min(room.search, room.tab);
    if (allowed <= 0) throw Object.assign(typedError('budget', undefined, room.tab <= 0 ? 'budget-tab' : 'budget-search'), room.tab <= 0 ? { retryAfterMs: room.retryAfterMs } : {});
    ensureCurrent(tabId, generation, controller);
    for (const batch of buildShortlistBatches(message.query, unique.map(({ id }) => byId.get(id))).slice(0, allowed)) {
      ensureCurrent(tabId, generation, controller);
      const provider = await callJev(buildShortlistRequest(message.query, batch), controller.signal, apiKey, spend);
      let parsed;
      try { parsed = parseShortlistResponse(provider.payload, batch); } catch (error) { error.status = provider.status; error.code = 'response-contract'; error.diagnostic = contractDiagnostic(provider.payload, error, batch.map(({ id }) => `match_${id}`)); throw error; }
      ensureCurrent(tabId, generation, controller);
      possible.push(...parsed.possible);
      good.push(...parsed.results);
      addUsage(usage, parsed.usage);
    }
    ensureCurrent(tabId, generation, controller);
    possible.sort((a, b) => b.score - a.score);
    good.sort((a, b) => b.score - a.score);
    return { ok: true, requestId: message.requestId, results: good.slice(0, 12), possible: possible.slice(0, 12), usage };
  } catch (error) {
    const kind = classifyError(error);
    const response = responseError(message.requestId, kind, kind === 'cancelled', error?.status, error?.code, error?.diagnostic);
    if (kind === 'budget' && Number.isFinite(error?.retryAfterMs)) response.retryAfterMs = error.retryAfterMs;
    return response;
  } finally {
    if (active.get(tabId)?.generation === generation) active.delete(tabId);
  }
}

function abortTab(tabId) {
  generations.set(tabId, (generations.get(tabId) || 0) + 1);
  active.get(tabId)?.controller.abort();
  active.delete(tabId);
}

async function broadcastConfig() {
  let current;
  try {
    current = await settings();
  } catch {
    return;
  }
  let tabs = [];
  try { tabs = chrome.tabs?.query ? await chrome.tabs.query({}) : []; } catch { tabs = []; }
  const targets = new Map([...knownTabs.entries()].map(([id, url]) => [id, { id, url }]));
  for (const tab of tabs || []) if (Number.isInteger(tab.id)) targets.set(tab.id, { id: tab.id, url: tab.url || knownTabs.get(tab.id) || '' });
  await Promise.all([...targets.values()].filter((tab) => /^https?:\/\//i.test(tab.url || '')).map((tab) => chrome.tabs?.sendMessage ? chrome.tabs.sendMessage(tab.id, { type: 'JEV_CONFIG_UPDATED', hasKey: Boolean(current.apiKey), excluded: isExcluded(tab.url, current.excludedDomains), revision: current.revision }).catch(() => {}) : Promise.resolve()));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'JEV_BAR_HELLO') { sendResponse(greetBar(sender)); return false; }
  if (!message || !CONTENT_MESSAGES.has(message.type) || !validSender(sender)) return false;
  knownTabs.set(sender.tab.id, sender.tab.url);
  if (message.type === 'JEV_CONFIG') {
    settings().then(({ apiKey, excludedDomains, revision }) => sendResponse({ ok: true, hasKey: Boolean(apiKey), excluded: !pageAllowed(sender, excludedDomains), revision })).catch((error) => sendResponse(responseError('', error?.kind || 'settings')));
    return true;
  }
  if (message.type === 'JEV_BAR_BIND') {
    bindBar(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'JEV_CANCEL') {
    const requestId = safeRequestId(message.requestId);
    const current = active.get(sender.tab.id);
    if (requestId && current?.requestId === requestId) current.controller.abort();
    sendResponse({ ok: true, cancelled: Boolean(requestId && current?.requestId === requestId) });
    return false;
  }
  if (message.type === 'JEV_SEARCH') {
    if (!validSearch(message)) { sendResponse(responseError(message?.requestId, 'invalid')); return false; }
    const tabId = sender.tab.id;
    const generation = (generations.get(tabId) || 0) + 1;
    generations.set(tabId, generation);
    active.get(tabId)?.controller.abort();
    const controller = new AbortController();
    active.set(tabId, { requestId: message.requestId, generation, controller });
    search(message, sender, generation, controller).then(sendResponse).catch(() => sendResponse(responseError(message.requestId, 'service')));
    return true;
  }
  return false;
});

if (chrome.storage.onChanged?.addListener) chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.apiKey && !changes.excludedDomains)) return;
  for (const tabId of active.keys()) abortTab(tabId);
  void bumpRevision().catch(() => {}).then(broadcastConfig);
});
if (chrome.tabs?.onUpdated?.addListener) chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.url) knownTabs.set(tabId, changeInfo.url);
  if (changeInfo?.url || changeInfo?.status === 'loading') { abortTab(tabId); bars.delete(tabId); }
});
if (chrome.tabs?.onRemoved?.addListener) chrome.tabs.onRemoved.addListener((tabId) => { abortTab(tabId); knownTabs.delete(tabId); bars.delete(tabId); void budget.forget(tabId).catch(() => {}); });

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  try {
    const { excludedDomains } = await settings();
    const restricted = !/^https?:\/\//i.test(tab.url || '');
    if (restricted || isExcluded(tab.url, excludedDomains)) {
      const excluded = !restricted && isExcluded(tab.url, excludedDomains);
      await chrome.action.setTitle({ tabId: tab.id, title: excluded ? 'JEV Find: domena wykluczona' : 'JEV Find: strona niedostępna' });
      await chrome.action.setBadgeText({ tabId: tab.id, text: excluded ? 'OFF' : '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: excluded ? '#6b7280' : '#b45309' });
      return;
    }
    await chrome.action.setTitle({ tabId: tab.id, title: 'JEV Find' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    const surface = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.contentType === 'application/pdf' || Boolean(document.querySelector('embed[type="application/pdf"]')),
    });
    if (surface?.[0]?.result) {
      await chrome.action.setTitle({ tabId: tab.id, title: 'JEV Find: PDF niedostępny' });
      await chrome.action.setBadgeText({ tabId: tab.id, text: 'PDF' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b45309' });
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch {
    await chrome.action.setTitle({ tabId: tab.id, title: 'JEV Find: strona niedostępna' }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
  }
});
