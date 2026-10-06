// Request budget for paid searches. Every HTTP attempt to TypeSafe, a retry included, is reserved here
// before it is sent: one serialized check-reserve-write against session storage, so concurrent attempts,
// a woken worker or a cancelled request never give budget back. The budget counts requests, not money.
export const LIMITS = Object.freeze({ perSearch: 32, perTab: 160, windowMs: 10 * 60 * 1000 });
const STORE_KEY = 'requestBudget';

function budgetError(code, retryAfterMs) {
  const error = new Error(`JEV Find request budget: ${code}`);
  error.kind = 'budget';
  error.code = code;
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  return error;
}

export function createBudget({ storage, now = () => Date.now(), limits = LIMITS } = {}) {
  let tabs = null;
  // Tabs closed while this worker lives; a late attempt for one never recreates its entry.
  const closed = new Set();
  let tail = Promise.resolve();
  const serial = (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };

  async function load() {
    if (tabs) return;
    let stored;
    try { stored = await storage.get({ [STORE_KEY]: {} }); } catch { throw budgetError('budget-storage'); }
    const entries = stored && typeof stored[STORE_KEY] === 'object' && stored[STORE_KEY] ? Object.entries(stored[STORE_KEY]) : [];
    tabs = new Map(entries.map(([tabId, times]) => [Number(tabId), Array.isArray(times) ? times.filter(Number.isFinite).sort((a, b) => a - b) : []]));
  }

  async function save() {
    try { await storage.set({ [STORE_KEY]: Object.fromEntries(tabs) }); } catch { throw budgetError('budget-storage'); }
  }

  // Attempts of this tab still inside the sliding window, oldest first.
  function recent(tabId) {
    const since = now() - limits.windowMs;
    const times = (tabs.get(tabId) || []).filter((time) => time > since);
    if (times.length) tabs.set(tabId, times); else tabs.delete(tabId);
    return times;
  }

  // Milliseconds until the tab has `needed` free attempts again.
  function waitFor(times, needed) {
    const free = limits.perTab - times.length;
    if (free >= needed) return 0;
    return times[needed - free - 1] + limits.windowMs - now();
  }

  return {
    limits,
    // Before the first request: the exact first-stage batches plus one confirmation batch must fit both
    // the search limit and what is left of the tab's window.
    preflight(tabId, batches) {
      return serial(async () => {
        await load();
        const needed = batches + 1;
        if (needed > limits.perSearch) throw budgetError('budget-page');
        const times = recent(tabId);
        if (limits.perTab - times.length < needed) throw budgetError('budget-tab', waitFor(times, needed));
      });
    },
    // What this search may still send; the confirmation stage is trimmed to it, best candidates first.
    allowance(tabId, search) {
      return serial(async () => {
        await load();
        const times = recent(tabId);
        return { search: limits.perSearch - search.used, tab: limits.perTab - times.length, retryAfterMs: waitFor(times, 1) };
      });
    },
    // One HTTP attempt: both limits are checked and the reservation is stored before the request may go out.
    reserve(tabId, search) {
      return serial(async () => {
        if (closed.has(tabId)) throw budgetError('budget-tab');
        await load();
        const times = recent(tabId);
        if (search.used >= limits.perSearch) throw budgetError('budget-search');
        if (times.length >= limits.perTab) throw budgetError('budget-tab', waitFor(times, 1));
        times.push(now());
        tabs.set(tabId, times);
        search.used += 1;
        await save();
      });
    },
    forget(tabId) {
      return serial(async () => {
        closed.add(tabId);
        await load();
        if (tabs.delete(tabId)) await save();
      });
    },
  };
}
