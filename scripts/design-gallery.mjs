// Design gallery: every bar state, highlight close-ups and the options page in one color scheme.
// Usage: node scripts/design-gallery.mjs <extensionDir> <outDir> [light|dark]
// Same isolation as browser-qa.mjs: DNS blocked, every request fulfilled locally, synthetic key only.
// Fails when the bar changes height between states, leaves a strip under the panel or wraps the status.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JEV_PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(process.argv[2] || path.join(root, 'extension'));
const out = path.resolve(process.argv[3] || path.join(root, '.scratch/design-gallery'));
const colorScheme = process.argv[4] === 'dark' ? 'dark' : 'light';
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(out, 'profile-'));
const fixture = await fs.readFile(path.join(root, 'tests/fixtures/page.html'), 'utf8');
const KEY = 'JEV-FIXTURE-NOT-A-REAL-KEY';
let mode = 'normal';
const report = { date: new Date().toISOString(), extension, colorScheme, shots: [], errors: [], blocked: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// WCAG contrast of every visible text element and placeholder, against its own background
// composited from all (also translucent) layers below it. Runs in the bar frame or the options page;
// must stay self-contained.
function auditContrast() {
  const root = document.body;
  const cs = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const parse = value => {
    let m = value.match(/^rgba?\(([^)]+)\)$/);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = value.match(/^color\(srgb ([^)]+)\)$/);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a); };
  const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const parentOf = el => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const background = el => {
    const layers = [];
    for (let node = el; node; node = parentOf(node)) { const c = parse(cs(node).backgroundColor); if (c && c[3] > 0) layers.push(c); }
    let color = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i -= 1) color = over(layers[i], color);
    return color;
  };
  const results = [];
  const visit = node => {
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.data.trim()).join(' ').trim();
      if (!text || el.closest('[hidden]') || el.matches(':disabled') || !el.getClientRects().length) continue;
      const style = cs(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let opacity = 1;
      for (let n = el; n; n = parentOf(n)) opacity *= Number(cs(n).opacity);
      if (opacity < 1) continue;
      const bg = background(el);
      const fg = parse(style.color);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      results.push({ text: text.slice(0, 40), ratio: +ratio(fg[3] < 1 ? over(fg, bg) : fg, bg).toFixed(2), need: large ? 3 : 4.5 });
    }
  };
  visit(root);
  for (const input of root.querySelectorAll('input, textarea')) {
    if (!input.placeholder || input.value || input.disabled) continue;
    const bg = background(input);
    const ph = parse(cs(input, '::placeholder').color);
    results.push({ text: 'placeholder: ' + input.placeholder.split('\n')[0], ratio: +ratio(ph[3] < 1 ? over(ph, bg) : ph, bg).toFixed(2), need: 4.5 });
  }
  return results;
}

// No media emulation: CDP emulation forces the scheme into every frame and once hid a bar that stayed
// light in a real dark browser. The flags set the browser's own preference instead; without them the
// full Chromium follows the host OS theme, so a "light" run on a dark Mac would silently be dark.
const themeArgs = colorScheme === 'dark' ? ['--force-dark-mode'] : ['--blink-settings=preferredColorScheme=1'];
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromium.executablePath(), headless: true, colorScheme: null,
  viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
  args: [...themeArgs, '--host-resolver-rules=MAP * ~NOTFOUND', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
let id;
try {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://api.typesafe.ai/')) {
      const body = route.request().postDataJSON();
      const blocks = body.state.blocks || body.state.candidates;
      let status = 200;
      if (route.request().headers().authorization !== `Bearer ${KEY}`) status = 401;
      else if (mode === 'service') status = 503;
      if (mode === 'slow') await sleep(4000);
      if (status !== 200) { await route.fulfill({ status, contentType: 'application/json', headers: { 'Retry-After': '0' }, body: '{}' }).catch(() => {}); return; }
      const query = body.state.query;
      const marker = query === 'częściowo' ? '[MAYBE]' : '[GOOD]';
      const matches = blocks.filter(b => b.text.includes(marker));
      const present = query === 'nigdzie' ? 0.05 : matches.length ? (query === 'częściowo' ? 0.5 : 0.94) : 0.05;
      let answers;
      if (body.questions.best_match) {
        const ids = Object.keys(body.questions.best_match.criteria);
        const best = present >= 0.35 ? matches[0]?.id : 'no_match';
        answers = { best_match: { type: 'choice', choice: best, probabilities: Object.fromEntries(ids.map(x => [x, x === best ? 0.94 : 0.06 / (ids.length - 1)])), confidence: 0.92 }, has_match: { type: 'noul', noul: present } };
      } else {
        answers = Object.fromEntries(blocks.map(b => [`match_${b.id}`, { type: 'noul', noul: b.text.includes(marker) ? (query === 'częściowo' ? 0.5 : 0.94) : 0.05 }]));
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: 'fixture-jev', answers, usage: { input_tokens: 100, output_tokens: 10 } }) }).catch(() => {});
      return;
    }
    if (url.startsWith('https://jev-find.test/')) return route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
    if (url === 'https://other.fixture.test/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Tekst obcej ramki niedostępnyobcy</p>' });
    if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return route.continue();
    report.blocked.push(url);
    await route.abort();
  });

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  id = worker.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession();
  report.browser = (await cdp.send('Browser.getVersion')).product;
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  // The bar is an extension frame inside a closed shadow root: found in the frame list, resolved per call.
  const barFrame = () => page.frames().filter(frame => frame.url() === `chrome-extension://${id}/bar.html`).at(-1);
  const lazy = selector => new Proxy({}, { get: (_, name) => { const locator = barFrame().locator(selector); const value = locator[name]; return typeof value === 'function' ? value.bind(locator) : value; } });
  const ui = { locator: selector => barFrame().locator(selector), getByRole: (...args) => barFrame().getByRole(...args) };
  const input = lazy('input[aria-label="Szukaj na stronie"]');
  const waitForBar = async () => { const end = Date.now() + 5000; while (Date.now() < end) { if (barFrame() && await barFrame().locator('.status').textContent().catch(() => '')) return; await sleep(40); } throw new Error('bar session did not start'); };

  const action = async () => {
    await page.bringToFront();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(t => t.url === page.url()).targetId });
  };
  const barStatus = async () => (barFrame() ? await barFrame().locator('.status').textContent().catch(() => '') : '') || '';
  const waitStatus = async (pattern, timeout = 15000) => {
    const re = new RegExp(pattern, 'i');
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (re.test(await barStatus())) return; await sleep(40); }
    throw new Error(`status timeout: ${pattern} / got: ${await barStatus()}`);
  };
  // The page measures the host; the bar frame measures itself (its viewport is the frame's box).
  const geometry = async () => {
    const outer = await page.evaluate(() => {
      const b = document.querySelector('[data-jev-find]').getBoundingClientRect();
      return { innerWidth, innerHeight, host: { top: +b.top.toFixed(2), left: +b.left.toFixed(2), width: +b.width.toFixed(2), height: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2), right: +b.right.toFixed(2) } };
    });
    const inner = await barFrame().evaluate(() => {
    const ui = document;
    const rect = el => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(2), left: +b.left.toFixed(2), width: +b.width.toFixed(2), height: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2), right: +b.right.toFixed(2) }; };
    const status = ui.querySelector('.status');
    const action = ui.querySelector('.action');
    const panel = rect(ui.querySelector('.panel'));
    const frameRect = { top: 0, left: 0, width: innerWidth, height: innerHeight, bottom: innerHeight, right: innerWidth };
    return {
      frame: frameRect, panel, gapBelowPanel: +(frameRect.height - panel.height).toFixed(2),
      status: status.textContent, statusLines: Math.round(status.getBoundingClientRect().height / parseFloat(getComputedStyle(status).lineHeight)),
      statusClipped: status.scrollWidth > status.clientWidth, action: action.classList.contains('visible') ? action.textContent : '',
      count: ui.querySelector('.count').textContent, tone: ui.querySelector('.glyph').dataset.tone || '',
      frames: ui.querySelector('.frames').hidden ? '' : ui.querySelector('.frames').getAttribute('aria-label'),
    };
    });
    return { ...outer, ...inner };
  };
  const settle = async () => {
    await sleep(520);
    let last = null, stable = 0;
    for (let i = 0; i < 100 && stable < 5; i += 1) { const y = await page.evaluate(() => scrollY); stable = y === last ? stable + 1 : 0; last = y; await sleep(60); }
    await sleep(200);
  };
  const shotBar = async (name, note) => {
    const g = await geometry();
    const x = Math.max(0, g.host.left - 28);
    await page.screenshot({ path: path.join(out, name + '.png'), clip: { x, y: 0, width: Math.min(g.innerWidth, g.host.right + 16) - x, height: Math.min(g.innerHeight, g.host.bottom + 40) }, caret: 'initial' });
    report.shots.push({ name, note, geometry: g });
  };
  const pageCrop = async (name, firstSel, lastSel, note) => {
    await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'center', behavior: 'instant' }), firstSel);
    await sleep(200);
    const r = await page.evaluate(([a, b]) => { const r1 = document.querySelector(a).getBoundingClientRect(); const r2 = document.querySelector(b).getBoundingClientRect(); return { x: Math.min(r1.left, r2.left), y: r1.top, right: Math.max(r1.right, r2.right), bottom: r2.bottom }; }, [firstSel, lastSel]);
    await page.screenshot({ path: path.join(out, name + '.png'), clip: { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 16), width: Math.min(760, r.right - r.x + 48), height: r.bottom - r.y + 32 }, caret: 'initial' });
    report.shots.push({ name, note });
  };
  const setKey = async value => {
    await options.locator('#api-key').fill(value);
    await options.locator('button[type=submit]').click();
    await options.waitForFunction(() => document.querySelector('#status').textContent === 'Ustawienia zapisane.');
    await page.bringToFront();
  };
  const setDomains = async value => {
    await options.locator('#excluded-domains').fill(value);
    await options.locator('button[type=submit]').click();
    await options.waitForFunction(() => document.querySelector('#status').textContent === 'Ustawienia zapisane.');
    await page.bringToFront();
    await sleep(400);
  };

  report.contrast = {};
  const auditBar = async label => { report.contrast[label] = await barFrame().evaluate(auditContrast); };
  const auditOptions = async label => { report.contrast[label] = await options.evaluate(auditContrast); };

  await page.goto('https://jev-find.test/');
  await action(); await waitForBar();
  await waitStatus('klucz'); await sleep(300);
  report.theme = {
    pagePrefersDark: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
    ...await barFrame().evaluate(() => ({ barPrefersDark: matchMedia('(prefers-color-scheme: dark)').matches, panelBackground: getComputedStyle(document.querySelector('.panel')).backgroundColor })),
  };
  assert.equal(report.theme.pagePrefersDark, colorScheme === 'dark', 'browser theme');
  assert.equal(report.theme.barPrefersDark, colorScheme === 'dark', 'bar frame follows the browser theme');
  await shotBar('01-otwarcie-bez-klucza', 'Bez klucza: akcja Dodaj klucz');
  await auditBar('bar-idle');
  await input.fill('igła'); await waitStatus('Dosłowne trafienia'); await settle();
  await shotBar('02-doslowne', 'Dosłowne trafienia 1/3');
  await auditBar('bar-results');
  await pageCrop('02b-strona-doslowne', '#needle-1', '#needle-3', 'Aktywne dosłowne pomarańczowe, pozostałe żółte');

  await setKey(KEY);
  await waitStatus('semantyczn'); await settle();
  await shotBar('03-mieszane', 'Dosłowne + semantyczne');
  await pageCrop('03b-strona-mieszane', '#needle-1', '#maybe', 'Żółte dosłowne, fioletowe semantyczne');

  mode = 'slow';
  await input.fill('opis odpoczynku');
  await waitStatus('Szukam po znaczeniu', 4000); await sleep(300);
  await shotBar('04-szukam', 'Czekanie na JEV');
  mode = 'normal';
  await waitStatus('^Najlepsze dopasowanie', 20000); await settle();
  await shotBar('05-semantyczne', 'Najlepsze dopasowanie 1/1');
  await pageCrop('05b-strona-semantyczne', '#good', '#maybe', 'Aktywne semantyczne fioletowe');

  await input.fill('nigdzie'); await waitStatus('Nie znaleziono'); await settle();
  await shotBar('06-brak', 'Brak dopasowania');

  await page.evaluate(() => scrollTo(0, 0));
  await input.fill('częściowo'); await waitStatus('pewnego dopasowania'); await settle();
  await shotBar('07-niepewne', 'Niepewne: akcja Pokaż najbliższe');
  await ui.getByRole('button', { name: 'Pokaż najbliższe', exact: true }).click(); await settle();
  await shotBar('07b-najblizsze', 'Po kliknięciu Pokaż najbliższe');
  await pageCrop('07c-strona-najblizsze', '#good', '#maybe', 'Możliwy fragment jako aktywny');

  mode = 'service';
  await input.fill('igła'); await waitStatus('niedostęp', 30000); await settle();
  await shotBar('08-blad-uslugi', 'Usługa niedostępna (503)');
  await auditBar('bar-error');
  mode = 'normal';

  await setKey('JEV-BAD-FIXTURE'); await waitStatus('Nieprawidłowy klucz', 30000); await settle();
  await shotBar('09-zly-klucz', 'Zły klucz (401)');
  await setKey(KEY); await waitStatus('Dosłowne trafienia', 20000);

  mode = 'slow';
  await input.fill('opis odpoczynku'); await sleep(700);
  await page.evaluate(() => { document.getElementById('good').firstChild.data = '[GOOD] Akapit zmieniony po wysłaniu zapytania.'; });
  await waitStatus('zmieniła', 20000);
  mode = 'normal';
  await settle();
  await shotBar('10-tresc-zmieniona', 'Treść zmieniona: akcja Odśwież');

  await setDomains('jev-find.test');
  await waitStatus('wykluczona');
  await shotBar('11-wykluczona', 'Domena wykluczona przy otwartym pasku');
  await setDomains('');

  await page.goto('https://jev-find.test/');
  await action(); await waitForBar();
  await page.setViewportSize({ width: 360, height: 760 });
  await input.fill('igła'); await waitStatus('Dosłowne'); await settle();
  await shotBar('12-waskie', 'Wąskie okno 360 px');
  await page.screenshot({ path: path.join(out, '12b-waskie-calosc.png'), caret: 'initial' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle();
  await page.screenshot({ path: path.join(out, '13-desktop-calosc.png'), caret: 'initial' });

  await options.bringToFront();
  await options.reload();
  await options.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  await options.locator('#excluded-domains').fill('przyklad.pl\npanel.przyklad.com');
  await options.locator('button[type=submit]').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent === 'Ustawienia zapisane.');
  await options.screenshot({ path: path.join(out, '20-ustawienia-z-kluczem.png'), fullPage: true });
  await auditOptions('options-saved');
  await options.locator('#excluded-domains').fill('to nie jest domena!!');
  await options.locator('button[type=submit]').click(); await sleep(250);
  await options.screenshot({ path: path.join(out, '21-ustawienia-blad.png'), fullPage: true });
  await auditOptions('options-error');
  await options.locator('#excluded-domains').fill('');
  await options.locator('#remove-key').click(); await sleep(250);
  await options.screenshot({ path: path.join(out, '22-ustawienia-bez-klucza.png'), fullPage: true });
  await auditOptions('options-no-key');
  await options.setViewportSize({ width: 390, height: 844 });
  await options.screenshot({ path: path.join(out, '23-ustawienia-waskie.png'), fullPage: true });

  // The design contract: one height for every state, no strip under the panel, a single status line.
  const bars = report.shots.filter(shot => shot.geometry && shot.name !== '12-waskie');
  const heights = [...new Set(bars.map(shot => shot.geometry.panel.height))];
  report.summary = {
    panelHeights: heights,
    maxGapBelowPanel: Math.max(...report.shots.filter(shot => shot.geometry).map(shot => shot.geometry.gapBelowPanel)),
    maxStatusLines: Math.max(...report.shots.filter(shot => shot.geometry).map(shot => shot.geometry.statusLines)),
    contrastChecked: Object.values(report.contrast).flat().length,
    minContrast: Math.min(...Object.values(report.contrast).flat().map(item => item.ratio)),
    contrastFailures: Object.entries(report.contrast).flatMap(([label, items]) => items.filter(item => item.ratio < item.need).map(item => `${label}: ${item.text} ${item.ratio}`)),
  };
  assert.deepEqual(report.summary.contrastFailures, [], 'text contrast below WCAG AA');
  assert.equal(heights.length, 1, `panel height differs between states: ${heights.join(', ')}`);
  assert.ok(report.summary.maxGapBelowPanel < 1, `frame taller than panel by ${report.summary.maxGapBelowPanel}px`);
  assert.equal(report.summary.maxStatusLines, 1, 'status wraps');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  console.log('PASS gallery', colorScheme, JSON.stringify(report.summary));
} catch (error) {
  report.errors.push(error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
