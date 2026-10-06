import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const playwrightModule = process.env.JEV_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);
const playwrightVersion = require(path.join(path.dirname(require.resolve(playwrightModule)), 'package.json')).version;
const extension = path.resolve(process.argv[2] || path.join(root, 'extension'));
const manifestVersion = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8')).version;
// One folder per version: a new run never overwrites receipts of an earlier release.
const qa = path.resolve(process.env.JEV_QA_DIR || path.join(root, '.scratch/initial/qa', `v${manifestVersion}`));
const receiptPath = path.join(qa, process.env.JEV_QA_RECEIPT || 'regressions.json');
await fs.mkdir(qa, { recursive: true });
const profile = await fs.mkdtemp(path.join(qa, 'regressions-profile-'));
const fixture = (await fs.readFile(path.join(root, 'tests/fixtures/page.html'), 'utf8')).replace(/<\/body>\s*<\/html>\s*$/, '<div id="qa-progress">░░░░00%</div><script>window.addEventListener("scroll",()=>{document.getElementById("qa-progress").textContent="▓░░░08%";});</script></body></html>');
const rail = await fs.readFile(path.join(root, 'tests/fixtures/rail.html'), 'utf8');
const checks = [];
const calls = [];
const errors = [];
const blocked = [];
const steps = [];
const key = 'JEV-REGRESSION-NOT-A-REAL-KEY';
const baseUrl = 'https://jev-find.test/';
let apiDelay = 0;
let inflight = 0;

function record(name, detail = {}) {
  checks.push({ name, ...detail });
  console.log('PASS ' + name);
}

async function waitUntil(read, predicate, timeout = 2500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate(await read())) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for expected state.');
}

const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromium.executablePath(),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`
  ],
  ignoreDefaultArgs: ['--disable-extensions']
});

let version;
let id;
let page;
let ui;
let input;
let count;
let status;

try {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://api.typesafe.ai/')) {
      const body = route.request().postDataJSON();
      const authorization = route.request().headers().authorization;
      const call = {
        query: body.state?.query,
        stage: body.questions?.best_match ? 'initial' : 'confirm',
        syntheticAuth: authorization === `Bearer ${key}`,
        badKey: authorization === 'Bearer JEV-BAD-FIXTURE',
        bytes: Buffer.byteLength(JSON.stringify(body)),
        started: Date.now()
      };
      calls.push(call);
      inflight += 1;
      if (authorization === 'Bearer JEV-BAD-FIXTURE') {
        call.finished = Date.now();
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }).catch(() => {});
        inflight -= 1;
        return;
      }
      if (apiDelay) await new Promise(resolve => setTimeout(resolve, apiDelay));
      // A failed answer for this query makes the bar offer „Ponów”.
      if (call.query === 'awaria') {
        call.finished = Date.now();
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {});
        inflight -= 1;
        return;
      }
      const blocks = body.state?.blocks || body.state?.candidates || [];
      // Only the rail query has a planted answer; every other query is a clean no-match.
      const marker = body.state?.query === 'opis drogi' ? '[SEM]' : null;
      const isHit = block => Boolean(marker) && String(block.text).includes(marker);
      let answers;
      if (body.questions?.best_match) {
        const ids = Object.keys(body.questions.best_match.criteria || {});
        const best = blocks.find(isHit)?.id || 'no_match';
        answers = {
          best_match: {
            type: 'choice',
            choice: best,
            probabilities: Object.fromEntries(ids.map(name => [name, name === best ? 0.94 : 0.06 / (ids.length - 1)])),
            confidence: 0.92
          },
          has_match: { type: 'noul', noul: best === 'no_match' ? 0.05 : 0.94 }
        };
      } else {
        answers = Object.fromEntries(blocks.map(block => [`match_${block.id}`, { type: 'noul', noul: isHit(block) ? 0.94 : 0.05 }]));
      }
      call.finished = Date.now();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ model: 'fixture-jev', answers, usage: { input_tokens: 1, output_tokens: 1 } })
      }).catch(() => {});
      inflight -= 1;
      return;
    }
    if (url === baseUrl + 'mods') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p id="site-navigation">site shortcut navigation</p>' });
      return;
    }
    // 40 paragraphs of three-byte characters: one paragraph per first-stage batch, 40 batches.
    if (url === baseUrl + 'huge') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><h1>Za długa strona</h1>' + Array.from({ length: 40 }, (_, index) => `<p>Akapit ${index} ${'字'.repeat(5000)}</p>`).join('') });
      return;
    }
    if (url === baseUrl + 'rail') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: rail });
      return;
    }
    if (url.startsWith('https://jev-find.test/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
      return;
    }
    if (url.startsWith('https://other.fixture.test/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Tekst obcej ramki niedostępnyobcy</p>' });
      return;
    }
    if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort();
  });

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  id = worker.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession();
  version = (await cdp.send('Browser.getVersion')).product;
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  assert.ok(commands.some(command => command.name === '_execute_action' && command.shortcut));
  record('MV3 worker and shortcut loaded', { version, commands });

  let options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#api-key').fill(key);
  await options.locator('button[type=submit]').click();
  await options.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ustawienia zapisane.');

  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));

  const action = async () => {
    await page.bringToFront();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tab = targetInfos.find(target => target.url === page.url());
    assert.ok(tab, 'tab target exists');
    await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  };
  // The tool reads the bar through its extension frame; the page itself has no way to reach it.
  const isBar = frame => frame.url() === `chrome-extension://${id}/bar.html`;
  const openBar = async () => {
    const earlier = new Set(page.frames().filter(isBar));
    await action();
    await page.locator('[data-jev-find]').waitFor({ state: 'attached' });
    await waitUntil(() => page.frames().find(frame => isBar(frame) && !earlier.has(frame)) || null, Boolean, 5000);
    ui = page.frames().find(frame => isBar(frame) && !earlier.has(frame));
    input = ui.locator('input[aria-label="Szukaj na stronie"]');
    count = ui.locator('.count');
    status = ui.locator('.status');
    await input.waitFor();
    // The status line stays empty until the content script accepts the bar's session.
    await waitUntil(() => status.textContent(), Boolean, 5000);
  };
  const hostCount = () => page.locator('[data-jev-find]').count();
  const refresh = () => ui.locator('[data-action="action"]');
  const waitStatus = (pattern, timeout) => waitUntil(() => status.textContent(), value => new RegExp(pattern, 'i').test(value || ''), timeout);
  // Reads what the user actually sees: the painted CSS highlights, not only the counter or the status line.
  const barState = async () => ({ ...await pageState(), count: await count.textContent(), status: await status.textContent(), action: await ui.locator('.action').isVisible() ? await ui.locator('.action').getAttribute('data-kind') : '' });
  const pageState = () => page.evaluate(() => {
    const describe = range => {
      const node = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
      return { id: node?.closest?.('[id]')?.id || '', text: range.toString(), collapsed: range.collapsed, connected: range.startContainer.isConnected && range.endContainer.isConnected };
    };
    const list = name => [...(CSS.highlights.get(name) || [])].map(describe);
    const counters = window.__railMutations || { prog: 0, toggle: 0, subs: 0, toggleTexts: [] };
    return {
      literal: list('jev-find-literal'),
      semantic: list('jev-find-semantic'),
      active: list('jev-find-active'),
      scrollY: Math.round(scrollY),
      prog: document.getElementById('prog')?.textContent || '',
      toggle: document.querySelector('.art-anim-toggle')?.textContent || '',
      mutations: { prog: counters.prog, toggle: counters.toggle, subs: counters.subs, toggleTexts: [...new Set(counters.toggleTexts)] }
    };
  });
  // Waits past the 450 ms local scroll, then for smooth scrolling to stop and pending mutation checks to run.
  const settle = async () => {
    await page.waitForTimeout(520);
    let last = null;
    let stable = 0;
    for (let i = 0; i < 100 && stable < 5; i += 1) {
      const y = await page.evaluate(() => scrollY);
      stable = y === last ? stable + 1 : 0;
      last = y;
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(450);
  };
  const expectStable = async (label, expected) => {
    await settle();
    const state = await barState();
    steps.push({ label, count: state.count, status: state.status, literal: state.literal.length, semantic: state.semantic.length, active: state.active.map(range => range.id), prog: state.prog, toggle: state.toggle, scrollY: state.scrollY });
    assert.equal(state.count, expected.count, `${label}: count`);
    assert.doesNotMatch(state.status, /zmieniła/i, `${label}: status`);
    assert.notEqual(state.action, 'refresh', `${label}: refresh action`);
    assert.equal(state.literal.length, expected.literal ?? 0, `${label}: literal highlights`);
    assert.equal(state.semantic.length, expected.semantic ?? 0, `${label}: semantic highlights`);
    assert.equal(state.active.length, 1, `${label}: one active highlight`);
    assert.equal(state.active[0].id, expected.active, `${label}: active fragment`);
    assert.ok(state.active[0].text.includes(expected.text), `${label}: active text`);
    for (const range of [...state.literal, ...state.semantic, ...state.active]) assert.ok(range.connected && !range.collapsed, `${label}: live range in ${range.id}`);
    return state;
  };

  // Security suite 0.1.9. A hostile page script tries every known path to the bar: read the field,
  // inject text, events or messages, click its buttons, steal or return focus, ride a user activation,
  // plant a copy of the bar, remove or navigate it. Each probe proves that it reached its target or that
  // the target is out of reach, and counts logical searches delivered to the worker (by request ID, at
  // the worker's message boundary) separately from HTTP attempts at the network boundary. Probes with
  // model "handle" use a stronger attacker than a real page: the test hands the page the bar frame's
  // WindowProxy, which the page cannot obtain itself because the frame is not in its frame list.
  const pageCdp = await context.newCDPSession(page);
  // Raw CDP without userGesture: Playwright's own evaluate grants user activation and would taint it.
  const rawEval = async expression => {
    const { result, exceptionDetails } = await pageCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const currentWorker = () => context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${id}/`));
  // The tool's own listener in the worker sees every message the worker receives.
  const workerLog = async () => {
    const target = currentWorker();
    return target.evaluate(() => {
      if (!self.__qa) {
        self.__qa = { searches: [], cancels: [], hellos: [] };
        chrome.runtime.onMessage.addListener((message, sender) => {
          if (message?.type === 'JEV_SEARCH') self.__qa.searches.push(message.requestId);
          else if (message?.type === 'JEV_CANCEL') self.__qa.cancels.push(message.requestId);
          else if (message?.type === 'JEV_BAR_HELLO') self.__qa.hellos.push({ frameId: sender.frameId, documentId: sender.documentId });
        });
      }
      return { searches: self.__qa.searches.length, cancels: self.__qa.cancels.length, hellos: self.__qa.hellos.slice() };
    });
  };
  // Waits until no answer is pending and nothing new starts for a full pause plus margin.
  const quiesce = async () => {
    for (let last = -1, i = 0; i < 40; i += 1) {
      if (calls.length === last && inflight === 0) return;
      last = calls.length;
      await page.waitForTimeout(1500);
    }
    throw new Error('API traffic did not settle.');
  };
  const probe = async run => {
    await quiesce();
    const before = { calls: calls.length, log: await workerLog() };
    const evidence = await run();
    await quiesce();
    const after = await workerLog();
    assert.ok(after.searches >= before.log.searches, 'the worker restarted during a probe; counts are void');
    return { ...evidence, searches: after.searches - before.log.searches, http: calls.length - before.calls, cancels: after.cancels - before.log.cancels, added: calls.slice(before.calls).map(call => ({ query: call.query, stage: call.stage })) };
  };
  const attacks = [];
  const positives = [];
  const attack = async (name, model, run) => {
    const result = { name, model, ...await probe(run) };
    attacks.push(result);
    assert.equal(result.searches, 0, `${name}: no search may reach the worker`);
    assert.equal(result.http, 0, `${name}: no HTTP attempt`);
    return result;
  };
  const positive = async (name, expected, run) => {
    const result = { name, ...await probe(run) };
    positives.push(result);
    assert.equal(result.searches, expected, `${name}: exactly ${expected} search(es)`);
    return result;
  };
  const barField = () => ui.locator('input[aria-label="Szukaj na stronie"]');
  const barValue = () => barField().inputValue();
  const barAction = async () => {
    const button = ui.locator('.action');
    return await button.isVisible() ? (await button.getAttribute('data-kind')) || '' : '';
  };
  // The deep focus as the tool sees it: the bar document has focus and which control holds it.
  const barFocus = () => ui.evaluate(() => ({ focused: document.hasFocus(), control: document.activeElement?.getAttribute('aria-label') || document.activeElement?.dataset?.kind || document.activeElement?.tagName || '' }));
  // openOptionsPage focuses an open settings tab instead of opening one, so checks start with none open.
  const optionsUrl = `chrome-extension://${id}/options.html`;
  const optionsTabs = () => context.pages().filter(item => item.url() === optionsUrl).length;
  const closeOptions = async () => { for (const item of context.pages().filter(entry => entry.url() === optionsUrl)) await item.close(); options = null; };
  const ensureOptions = async () => {
    if (!options || options.isClosed()) { options = await context.newPage(); await options.goto(optionsUrl); await options.waitForFunction(() => !document.querySelector('button[type=submit]').disabled); }
    return options;
  };
  // A settings tab must open from the bar action within a few seconds; it is closed again afterwards.
  const expectSettingsTab = async click => {
    await closeOptions();
    await click();
    await waitUntil(optionsTabs, value => value === 1, 4000);
    await closeOptions();
  };
  // Real key events in the focused control; Playwright inserts characters outside the US layout without a key.
  const typeText = text => page.keyboard.type(text, { delay: 30 });
  const clearField = async () => { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); };
  // A real pointer click into the bar field: the user is present in the bar.
  const userInBar = async () => { await barField().click(); };
  const userOnPage = async () => { await page.locator('#fixture-input').click(); };
  // The stronger attacker: a WindowProxy of the bar frame handed to the page by the test.
  const handBarToPage = async () => {
    const element = await ui.frameElement();
    await page.evaluate(frame => { window.__qaBar = frame.contentWindow; }, element);
    await element.dispose();
  };
  const barActivation = async () => {
    const session = await context.newCDPSession(ui);
    try { return (await session.send('Runtime.evaluate', { expression: 'navigator.userActivation.isActive', returnByValue: true })).result.value; }
    finally { await session.detach().catch(() => {}); }
  };
  const settingsPrepare = async (domains, apiKey = '') => {
    const target = await ensureOptions();
    await target.locator('#excluded-domains').fill(domains);
    await target.locator('#api-key').fill(apiKey);
  };
  const settingsSubmit = async () => {
    await options.evaluate(() => { document.querySelector('#status').textContent = ''; });
    await options.locator('button[type=submit]').click();
    await options.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ustawienia zapisane.');
  };
  const settingsSave = async domains => { await settingsPrepare(domains); await settingsSubmit(); };
  const setKey = async value => { await settingsPrepare('', value); await settingsSubmit(); };

  await page.goto(baseUrl);
  await page.evaluate(() => {
    // Everything a hostile page script can reach of the bar field without help.
    window.__qaBarField = () => {
      const selector = 'input[aria-label="Szukaj na stronie"]';
      const inDoc = doc => doc && (doc.body?.shadowRoot?.querySelector(selector) || doc.querySelector(selector));
      try { const host = document.querySelector('[data-jev-find]'); const field = inDoc(host?.shadowRoot?.querySelector('iframe')?.contentDocument); if (field) return field; } catch {}
      for (let i = 0; i < window.length; i += 1) { try { const field = inDoc(window[i].document); if (field) return field; } catch {} }
      return null;
    };
  });
  const framesBefore = await page.evaluate(() => window.length);
  await openBar();
  await workerLog();

  await positive('P1 real typing after opening: one search after the pause, also with fast changes', 1, async () => {
    await typeText('opis drogi');
    return { field: await barValue() };
  });
  assert.equal(positives.at(-1).field, 'opis drogi');
  assert.deepEqual(positives.at(-1).added, [{ query: 'opis drogi', stage: 'initial' }], 'one logical search on the one-batch page is one HTTP attempt');

  const reach = await attack('N1 page reads the field', 'page', () => page.evaluate(() => {
    const host = document.querySelector('[data-jev-find]');
    const field = window.__qaBarField();
    return { reached: Boolean(field), hostRootHidden: host?.shadowRoot === null, frames: window.length, value: field ? field.value : null };
  }));
  assert.equal(reach.reached, false);
  assert.equal(reach.hostRootHidden, true, 'closed shadow root');
  assert.equal(reach.frames, framesBefore, 'the bar frame is not in the page frame list');
  for (const [name, script] of [
    ['N2 page sets the value and fires input and search', "(() => { const f = window.__qaBarField(); if (!f) return { reached: false }; f.value = 'atak strony'; f.dispatchEvent(new Event('input', { bubbles: true })); return { reached: true }; })()"],
    ['N2 page clicks „Ponów” and „Odśwież”', "(() => { const f = window.__qaBarField(); const b = f && f.getRootNode().querySelector('[data-action=\"action\"]'); if (!b) return { reached: false }; b.click(); return { reached: true }; })()"],
    ['N2 page fires synthetic keys, clicks and input at the host and runs execCommand', "(() => { const host = document.querySelector('[data-jev-find]'); for (const event of [new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }), new MouseEvent('click', { bubbles: true, composed: true }), new InputEvent('input', { bubbles: true, composed: true, data: 'x' })]) host.dispatchEvent(event); document.getElementById('fixture-input').focus(); const inserted = document.execCommand('insertText', false, 'atak exec'); const cut = document.execCommand('cut'); return { reached: false, inserted, cut, own: document.getElementById('fixture-input').value }; })()"]
  ]) {
    const result = await attack(name, 'page', () => rawEval(script));
    assert.equal(result.reached, false, `${name}: unreachable`);
    assert.equal(await barValue(), 'opis drogi', `${name}: bar field unchanged`);
  }
  await page.evaluate(() => { document.getElementById('fixture-input').value = 'sekretnawartość'; });

  await handBarToPage();
  const sop = await attack('N1 handle: page reads the bar document and location', 'handle', () => rawEval(`(() => {
    const out = {};
    try { out.document = typeof window.__qaBar.document; } catch (error) { out.document = error.name; }
    try { out.href = window.__qaBar.location.href; } catch (error) { out.href = error.name; }
    return out;
  })()`));
  assert.deepEqual([sop.document, sop.href], ['SecurityError', 'SecurityError']);
  const messages = await attack('N2 handle: page posts window messages to the bar', 'handle', () => rawEval(`(() => {
    for (const message of [{ type: 'query', value: 'atak', version: 1e9 }, { type: 'semantic', permit: 1e9, version: 1e9 }, { type: 'hello', token: 'x' }, { type: 'grant' }]) window.__qaBar.postMessage(message, '*');
    return { reached: true };
  })()`));
  assert.equal(messages.reached, true);
  assert.equal(await barValue(), 'opis drogi', 'window messages change nothing');

  // Activation: the page's own click never activates the extension frame.
  await page.waitForTimeout(5500);
  const activation = await attack('N6 a real click on the page does not activate the bar', 'page', async () => {
    const before = await barActivation();
    await page.mouse.click(640, 780);
    const after = await barActivation();
    const pageActive = await rawEval('navigator.userActivation.isActive');
    const reached = await rawEval("Boolean(window.__qaBarField())");
    return { before, after, pageActive, reached };
  });
  assert.deepEqual([activation.before, activation.after, activation.pageActive, activation.reached], [false, false, true, false]);
  await userInBar();
  await typeText('!');
  await page.keyboard.press('Backspace');
  const ancestor = await rawEval('navigator.userActivation.isActive');
  steps.push({ label: 'info: typing in the bar activates the page as an ancestor', pageActive: ancestor });
  await quiesce();

  const takeover = await attack('N3 handle: page returns focus to the bar after the user clicked a page field', 'handle', async () => {
    await userOnPage();
    await rawEval('window.__qaBar.focus()');
    const focus = await barFocus();
    await typeText(' przechwycone');
    const value = await barValue();
    const offered = await barAction();
    await page.keyboard.press('Enter');
    return { focus, value, offered };
  });
  assert.deepEqual(takeover.focus, { focused: true, control: 'Szukaj na stronie' });
  assert.ok(takeover.value.includes(' przechwycone'));
  assert.equal(takeover.offered, 'semantic', 'the bar offers Szukaj po znaczeniu');

  // Chromium restores focus to the field when the page focuses the frame again, so the button is reached
  // with Tab afterwards; both the restored control and the button get Enter and Space without presence.
  const semanticButton = await attack('N5 handle: Enter and Space on „Szukaj po znaczeniu” after the page returned focus', 'handle', async () => {
    for (let i = 0; i < 10 && (await barFocus()).control !== 'semantic'; i += 1) await page.keyboard.press('Tab');
    const reachedButton = (await barFocus()).control;
    await userOnPage();
    await rawEval('window.__qaBar.focus()');
    const restored = await barFocus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10 && (await barFocus()).control !== 'semantic'; i += 1) await page.keyboard.press('Tab');
    const focus = await barFocus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    return { reachedButton, restored, focus };
  });
  assert.equal(semanticButton.reachedButton, 'semantic');
  assert.equal(semanticButton.restored.focused, true);
  assert.deepEqual(semanticButton.focus, { focused: true, control: 'semantic' });

  await positive('P3 a real click in the bar and one more character', 1, async () => { await userInBar(); await page.keyboard.press('End'); await typeText('s'); return {}; });
  await positive('P4 a real click on „Szukaj po znaczeniu”', 1, async () => {
    await userOnPage();
    await rawEval('window.__qaBar.focus()');
    await typeText('x');
    assert.equal(await barAction(), 'semantic');
    await ui.locator('.action').click();
    return {};
  });

  const suppressed = await attack('N4 handle: page suppresses focus events and returns focus in the same task', 'handle', async () => {
    await userInBar();
    const sequence = await rawEval(`(() => {
      const stop = event => event.stopImmediatePropagation();
      window.__qaStops = stop;
      for (const type of ['focus', 'blur', 'focusin', 'focusout']) { window.addEventListener(type, stop, true); document.addEventListener(type, stop, true); }
      const field = document.getElementById('fixture-input');
      field.focus();
      const between = document.activeElement === field;
      window.__qaBar.focus();
      return { between };
    })()`);
    const focus = await barFocus();
    await typeText('zz');
    const offered = await barAction();
    await rawEval(`(() => { for (const type of ['focus', 'blur', 'focusin', 'focusout']) { window.removeEventListener(type, window.__qaStops, true); document.removeEventListener(type, window.__qaStops, true); } return true; })()`);
    return { ...sequence, focus, offered };
  });
  assert.equal(suppressed.between, true, 'the page field held focus in between');
  assert.deepEqual(suppressed.focus, { focused: true, control: 'Szukaj na stronie' });
  assert.equal(suppressed.offered, 'semantic');
  await positive('P3 pair of N4: the same typing with presence', 1, async () => { await userInBar(); await page.keyboard.press('End'); await typeText('z'); return {}; });

  await closeOptions();
  const settingsButton = await attack('N5 handle: Enter and Space on the settings icon after the page returned focus', 'handle', async () => {
    await userInBar();
    for (let i = 0; i < 10 && (await barFocus()).control !== 'Otwórz ustawienia'; i += 1) await page.keyboard.press('Tab');
    await userOnPage();
    await rawEval('window.__qaBar.focus()');
    const restored = await barFocus();
    for (let i = 0; i < 10 && (await barFocus()).control !== 'Otwórz ustawienia'; i += 1) await page.keyboard.press('Tab');
    const focus = await barFocus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    return { restored, focus, tabs: optionsTabs() };
  });
  assert.deepEqual(settingsButton.focus, { focused: true, control: 'Otwórz ustawienia' });
  assert.equal(settingsButton.tabs, 0, 'no settings tab opened');

  const tabbed = await attack('N9 a real Tab from the page into the bar', 'page', async () => {
    await userOnPage();
    let focus = await barFocus();
    for (let i = 0; i < 30 && !focus.focused; i += 1) { await page.keyboard.press('Tab'); focus = await barFocus(); }
    await clearField();
    await typeText('tabem');
    return { focus, value: await barValue(), offered: await barAction() };
  });
  assert.equal(tabbed.focus.focused, true, 'Tab reached the bar');
  assert.equal(tabbed.value, 'tabem');
  assert.equal(tabbed.offered, 'semantic');

  const copyHellos = (await workerLog()).hellos.length;
  const copy = await attack('N7 a copy of the bar planted by the page', 'page', async () => {
    await rawEval(`(() => { const frame = document.createElement('iframe'); frame.id = 'qa-copy'; frame.src = ${JSON.stringify(`chrome-extension://${id}/bar.html`)}; frame.style.cssText = 'position:fixed;left:16px;top:16px;width:440px;height:94px;z-index:2147483647;border:0'; document.body.append(frame); return true; })()`);
    let copyFrame = null;
    await waitUntil(() => (copyFrame = page.frames().find(item => item.url() === `chrome-extension://${id}/bar.html` && item !== ui) || null), Boolean, 5000);
    await copyFrame.locator('input[aria-label="Szukaj na stronie"]').waitFor();
    await waitUntil(async () => (await workerLog()).hellos.length, value => value > copyHellos, 5000);
    await closeOptions();
    await copyFrame.locator('input[aria-label="Szukaj na stronie"]').click();
    await typeText('kopia');
    await page.keyboard.press('Enter');
    await copyFrame.locator('[data-action="settings"]').click();
    await page.waitForTimeout(400);
    const hello = (await workerLog()).hellos.at(-1);
    await rawEval("document.getElementById('qa-copy').remove(), true");
    return { copyRan: true, hello, newTabs: optionsTabs() };
  });
  assert.equal(copy.newTabs, 0, 'the copy cannot open settings');
  assert.notEqual(copy.hello.frameId, undefined);

  // The user's own search is in flight when the page removes the host: the session ends, the search is
  // cancelled and nothing new starts. Counted from the moment the search is on the wire.
  await userInBar();
  await clearField();
  await quiesce();
  apiDelay = 3000;
  await typeText('igła');
  await waitUntil(() => inflight, value => value > 0, 5000);
  const inFlight = { calls: calls.length, log: await workerLog() };
  await rawEval("document.querySelector('[data-jev-find]').remove(), true");
  await waitUntil(hostCount, value => value === 0);
  await waitUntil(async () => (await workerLog()).cancels, value => value > inFlight.log.cancels, 3000);
  apiDelay = 0;
  await quiesce();
  const afterRemoval = await workerLog();
  const removed = { name: 'N8 page removes the host while a search is in flight', model: 'page', searches: afterRemoval.searches - inFlight.log.searches, http: calls.length - inFlight.calls, cancels: afterRemoval.cancels - inFlight.log.cancels, highlights: await page.evaluate(() => CSS.highlights.size) };
  attacks.push(removed);
  assert.deepEqual([removed.searches, removed.http, removed.cancels, removed.highlights], [0, 0, 1, 0], 'session ended, search cancelled, highlights cleared');

  await openBar();
  await handBarToPage();
  await typeText('igła');
  await waitUntil(() => count.textContent(), value => value === '1/3', 3000);
  const navigated = await attack('N8 handle: page navigates the bar frame', 'handle', async () => {
    await rawEval("window.__qaBar.location = 'about:blank', true");
    await waitUntil(hostCount, value => value === 0, 5000);
    return { highlights: await page.evaluate(() => CSS.highlights.size) };
  });
  assert.equal(navigated.highlights, 0);

  await openBar();
  await handBarToPage();
  await positive('P2 Enter during the pause gives one search, not two', 1, async () => { await typeText('opis'); await page.keyboard.press('Enter'); return {}; });
  await positive('P2 Enter on the same, already searched text gives one more', 1, async () => { await page.keyboard.press('Enter'); return {}; });
  await positive('P4 „Ponów” after an API error: the error search', 1, async () => { await clearField(); await typeText('awaria'); return {}; });
  await waitUntil(barAction, kind => kind === 'retry', 6000);
  await positive('P4 a click on „Ponów”', 1, async () => { await ui.locator('.action').click(); return {}; });
  await waitUntil(barAction, kind => kind === 'retry', 6000);
  await positive('P4 Enter on the focused „Ponów” (key and resulting click)', 1, async () => {
    for (let i = 0; i < 10 && (await barFocus()).control !== 'retry'; i += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    return {};
  });
  await userInBar();
  await clearField();
  await typeText('igła');
  await waitUntil(() => count.textContent(), value => value === '1/3', 3000);
  await quiesce();
  await page.evaluate(() => { document.getElementById('needle-3').firstChild.data = 'Trzecia linijka po zmianie nie ma już słowa.'; });
  await waitUntil(barAction, kind => kind === 'refresh', 6000);
  await positive('P4 a click on „Odśwież” after a hit changed', 1, async () => { await ui.locator('.action').click(); return {}; });
  await page.evaluate(() => { document.getElementById('needle-3').firstChild.data = 'Trzecia igła kończy zestaw rozdzielonych trafień.'; });

  await expectSettingsTab(() => ui.locator('[data-action="settings"]').click());
  record('P4 the settings icon opens settings for a present user');

  await userInBar();
  await clearField();
  await typeText('opis');
  await quiesce();
  await positive('P5 a settings change with confirmed text', 1, async () => { await settingsSave('unrelated-1.test'); return {}; });
  await settingsPrepare('unrelated-2.test');
  await positive('P5 a settings change during a pending pause gives one search in total', 1, async () => { await userInBar(); await typeText('!'); await settingsSubmit(); return {}; });
  await attack('P5 a settings change with unconfirmed text', 'page', async () => {
    await userOnPage();
    await rawEval('window.__qaBar.focus()');
    await typeText('?');
    assert.equal(await barAction(), 'semantic');
    await settingsSave('unrelated-3.test');
    return {};
  });
  await settingsSave('');
  await userInBar();
  await typeText('k');
  await quiesce();
  await attack('P5 removing the key with confirmed text sends nothing and offers „Dodaj klucz”', 'user', async () => {
    await (await ensureOptions()).locator('#remove-key').click();
    await waitUntil(barAction, kind => kind === 'settings', 3000);
    return {};
  });
  await expectSettingsTab(() => ui.locator('.action').click());
  record('P4 „Dodaj klucz” opens settings');
  await setKey('JEV-BAD-FIXTURE');
  await positive('P4 a bad key gives one search and „Ustawienia”', 1, async () => { await userInBar(); await clearField(); await typeText('klucz'); return {}; });
  await waitUntil(barAction, kind => kind === 'settings', 3000);
  await expectSettingsTab(() => ui.locator('.action').click());
  record('P4 „Ustawienia” opens settings');
  await setKey(key);
  await quiesce();

  await positive('P6 fill (trusted input without a key, like dictation) with presence', 1, async () => { await userInBar(); await barField().fill('dyktowanie'); return {}; });
  await positive('P6 paste with the keyboard shortcut', 1, async () => {
    await userInBar();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+V');
    return { value: await barValue() };
  });
  assert.equal(positives.at(-1).value, 'dyktowanie', 'the paste reached the field');

  await userInBar();
  await clearField();
  await quiesce();
  const barCdp = await context.newCDPSession(ui);
  const ime = await attack('N11 a composition longer than the pause sends nothing until it ends', 'user', async () => {
    await barCdp.send('Input.imeSetComposition', { text: 'ㄱ', selectionStart: 1, selectionEnd: 1 });
    await page.waitForTimeout(400);
    await barCdp.send('Input.imeSetComposition', { text: '가', selectionStart: 1, selectionEnd: 1 });
    await page.waitForTimeout(1200);
    return { composing: await barValue(), literalCount: await count.textContent() };
  });
  assert.equal(ime.composing, '가', 'the composition reached the field');
  // Committing a different candidate than the composed text, as an IME does; an identical, untouched
  // composition is only cleared by Blink without a compositionend.
  await positive('P8 the composition ends: one search', 1, async () => { await barCdp.send('Input.insertText', { text: '각' }); return { value: await barValue() }; });
  await barCdp.detach().catch(() => {});
  assert.equal(positives.at(-1).value, '각');

  await userOnPage();
  await positive('P3 the shortcut on a bar without presence focuses it instead of closing', 1, async () => {
    await action();
    await page.waitForTimeout(300);
    const open = await hostCount();
    await page.keyboard.press('End');
    await typeText('k');
    return { open };
  });
  assert.equal(positives.at(-1).open, 1);
  await action();
  await waitUntil(hostCount, value => value === 0);
  record('P3 the shortcut on a bar with presence closes it');

  await page.goto(baseUrl + 'huge');
  await openBar();
  const huge = await probe(async () => {
    await typeText('Akapit 39');
    await waitStatus('Strona za długa', 6000);
    return { status: await status.textContent(), count: await count.textContent() };
  });
  attacks.push({ name: 'N10 a page over the per-search budget', model: 'budget', ...huge });
  assert.deepEqual([huge.searches, huge.http], [1, 0], 'one search command, refused before any HTTP attempt');
  assert.equal(huge.status, 'Strona za długa na wyszukiwanie po znaczeniu. Dosłowne działają.');
  assert.equal(huge.count, '1/1', 'literal search still works');
  await input.press('Escape');
  await waitUntil(hostCount, value => value === 0);

  steps.push({ label: 'security suite', attacks, positives });
  record('Security suite: every page attack reaches nothing and starts no search; every positive starts exactly one; an over-long page is refused before HTTP', { attacks: attacks.length, positives: positives.length });

  // Exact claude.dev mechanics: every scroll frame rewrites #prog as B/text/SPAN, the figure button
  // swaps Play/Pause text and the rail shows sub-links of the active section.
  await page.goto(baseUrl + 'rail');
  await page.evaluate(() => {
    const counters = { prog: 0, toggle: 0, subs: 0, toggleTexts: [], progTimes: [] };
    window.__railMutations = counters;
    new MutationObserver(records => {
      for (const record of records) {
        const target = record.target;
        if (target.id === 'prog' && record.type === 'childList') {
          counters.prog += 1;
          if (counters.progTimes.length < 5000) counters.progTimes.push(Date.now());
        } else if (target.classList?.contains('art-anim-toggle') && record.type === 'childList') {
          counters.toggle += 1;
          counters.toggleTexts.push(target.textContent);
        } else if (target.classList?.contains('subs') && record.type === 'attributes') {
          counters.subs += 1;
        }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await openBar();
  await waitStatus('Dosłowne|klucz|wpisz');
  const progAtStart = (await barState()).mutations.prog;
  await input.fill('igła');
  // Literal results come back over the bar's port a few milliseconds after the input.
  await waitUntil(() => count.textContent(), value => value === '1/3');
  await page.waitForFunction(() => scrollY > 600, null, { timeout: 3000 });
  let railState = await expectStable('auto-scroll to the first hit', { count: '1/3', literal: 3, active: 'needle-1', text: 'igła' });
  assert.ok(railState.mutations.prog > progAtStart, 'scroll rewrote #prog');
  assert.ok(!railState.prog.endsWith('00%'), 'progress text changed');
  await input.press('ArrowDown');
  railState = await expectStable('ArrowDown to the second hit', { count: '2/3', literal: 3, active: 'needle-2', text: 'igła' });
  assert.equal(railState.toggle, 'Pause', 'figure above the second hit is playing');
  await input.press('ArrowDown');
  await expectStable('ArrowDown to the third hit', { count: '3/3', literal: 3, active: 'needle-3', text: 'igła' });
  await input.press('ArrowUp');
  await expectStable('ArrowUp back to the second hit', { count: '2/3', literal: 3, active: 'needle-2', text: 'igła' });
  await ui.getByRole('button', { name: 'Następne trafienie', exact: true }).click();
  await expectStable('Next button', { count: '3/3', literal: 3, active: 'needle-3', text: 'igła' });
  await ui.getByRole('button', { name: 'Poprzednie trafienie', exact: true }).click();
  await expectStable('Previous button', { count: '2/3', literal: 3, active: 'needle-2', text: 'igła' });
  await page.mouse.move(700, 420);
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, 700); await page.waitForTimeout(40); }
  for (let i = 0; i < 9; i += 1) { await page.mouse.wheel(0, -700); await page.waitForTimeout(40); }
  railState = await expectStable('wheel scroll away and back', { count: '2/3', literal: 3, active: 'needle-2', text: 'igła' });
  assert.ok(railState.mutations.toggle >= 3, 'Play/Pause text was rewritten');
  assert.ok(railState.mutations.toggleTexts.includes('Play') && railState.mutations.toggleTexts.includes('Pause'), 'Play and Pause both shown');
  assert.ok(railState.mutations.subs > 0, 'rail sub-links toggled');
  record('Rail: arrows, buttons and wheel keep every literal highlight through #prog, Play/Pause and rail mutations', { mutations: railState.mutations });

  apiDelay = 1500;
  const semanticStart = calls.length;
  await input.fill('opis drogi');
  await waitUntil(() => calls.length, value => value > semanticStart, 3000);
  await page.mouse.move(700, 420);
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, 600); await page.waitForTimeout(60); }
  await waitStatus('^Najlepsze dopasowanie', 9000);
  apiDelay = 0;
  railState = await expectStable('semantic answer after scrolling during the request', { count: '1/1', semantic: 1, active: 'sem', text: '[SEM]' });
  const semanticCalls = calls.slice(semanticStart);
  const requestStart = semanticCalls[0].started;
  const requestEnd = Math.max(...semanticCalls.map(call => call.finished || 0));
  const progTimes = await page.evaluate(() => window.__railMutations.progTimes);
  assert.ok(progTimes.some(time => time > requestStart && time < requestEnd), 'page rewrote #prog while the request was in flight');
  await input.press('ArrowDown');
  await page.mouse.wheel(0, -900);
  await expectStable('semantic hit after ArrowDown and wheel', { count: '1/1', semantic: 1, active: 'sem', text: '[SEM]' });
  record('Rail: a semantic answer survives unrelated page mutations during the request', { calls: semanticCalls.length });

  await input.fill('igła');
  await expectStable('literal again before a hit changes', { count: '1/3', literal: 3, active: 'needle-1', text: 'igła' });
  await page.evaluate(() => { document.getElementById('needle-3').firstChild.data = 'Trzecia linijka po zmianie nie ma już słowa.'; });
  await settle();
  railState = await barState();
  steps.push({ label: 'one hit changed', count: railState.count, status: railState.status, literal: railState.literal.length, active: railState.active.map(range => range.id) });
  assert.equal(railState.count, '1/2');
  assert.deepEqual(railState.literal.map(range => range.id).sort(), ['needle-1', 'needle-2']);
  assert.equal(railState.active.length, 1);
  assert.equal(railState.active[0].id, 'needle-1');
  assert.match(railState.status, /Treść strony się zmieniła/);
  assert.equal(railState.action, 'refresh');
  record('Rail: only the changed hit disappears; unchanged hits and the active one stay');

  apiDelay = 1500;
  const staleStart = calls.length;
  await input.fill('opis drogi');
  await waitUntil(() => calls.length, value => value > staleStart, 3000);
  await page.evaluate(() => { document.getElementById('sem').firstChild.data = '[SEM] Ścieżka po zmianie skręca do doliny.'; });
  await waitStatus('Treść strony się zmieniła', 9000);
  apiDelay = 0;
  await page.waitForTimeout(300);
  railState = await barState();
  assert.equal(railState.count, '0/0');
  assert.equal(railState.semantic.length, 0);
  assert.equal(railState.action, 'refresh');
  await refresh().click();
  await waitStatus('^Najlepsze dopasowanie', 6000);
  await expectStable('Refresh after a stale answer', { count: '1/1', semantic: 1, active: 'sem', text: '[SEM] Ścieżka po zmianie' });
  record('Rail: an answer for text changed in flight is discarded; Refresh recovers');
  await input.press('Escape');
  await waitUntil(hostCount, value => value === 0);

  await page.goto(baseUrl);
  await page.evaluate(() => {
    window.siteKeys = 0;
    const seen = new WeakSet();
    const capture = event => {
      if (seen.has(event)) return;
      seen.add(event);
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      window.siteKeys += 1;
      if (event.type === 'keydown' && String(event.key).toLocaleLowerCase() === 'm') window.location.href = '/mods';
    };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(type, capture, true);
      window.addEventListener(type, capture);
    }
  });

  await openBar();
  await waitStatus('Dosłowne|klucz|wpisz');

  await page.evaluate(() => { window.siteKeys = 0; });
  await input.fill('');
  await input.press('m');
  await page.waitForTimeout(80);
  assert.equal(page.url(), baseUrl);
  assert.equal(await page.evaluate(() => window.siteKeys), 0);
  record('Typing in the iframe UI does not trigger page keyboard shortcuts');

  await input.fill('igła');
  // Literal results come back over the bar's port a few milliseconds after the input.
  await waitUntil(() => count.textContent(), value => value === '1/3');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.waitForFunction(() => window.scrollY > 400, null, { timeout: 2500 });
  record('Literal results stay at top before the 450 ms pause, then scroll');
  await expectStable('single-node ASCII progress after scroll', { count: '1/3', literal: 3, active: 'needle-1', text: 'igła' });
  assert.equal(await page.locator('#qa-progress').textContent(), '▓░░░08%');
  record('Derived scroll-progress text does not invalidate source highlights');

  // "zamknij" is a key label inside the bar and never appears in the fixture page.
  assert.ok((await ui.locator('.keys').textContent()).includes('zamknij'), 'bar shows the probe text');
  await input.fill('zamknij');
  await waitUntil(() => status.textContent(), value => /Nie znaleziono/.test(value || ''));
  assert.equal(await count.textContent(), '0/0');
  record('The UI iframe query and status are excluded from page extraction');

  await input.fill('igła');
  await waitUntil(() => count.textContent(), value => value === '1/3');
  await page.evaluate(async () => {
    const target = document.getElementById('good');
    for (let i = 0; i < 100; i += 1) {
      target.classList.toggle('cosmetic-toggle');
      target.style.color = i % 2 ? '#1f2937' : '#374151';
      await new Promise(resolve => setTimeout(resolve, 3));
    }
  });
  await expectStable('class and style mutations', { count: '1/3', literal: 3, active: 'needle-1', text: 'igła' });
  assert.equal(await hostCount(), 1);
  record('Repeated class and style mutations do not invalidate results');

  await page.evaluate(() => {
    document.getElementById('needle-3').firstChild.data = 'Trzecia gwiazda kończy zestaw zmienionych trafień.';
    const hidden = document.getElementById('hidden-marker');
    hidden.hidden = false;
    hidden.classList.remove('hidden-marker');
  });
  await waitStatus('Treść strony się zmieniła');
  const changed = await barState();
  assert.equal(changed.count, '1/2');
  assert.deepEqual(changed.literal.map(range => range.id).sort(), ['needle-1', 'needle-2']);
  assert.equal(changed.action, 'refresh');
  await refresh().click();
  await waitStatus('Strona odświeżona|Dosłowne trafienia');
  await input.fill('igła');
  await waitUntil(() => count.textContent(), value => value === '1/2');
  await input.fill('ukrytytekst');
  await waitUntil(() => count.textContent(), value => value === '1/1');
  record('A changed hit is removed, unchanged hits stay; Refresh and new input see new text');

  await input.fill('igła');
  await waitUntil(() => count.textContent(), value => value === '1/2');
  await page.locator('#visible-action').focus();
  await page.keyboard.press('Escape');
  await waitUntil(hostCount, value => value === 0);
  await openBar();
  await input.fill('igła');
  await waitUntil(() => count.textContent(), value => value === '1/2');
  await input.press('Escape');
  await waitUntil(hostCount, value => value === 0);
  record('Escape closes from page focus and from iframe UI focus');

  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.syntheticAuth || call.badKey));
  record('Provider traffic stayed inside the fixture route', { calls: calls.length });
} catch (error) {
  errors.push(error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.mkdir(qa, { recursive: true });
  await fs.writeFile(receiptPath, JSON.stringify({
    date: new Date().toISOString(),
    extension,
    version,
    playwright: playwrightVersion,
    id,
    checks,
    steps,
    errors,
    calls,
    blocked,
    providerNetwork: 'Fixture route only; DNS disabled; synthetic key only.'
  }, null, 2) + '\n');
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
