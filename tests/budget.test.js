import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, LIMITS } from '../extension/budget.js';

const WINDOW = LIMITS.windowMs;

// Session storage as the extension sees it: async, structured clones, optionally failing writes.
function sessionStorage() {
  const data = {};
  return {
    data,
    failWrites: false,
    writes: 0,
    async get(defaults) { return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Object.hasOwn(data, key) ? structuredClone(data[key]) : value])); },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.failWrites) throw new Error('quota');
      this.writes += 1;
      Object.assign(data, structuredClone(values));
    },
  };
}

function setup() {
  const storage = sessionStorage();
  const clock = { now: 1_000_000 };
  const budget = createBudget({ storage, now: () => clock.now });
  return { storage, clock, budget };
}

const code = (promise) => promise.then(() => 'ok', (error) => { assert.equal(error.kind, 'budget'); return error.code; });

test('the limits are the product decision: 32 per search, 160 per tab in 10 minutes', () => {
  assert.deepEqual({ ...LIMITS }, { perSearch: 32, perTab: 160, windowMs: 600000 });
});

test('preflight: 31 first-stage batches fit with one confirmation batch, 32 do not', async () => {
  const { budget } = setup();
  assert.equal(await code(budget.preflight(1, 31)), 'ok');
  assert.equal(await code(budget.preflight(1, 32)), 'budget-page');
});

test('one search never sends more than 32 attempts, retries included', async () => {
  const { budget } = setup();
  const search = { used: 0 };
  for (let i = 0; i < 32; i += 1) assert.equal(await code(budget.reserve(1, search)), 'ok');
  assert.equal(await code(budget.reserve(1, search)), 'budget-search');
  assert.equal(search.used, 32);
});

test('a tab gets 160 attempts per sliding window; the 161st waits for the exact expiry', async () => {
  const { budget, clock } = setup();
  const first = clock.now;
  for (let i = 0; i < 160; i += 1) { await budget.reserve(1, { used: 0 }); clock.now += 1000; }
  const refused = await budget.reserve(1, { used: 0 }).catch((error) => error);
  assert.equal(refused.code, 'budget-tab');
  assert.equal(refused.retryAfterMs, first + WINDOW - clock.now);
  assert.equal(await code(budget.reserve(2, { used: 0 })), 'ok', 'another tab has its own window');
  clock.now = first + WINDOW - 1;
  assert.equal(await code(budget.reserve(1, { used: 0 })), 'budget-tab', 'one millisecond before expiry');
  clock.now = first + WINDOW;
  assert.equal(await code(budget.reserve(1, { used: 0 })), 'ok', 'the oldest attempt left the window');
});

test('preflight against a nearly used tab reports when enough attempts are free again', async () => {
  const { budget, clock } = setup();
  const first = clock.now;
  for (let i = 0; i < 159; i += 1) await budget.reserve(1, { used: 0 });
  const refused = await budget.preflight(1, 1).catch((error) => error);
  assert.equal(refused.code, 'budget-tab');
  assert.equal(refused.retryAfterMs, first + WINDOW - clock.now);
  assert.deepEqual(await budget.allowance(1, { used: 30 }), { search: 2, tab: 1, retryAfterMs: 0 });
});

test('two overlapping attempts at 159 of 160: exactly one is reserved', async () => {
  const { budget, storage } = setup();
  for (let i = 0; i < 159; i += 1) await budget.reserve(1, { used: 0 });
  const results = await Promise.allSettled([budget.reserve(1, { used: 0 }), budget.reserve(1, { used: 0 })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(storage.data.requestBudget[1].length, 160);
});

test('a reservation is stored before the request may go out and is never given back', async () => {
  const { budget, storage } = setup();
  const search = { used: 0 };
  await budget.reserve(7, search);
  // The caller now sends the request; a cancel, timeout or error afterwards changes nothing here.
  assert.equal(storage.data.requestBudget[7].length, 1);
  assert.equal(search.used, 1);
});

test('a failed write stops the paid path and keeps the attempt counted', async () => {
  const { budget, storage } = setup();
  storage.failWrites = true;
  const search = { used: 0 };
  assert.equal(await code(budget.reserve(1, search)), 'budget-storage');
  assert.equal(search.used, 1, 'counted although not stored');
  storage.failWrites = false;
  const failingRead = createBudget({ storage: { get: async () => { throw new Error('read'); }, set: async () => {} } });
  assert.equal(await code(failingRead.reserve(1, { used: 0 })), 'budget-storage');
});

test('a new worker instance continues from session storage', async () => {
  const { budget, storage, clock } = setup();
  for (let i = 0; i < 160; i += 1) await budget.reserve(3, { used: 0 });
  const woken = createBudget({ storage, now: () => clock.now });
  assert.equal(await code(woken.reserve(3, { used: 0 })), 'budget-tab');
  assert.equal(await code(woken.preflight(3, 1)), 'budget-tab');
});

test('closing a tab removes its entry and a late attempt does not recreate it', async () => {
  const { budget, storage } = setup();
  await budget.reserve(5, { used: 0 });
  await budget.forget(5);
  assert.equal(Object.hasOwn(storage.data.requestBudget, '5'), false);
  assert.equal(await code(budget.reserve(5, { used: 0 })), 'budget-tab');
  assert.equal(Object.hasOwn(storage.data.requestBudget, '5'), false);
});
