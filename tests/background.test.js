import test from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); }, emit(...args) { return listeners.map((listener) => listener(...args)); } };
}

const runtimeMessage = event();
const storageChanged = event();
const tabUpdated = event();
const tabRemoved = event();
const actionClicked = event();
const storage = { apiKey: 'test-key', excludedDomains: [] };
const sentMessages = [];
const actionTitles = [];
const injectedScripts = [];
let pdfSurface = false;
// What the bind probe finds in the tab's frames: { frameId, result } per frame.
let frameMarks = [];
const sessionStore = {};
let sessionWritesFail = false;
const sender = { id: 'extension-id', frameId: 0, url: 'https://example.com/article', tab: { id: 7, url: 'https://example.com/article' } };
let fetchImpl = async () => response({ answers: {} });

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get(name) { return headers[name] || headers[name.toLowerCase()] || null; } }, json: async () => body };
}

globalThis.chrome = {
  runtime: { id: 'extension-id', onMessage: runtimeMessage, openOptionsPage() {}, getURL: (path) => `chrome-extension://extension-id/${String(path).replace(/^\//, '')}` },
  storage: {
    local: {
      async setAccessLevel() {},
      async get(defaults) { return { ...defaults, ...storage }; },
    },
    session: {
      async get(defaults) { return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Object.hasOwn(sessionStore, key) ? structuredClone(sessionStore[key]) : value])); },
      async set(values) { if (sessionWritesFail) throw new Error('session quota'); Object.assign(sessionStore, structuredClone(values)); },
    },
    onChanged: storageChanged,
  },
  tabs: {
    onUpdated: tabUpdated,
    onRemoved: tabRemoved,
    async query() { return [{ id: sender.tab.id, url: sender.tab.url }]; },
    async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); },
  },
  action: { onClicked: actionClicked, async setTitle(details) { actionTitles.push(details); }, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  scripting: { async executeScript(details) { injectedScripts.push(details); if (details.args) return frameMarks.map(({ frameId, result }) => ({ frameId, documentId: `doc-${frameId}`, result })); return details.func ? [{ result: pdfSurface }] : []; } },
};
globalThis.fetch = (...args) => fetchImpl(...args);
await import('../extension/background.js?background-test');

function dispatch(message, messageSender = sender, instance = 0) {
  return new Promise((resolve) => {
    const handled = runtimeMessage.listeners[instance](message, messageSender, resolve);
    if (!handled) resolve(undefined);
  });
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function initialAnswer({ noMatch = false } = {}) {
  return { answers: {
    best_match: { type: 'choice', choice: noMatch ? 'no_match' : 'a', confidence: 0.9, probabilities: noMatch ? { no_match: 0.9, a: 0.1 } : { no_match: 0.1, a: 0.9 } },
    has_match: { type: 'noul', noul: noMatch ? 0.1 : 0.9 },
  }, usage: { input_tokens: 10, output_tokens: 2 } };
}

test('runs initial and shortlist stages with one trusted key and final Nouls', async () => {
  const bodies = [];
  fetchImpl = async (_url, options) => {
    bodies.push({ body: JSON.parse(options.body), auth: options.headers.Authorization });
    return bodies.length === 1 ? response(initialAnswer()) : response({ answers: { match_a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 3, output_tokens: 1 } });
  };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'req-1', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ id: 'a', score: 0.8 }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].auth, 'Bearer test-key');
  assert.match(bodies[0].body.questions.best_match.instructions, /state\.query/);
  assert.match(bodies[1].body.questions.match_a.instructions, /state\.candidates/);
});

test('returns a successful empty result when the initial stage says no match', async () => {
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response(initialAnswer({ noMatch: true })); };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'req-2', query: 'missing', blocks: [{ id: 'a', text: 'answer' }] });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.possible, []);
  assert.equal(calls, 1);
});

test('cancels during Retry-After wait without a second provider call', async () => {
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response({}, 429, { 'Retry-After': '10' }); };
  const pending = dispatch({ type: 'JEV_SEARCH', requestId: 'req-3', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await dispatch({ type: 'JEV_CANCEL', requestId: 'req-3' }), { ok: true, cancelled: true });
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls, 1);
});

test('cancels after provider response but before JSON parsing completes', async () => {
  let resolveJson;
  let providerSignal;
  fetchImpl = async (_url, options) => { providerSignal = options.signal; return { ok: true, status: 200, headers: { get() { return null; } }, json: () => new Promise((resolve) => { resolveJson = resolve; }) }; };
  const pending = dispatch({ type: 'JEV_SEARCH', requestId: 'req-4', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = dispatch({ type: 'JEV_CANCEL', requestId: 'req-4' });
  resolveJson(initialAnswer());
  await cancel;
  assert.equal((await pending).kind, 'cancelled');
  assert.equal(providerSignal.aborted, true);
});

test('marks a PDF surface unavailable before injecting content.js', async () => {
  injectedScripts.length = 0;
  actionTitles.length = 0;
  pdfSurface = true;
  await Promise.all(actionClicked.emit({ id: sender.tab.id, url: sender.tab.url }));
  assert.equal(injectedScripts.length, 1);
  assert.equal(typeof injectedScripts[0].func, 'function');
  assert.equal(actionTitles.at(-1).title, 'JEV Find: PDF niedostępny');
  pdfSurface = false;
});

test('returns safe fixed error codes and bounded HTTP status diagnostics', async () => {
  storage.apiKey = 'replacement-key';
  storage.excludedDomains = [];
  for (const [status, kind] of [[400, 'invalid-request'], [403, 'auth'], [429, 'limit'], [503, 'service']]) {
    fetchImpl = async () => response({ secret: 'provider body must not escape' }, status, { 'X-Provider-Secret': 'must not escape' });
    const result = await dispatch({ type: 'JEV_SEARCH', requestId: `http-${status}`, query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
    assert.equal(result.kind, kind);
    assert.equal(result.code, 'http');
    assert.equal(result.status, status);
    assert.equal(result.error.includes('provider'), false);
    assert.equal(JSON.stringify(result).includes('must not escape'), false);
  }
});

test('distinguishes malformed JSON from a response contract violation without leaking details', async () => {
  fetchImpl = async () => ({ ok: true, status: 200, headers: { get() { return null; } }, json: async () => { throw new Error('raw provider secret'); } });
  const jsonResult = await dispatch({ type: 'JEV_SEARCH', requestId: 'json-error', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  assert.deepEqual({ kind: jsonResult.kind, code: jsonResult.code, status: jsonResult.status }, { kind: 'invalid', code: 'json', status: 200 });
  assert.equal(JSON.stringify(jsonResult).includes('raw provider secret'), false);

  fetchImpl = async () => response({ answers: { best_match: { type: 'choice', choice: 'foreign-id', probabilities: { no_match: 0, a: 1 } }, has_match: { type: 'noul', noul: 1 } } });
  const contractResult = await dispatch({ type: 'JEV_SEARCH', requestId: 'contract-error', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  assert.deepEqual({ kind: contractResult.kind, code: contractResult.code, status: contractResult.status }, { kind: 'invalid', code: 'response-contract', status: 200 });
  assert.deepEqual(contractResult.diagnostic, {
    reason: 'invalid JEV choice answer',
    confidenceType: 'undefined',
    choiceType: 'string',
    noulType: 'number',
    probabilitiesObjectType: 'object',
    probabilitiesArray: false,
    probabilityCount: 2,
    allowedCount: 2,
    keysCoverage: true,
    numericValues: true,
    probabilitySum: 1,
  });
  assert.equal(JSON.stringify(contractResult).includes('foreign-id'), false);
});

test('settings changes abort work and broadcast only non-secret config', async () => {
  sentMessages.length = 0;
  await dispatch({ type: 'JEV_CONFIG' });
  storage.apiKey = '';
  storageChanged.emit({ apiKey: { oldValue: 'test-key', newValue: '' } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  const update = sentMessages.at(-1).message;
  assert.equal(update.type, 'JEV_CONFIG_UPDATED');
  assert.equal(update.hasKey, false);
  assert.equal(Object.hasOwn(update, 'apiKey'), false);
  assert.equal(typeof update.revision, 'number');
  storage.apiKey = 'replacement-key';
  storage.excludedDomains = ['example.com'];
  storageChanged.emit({ apiKey: { oldValue: '', newValue: 'replacement-key' }, excludedDomains: { oldValue: [], newValue: ['example.com'] } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.at(-1).message.excluded, true);
});

test('rejects iframe and mismatched URL senders before touching the API', async () => {
  const before = sentMessages.length;
  const sameOrigin = await dispatch({ type: 'JEV_CONFIG' }, { ...sender, url: 'https://example.com/other-route' });
  assert.equal(sameOrigin.ok, true);
  assert.equal(await dispatch({ type: 'JEV_CONFIG' }, { ...sender, frameId: 1 }), undefined);
  assert.equal(await dispatch({ type: 'JEV_CONFIG' }, { ...sender, url: 'https://other.example/' }), undefined);
  assert.equal(sentMessages.length, before);
});

test('rejects malformed search payloads without echoing unsafe request IDs', async () => {
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response(initialAnswer()); };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: '<secret>', query: 'find', blocks: [{ id: 'a', text: 'answer' }] });
  assert.equal(result.kind, 'invalid');
  assert.equal(result.requestId, '');
  assert.equal(calls, 0);
});

const pageSender = { ...sender, documentId: 'page-doc' };
const barSender = { id: 'extension-id', url: 'chrome-extension://extension-id/bar.html', frameId: 3, documentId: 'bar-doc-1', tab: { id: 7, url: sender.tab.url } };

test('binds the one frame that carries the mark and greets only its first bar document', async () => {
  frameMarks = [{ frameId: 0, result: false }, { frameId: 3, result: true }, { frameId: 4, result: false }];
  const bind = await dispatch({ type: 'JEV_BAR_BIND', mark: 'm'.repeat(48) }, pageSender);
  assert.equal(bind.ok, true);
  assert.match(bind.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(injectedScripts.at(-1).target, { tabId: 7, allFrames: true });
  assert.deepEqual(injectedScripts.at(-1).args, ['m'.repeat(48)]);
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, { ...barSender, frameId: 4 }), { ok: false }, 'a copy in another frame');
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, { ...barSender, url: 'chrome-extension://extension-id/options.html' }), { ok: false }, 'another extension page');
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, { ...barSender, id: 'other-extension' }), { ok: false }, 'another extension');
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, { ...barSender, tab: { id: 8, url: sender.tab.url } }), { ok: false }, 'another tab');
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, barSender), { ok: true, tabId: 7, documentId: 'page-doc', token: bind.token });
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, { ...barSender, documentId: 'bar-doc-2' }), { ok: false }, 'a reloaded document in the same frame');
});

test('refuses binding without exactly one marked frame or from a non-top sender', async () => {
  for (const marks of [[], [{ frameId: 0, result: true }], [{ frameId: 3, result: true }, { frameId: 5, result: true }]]) {
    frameMarks = marks;
    assert.deepEqual(await dispatch({ type: 'JEV_BAR_BIND', mark: 'm'.repeat(48) }, pageSender), { ok: false });
  }
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, barSender), { ok: false }, 'a failed bind leaves no session');
  frameMarks = [{ frameId: 3, result: true }];
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_BIND', mark: 'short' }, pageSender), { ok: false }, 'malformed mark');
  assert.equal(await dispatch({ type: 'JEV_BAR_BIND', mark: 'm'.repeat(48) }, { ...pageSender, frameId: 1 }), undefined, 'iframe content script');
  tabRemoved.emit(7);
  assert.deepEqual(await dispatch({ type: 'JEV_BAR_HELLO' }, barSender), { ok: false }, 'closed tab');
});

// One block per first-stage batch: 12000 two-byte characters fill most of the 27000-byte request.
const heavyBlocks = (count) => Array.from({ length: count }, (_, index) => ({ id: `h${index}`, text: 'ż'.repeat(12000) }));
// Earlier tests leave a replaced key and example.com excluded; budget tests start from a usable page.
const tabSender = (tabId) => { storage.apiKey = 'test-key'; storage.excludedDomains = []; return { ...sender, tab: { id: tabId, url: sender.tab.url } }; };
const spent = (tabId) => (sessionStore.requestBudget?.[tabId] || []).length;
// The first stage picks the batch's block with a score that grows with its index; confirmations say yes.
function candidateAnswers(options) {
  const body = JSON.parse(options.body);
  if (body.questions.best_match) {
    const id = body.state.blocks[0].id;
    const score = 0.5 + Number(id.slice(1)) / 100;
    return response({ answers: { best_match: { type: 'choice', choice: id, confidence: 0.9, probabilities: { no_match: 1 - score, [id]: score } }, has_match: { type: 'noul', noul: 0.9 } } });
  }
  return response({ answers: Object.fromEntries(body.state.candidates.map(({ id }) => [`match_${id}`, { type: 'noul', noul: 0.9 }])) });
}

test('budget: a page whose first stage needs 32 batches is refused before any request', async () => {
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response(initialAnswer({ noMatch: true })); };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'budget-page', query: 'find', blocks: heavyBlocks(32) }, tabSender(101));
  assert.deepEqual({ kind: result.kind, code: result.code, calls }, { kind: 'budget', code: 'budget-page', calls: 0 });
  assert.equal(spent(101), 0);
});

test('budget: 31 batches run and the confirmation is trimmed to the best candidate', async () => {
  const confirmed = [];
  fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (!body.questions.best_match) confirmed.push(...body.state.candidates.map(({ id }) => id));
    return candidateAnswers(options);
  };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'budget-trim', query: 'find', blocks: heavyBlocks(31) }, tabSender(102));
  assert.equal(result.ok, true);
  assert.equal(spent(102), 32, '31 first-stage requests and one confirmation');
  assert.deepEqual(confirmed, ['h30'], 'the strongest candidate is kept');
  assert.deepEqual(result.results.map(({ id }) => id), ['h30']);
});

test('budget: retries count, and the request after the 32nd is never sent', async () => {
  let calls = 0;
  fetchImpl = async (_url, options) => {
    calls += 1;
    if (calls === 1 || calls === 3) return response({}, 429, { 'Retry-After': '0' });
    const id = JSON.parse(options.body).state.blocks[0].id;
    return response({ answers: { best_match: { type: 'choice', choice: 'no_match', confidence: 0.9, probabilities: { no_match: 0.9, [id]: 0.1 } }, has_match: { type: 'noul', noul: 0.1 } } });
  };
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'budget-retry', query: 'find', blocks: heavyBlocks(31) }, tabSender(103));
  assert.deepEqual({ kind: result.kind, code: result.code, calls, spent: spent(103) }, { kind: 'budget', code: 'budget-search', calls: 32, spent: 32 });
});

test('budget: a request cancelled after it was sent stays counted', async () => {
  let release;
  fetchImpl = (_url, options) => new Promise((resolve, reject) => { release = resolve; options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const pending = dispatch({ type: 'JEV_SEARCH', requestId: 'budget-cancel', query: 'find', blocks: [{ id: 'a', text: 'answer' }] }, tabSender(104));
  await settle(); await settle();
  await dispatch({ type: 'JEV_CANCEL', requestId: 'budget-cancel' }, tabSender(104));
  assert.equal((await pending).kind, 'cancelled');
  assert.equal(typeof release, 'function', 'the request was on the wire');
  assert.equal(spent(104), 1);
});

test('budget: a failed budget write stops the paid path before the request', async () => {
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response(initialAnswer({ noMatch: true })); };
  sessionWritesFail = true;
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'budget-store', query: 'find', blocks: [{ id: 'a', text: 'answer' }] }, tabSender(105));
  sessionWritesFail = false;
  assert.deepEqual({ kind: result.kind, code: result.code, calls }, { kind: 'budget', code: 'budget-storage', calls: 0 });
});

test('budget: a full tab is refused before the request with the time until it frees up', async () => {
  sessionStore.requestBudget = { ...(sessionStore.requestBudget || {}), 106: Array.from({ length: 160 }, () => Date.now()) };
  let calls = 0;
  fetchImpl = async () => { calls += 1; return response(initialAnswer({ noMatch: true })); };
  // A fresh worker instance reads the stored window, as after the worker slept.
  await import('../extension/background.js?budget-instance');
  const result = await dispatch({ type: 'JEV_SEARCH', requestId: 'budget-tab', query: 'find', blocks: [{ id: 'a', text: 'answer' }] }, tabSender(106), runtimeMessage.listeners.length - 1);
  assert.deepEqual({ kind: result.kind, code: result.code, calls }, { kind: 'budget', code: 'budget-tab', calls: 0 });
  assert.ok(result.retryAfterMs > 590000 && result.retryAfterMs <= 600000);
});

test('settings revisions only grow and a new worker instance continues from session storage', async () => {
  const before = await dispatch({ type: 'JEV_CONFIG' });
  storage.excludedDomains = [];
  storageChanged.emit({ excludedDomains: { oldValue: ['example.com'], newValue: [] } }, 'local');
  await settle(); await settle();
  const update = sentMessages.at(-1).message;
  assert.equal(update.revision, before.revision + 1);
  assert.equal(sessionStore.configRevision, update.revision);
  assert.equal((await dispatch({ type: 'JEV_CONFIG' })).revision, update.revision);
  await import('../extension/background.js?second-instance');
  assert.equal((await dispatch({ type: 'JEV_CONFIG' }, sender, runtimeMessage.listeners.length - 1)).revision, update.revision, 'a woken worker does not go back');
});
