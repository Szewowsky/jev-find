// Real MV3 in a disposable Chromium profile. Every HTTP request is intercepted.
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
// One folder per version: a new run never overwrites receipts or screenshots of an earlier release.
const qa = path.resolve(process.env.JEV_QA_DIR || path.join(root, '.scratch/initial/qa', `v${manifestVersion}`));
await fs.mkdir(qa, { recursive: true });
const profile = await fs.mkdtemp(path.join(qa, 'profile-'));
const fixture = await fs.readFile(path.join(root, 'tests/fixtures/page.html'), 'utf8');
const checks = [], calls = [], errors = [], captures = [];
const key = 'JEV-FIXTURE-NOT-A-REAL-KEY';
let mode = 'normal', retryCount = 0;
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromium.executablePath(), headless: true,
  viewport: { width: 1280, height: 800 },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
let version, id;
function record(name, detail = {}) { checks.push({ name, ...detail }); console.log('PASS ' + name); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://api.typesafe.ai/')) {
      const body = route.request().postDataJSON();
      const auth = route.request().headers().authorization;
      const blocks = body.state.blocks || body.state.candidates;
      calls.push({ query: body.state.query, stage: body.questions.best_match ? 'initial' : 'confirm', ids: blocks.map(b => b.id), texts: blocks.map(b => b.text), bytes: Buffer.byteLength(JSON.stringify(body)), syntheticAuth: auth === `Bearer ${key}` });
      let status = 200;
      if (auth === 'Bearer JEV-BAD-FIXTURE') status = 401;
      else if (mode === 'service') status = 503;
      else if (mode === 'limit') status = 400;
      else if (mode === 'retry' && retryCount++ === 0) status = 429;
      if (mode === 'slow') await sleep(1200);
      if (status !== 200) { await route.fulfill({ status, contentType: 'application/json', headers: {'Retry-After':'0'}, body: '{}' }).catch(() => {}); return; }
      const query = body.state.query;
      const targetMarker = query === 'nowa odpowiedź' ? '[NEW]' : query === 'częściowo' ? '[MAYBE]' : query === 'igła' ? 'igła' : query === 'koniec dokumentu' ? '[LAST]' : '[GOOD]';
      const matches = blocks.filter(b => b.text.includes(targetMarker));
      const present = query === 'nigdzie' ? 0.05 : matches.length ? (query === 'częściowo' ? 0.5 : 0.94) : 0.05;
      let answers;
      if (body.questions.best_match) {
        const ids = Object.keys(body.questions.best_match.criteria);
        const best = present >= 0.35 ? matches[0]?.id : 'no_match';
        const probabilities = Object.fromEntries(ids.map(x => [x, x === best ? 0.94 : 0.06 / (ids.length - 1)]));
        answers = { best_match: { type:'choice', choice:best, probabilities, confidence:0.92 }, has_match:{type:'noul',noul:present} };
      } else {
        answers = Object.fromEntries(blocks.map(b => [`match_${b.id}`, {type:'noul',noul:b.text.includes(targetMarker) ? (query === 'częściowo' ? 0.5 : 0.94) : 0.05}]));
      }
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({model:'fixture-jev',answers,usage:{input_tokens:100,output_tokens:10}})}).catch(() => {});
      return;
    }
    if (/^https:\/\/(jev-find\.test|sub\.jev-find\.test|jev-find\.test\.evil\.test)\//.test(url)) {
      const body = url.endsWith('/pdf') ? '<!doctype html><html><body><embed type="application/pdf"></body></html>' : url.endsWith('/long') ? '<!doctype html><html><body><h1>Długa strona</h1>' + Array.from({length:245}, (_, i) => `<p>${i === 244 ? '[LAST] Cel na końcu długiego dokumentu.' : `Akapit ${i} ` + 'Neutralna treść dokumentu. '.repeat(50)}</p>`).join('') + '</body></html>' : fixture;
      return route.fulfill({status:200,contentType:'text/html',body});
    }
    if (url === 'https://other.fixture.test/') return route.fulfill({status:200,contentType:'text/html',body:'<p>Tekst obcej ramki niedostępnyobcy</p>'});
    if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return route.continue();
    await route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  id = worker.url().split('/')[2];
  const cdp = await context.browser().newBrowserCDPSession();
  version = (await cdp.send('Browser.getVersion')).product;
  const installed = (await cdp.send('Extensions.getExtensions')).extensions.find(e => e.id === id);
  assert.equal(installed.enabled, true);
  assert.equal(installed.path, extension);
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  assert.ok(commands.some(c => c.name === '_execute_action' && c.shortcut));
  record('C01/C02: MV3 worker, installed unpacked extension, shortcut registered', { version, commands });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  // The bar is an extension frame inside a closed shadow root: the tool finds it in the frame list, the
  // page cannot. Locators resolve the current bar on every call, because each opening is a new frame.
  const barFrame = () => page.frames().filter(frame => frame.url() === `chrome-extension://${id}/bar.html`).at(-1);
  const lazy = selector => new Proxy({}, { get: (_, name) => { const locator = barFrame().locator(selector); const value = locator[name]; return typeof value === 'function' ? value.bind(locator) : value; } });
  const ui = { locator: selector => barFrame().locator(selector), getByRole: (...args) => barFrame().getByRole(...args) };
  const input = lazy('input[aria-label="Szukaj na stronie"]');
  const count = lazy('.count'), status = lazy('.status');
  const until = async (read, predicate, timeout = 5000) => { const end = Date.now() + timeout; let value; while (Date.now() < end) { value = await read().catch(() => undefined); if (predicate(value)) return value; await sleep(40); } throw new Error(`Timed out; last value: ${value}`); };
  // The status line stays empty until the content script accepts the bar's session.
  const waitForBar = async () => { await until(async () => barFrame() ? await barFrame().locator('.status').textContent() : '', Boolean); };
  const action = async () => {
    await page.bringToFront();
    const {targetInfos} = await cdp.send('Target.getTargets', {filter:[{type:'tab',exclude:false}]});
    const tab = targetInfos.find(t => t.url === page.url());
    assert.ok(tab, 'tab target exists');
    await cdp.send('Extensions.triggerAction', {id,targetId:tab.targetId});
  };
  const text = () => page.evaluate(() => document.body.innerText);
  const highlights = () => page.evaluate(() => {
    const docs = new Set([document]);
    function visit(root) { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) visit(el.shadowRoot); if (el.tagName === 'IFRAME') { try { if (el.contentDocument) {docs.add(el.contentDocument); visit(el.contentDocument);} } catch {} } } }
    visit(document);
    const ranges=[];
    for(const doc of docs) for(const range of doc.defaultView.CSS.highlights.get('jev-find-active') || []) ranges.push(range.toString());
    return ranges;
  });
  const idle = async () => { await page.waitForTimeout(650); };
  // Playwright clips the image at the scrollY it read just before capturing; an ongoing smooth
  // scroll in between displaces the fixed bar in the picture. Capture only a settled page.
  const capture = async (target, name) => {
    if (process.env.JEV_QA_CAPTURE !== '1') return;
    let last = null, stable = 0;
    for (let i = 0; i < 100 && stable < 5; i += 1) { const y = await target.evaluate(() => scrollY); stable = y === last ? stable + 1 : 0; last = y; await target.waitForTimeout(60); }
    const before = await target.evaluate(() => scrollY);
    await target.screenshot({ path: path.join(qa, name), caret: 'initial' });
    const after = await target.evaluate(() => scrollY);
    assert.equal(after, before, `${name}: page scrolled during capture`);
    captures.push({ name, scrollY: before });
  };
  const setKey = async value => { await options.locator('#api-key').fill(value); await options.locator('button[type=submit]').click(); await options.waitForFunction(() => document.querySelector('#status').textContent === 'Ustawienia zapisane.'); };
  const setDomains = async value => { await options.locator('#excluded-domains').fill(value); await options.locator('button[type=submit]').click(); await idle(); };
  const waitStatus = pattern => until(() => status.textContent(), value => new RegExp(pattern, 'i').test(value || ''), 30000);
  await page.goto('https://jev-find.test/');
  const original = await text();
  await action(); await waitForBar();
  await waitStatus('klucz');
  await input.fill('igła');
  await until(() => count.textContent(), value => value === '1/3');
  await page.waitForFunction(() => window.scrollY > 400);
  assert.equal((await highlights()).length, 1);
  // Navigation runs in the content script; the counter comes back over the bar's port.
  const expectCount = value => until(() => count.textContent(), actual => actual === value);
  await input.press('ArrowDown'); await expectCount('2/3');
  await input.press('ArrowUp'); await expectCount('1/3');
  await ui.getByRole('button',{name:'Następne trafienie',exact:true}).click(); await expectCount('2/3');
  await ui.getByRole('button',{name:'Poprzednie trafienie',exact:true}).click(); await expectCount('1/3');
  await input.focus(); await input.press('End'); await input.press('ArrowLeft');
  assert.equal(await input.evaluate(el => el.selectionStart), 'igła'.length - 1);
  assert.equal(await count.textContent(),'1/3');
  await idle(); assert.equal(calls.length,0);
  record('C04/C06/C07: literal without key scrolls, highlights and navigates; left edits, no API');
  for (const query of ['fraza przez markup','żółw','İSTANBUL','widocznaakcja','edytowalnytekst','cieńznaleziony','ramkatekst','zagnieżdżonaramka']) {
    await input.fill(query); await until(() => count.textContent(), value => value && value !== '0/0').catch(() => {}); assert.notEqual(await count.textContent(),'0/0',query);
    assert.ok((await highlights()).some(t => t.toLocaleLowerCase().includes(query.toLocaleLowerCase())),query+' actual range');
  }
  for (const query of ['sekretnawartość','ukrytytekst','ukrytycień','ukrytaramka','niedostępnyobcy']) { await input.fill(query); await waitStatus('Nie znaleziono'); assert.equal(await count.textContent(),'0/0',query); }
  record('C03/C14: inline markup, Unicode, button, editor, shadow and frames; hidden/form text excluded');
  await input.fill('igła'); await idle();
  await capture(page, 'desktop.png');
  await page.setViewportSize({width:360,height:760});
  await capture(page, 'narrow.png');
  assert.ok(await page.locator('[data-jev-find]').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
  await page.setViewportSize({width:1280,height:800});
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-jev-find]',{state:'detached'});
  assert.equal(await page.locator('[data-jev-find]').count(),0);
  assert.deepEqual(await highlights(),[]);
  assert.equal(await text(),original);
  record('C10/C14: close cleans only own decorations; desktop and narrow screenshots');
  await action(); await waitForBar(); await action();
  await page.waitForSelector('[data-jev-find]',{state:'detached'});
  assert.equal(await page.locator('[data-jev-find]').count(),0);
  await action(); await waitForBar();
  assert.equal(await page.locator('[data-jev-find]').count(),1);
  record('C02: repeated action has a single bar');
  await input.fill('opis odpoczynku');
  await setKey(key);
  await waitStatus('^Najlepsze dopasowanie');
  assert.equal(await count.textContent(),'1/1');
  assert.ok((await highlights()).some(t => t.includes('[GOOD]')));
  assert.ok(calls.every(c => c.syntheticAuth));
  assert.ok(calls.some(c => c.stage === 'initial') && calls.some(c => c.stage === 'confirm'));
  const sentText = calls.map(c => c.texts.join('\n')).join('\n');
  for(const excluded of ['sekretnawartość','ukrytytekst','ukrytycień','ukrytaramka','niedostępnyobcy']) assert.ok(!sentText.includes(excluded),excluded+' not sent');
  record('C05/C06/C15: adding key updates open bar and both API stages use synthetic Bearer');
  await setDomains('unrelated.test');
  assert.equal(await worker.evaluate(async () => Boolean((await chrome.storage.local.get('apiKey')).apiKey)),true);
  assert.equal(await options.locator('#api-key').inputValue(),'');
  const tabId = await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://jev-find.test/'}))[0].id);
  const storageAccess = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({target:{tabId},func:async()=> {try {await chrome.storage.local.get('apiKey');return 'allowed';}catch {return 'denied';}}}))[0].result,tabId);
  assert.equal(storageAccess,'denied');
  assert.equal(await page.evaluate(() => window.__JEV_FIND__),undefined);
  record('C15/C17: domains-only save preserves key, content storage denied, no key returned to page');
  await input.fill('igła'); await waitStatus('Dosłowne trafienia'); await idle();
  assert.equal(await count.textContent(),'1/3');
  assert.equal(await ui.locator('[data-kind=closest]').count(),0);
  record('C08: literal first, semantic overlap deduplicated');
  await input.fill('nigdzie'); await waitStatus('Nie znaleziono');
  assert.equal(await count.textContent(),'0/0');
  const beforePossible = await page.evaluate(() => {window.scrollTo(0,0);return scrollY;});
  await input.fill('częściowo'); await waitStatus('pewnego dopasowania');
  assert.equal(await page.evaluate(() => scrollY),beforePossible);
  await ui.getByRole('button',{name:'Pokaż najbliższe',exact:true}).click();
  assert.ok((await highlights()).some(t => t.includes('[MAYBE]')));
  assert.equal(await count.textContent(),'1/1');
  record('C09: absent succeeds, uncertain has no automatic jump, nearest opens consciously');
  mode='service'; await input.fill('igła'); await waitStatus('nie powiodło|niedostęp|usług');
  assert.notEqual(await count.textContent(),'0/0');
  mode='normal'; await setKey('JEV-BAD-FIXTURE'); await waitStatus('klucz|autoryzac');
  assert.notEqual(await count.textContent(),'0/0');
  await setKey(key); await waitStatus('Dosłowne trafienia');
  mode='retry'; retryCount=0; await input.fill('opis odpoczynku'); await waitStatus('^Najlepsze dopasowanie');
  assert.ok(retryCount>=2); mode='normal';
  record('C04/C09: service and authorization errors differ; literal survives, key repair and 429 retry recover');
  const start = calls.length;
  await input.fill(''); await idle(); assert.equal(calls.length,start);
  await input.fill('szybka'); await input.fill('nowa odpowiedź');
  await waitStatus('^Najlepsze dopasowanie');
  assert.equal(calls.slice(start).some(c=>c.query==='szybka'),false);
  assert.ok((await highlights()).some(t=>t.includes('[NEW]')));
  mode='slow'; await input.fill('stara odpowiedź');
  await page.waitForTimeout(550);
  mode='normal'; await input.fill('nowa odpowiedź'); await waitStatus('^Najlepsze dopasowanie');
  await page.waitForTimeout(1300);
  assert.ok((await highlights()).some(t=>t.includes('[NEW]')));
  record('C05/C11: empty and superseded typing suppress API; old reply cannot replace new result');
  mode='slow'; await input.fill('stara odpowiedź'); await page.waitForTimeout(550);
  await page.evaluate(() => { document.getElementById('good').firstChild.data='[GOOD] Akapit zmieniony po wysłaniu zapytania.'; const p=document.createElement('p');p.textContent='Nowa treść po doczytaniu';p.id='dynamic';document.body.append(p);});
  await waitStatus('zmieniła'); await page.waitForTimeout(1300);
  assert.equal(await count.textContent(),'0/0'); assert.deepEqual(await highlights(),[]);
  mode='normal'; await ui.getByRole('button',{name:'Odśwież',exact:true}).click();
  await waitStatus('^Najlepsze dopasowanie'); assert.ok((await highlights()).some(t => t.includes('Akapit zmieniony')));
  await input.fill('Nowa treść po doczytaniu'); assert.notEqual(await count.textContent(),'0/0');
  await idle(); assert.ok(!(await status.textContent()).includes('zmieniła'));
  record('C11/C12: answer for text edited in flight is discarded; refresh and new input see current text; own decorations ignored');
  mode='slow'; await input.fill('stara odpowiedź'); await page.waitForTimeout(550);
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-jev-find]',{state:'detached'}); await page.waitForTimeout(1300);
  assert.equal(await page.locator('[data-jev-find]').count(),0); assert.deepEqual(await highlights(),[]);
  mode='normal';
  record('C10/C11: close during request prevents later effects');
  await page.goto('https://jev-find.test/long'); await action(); await waitForBar();
  const longStart=calls.length;
  await input.fill('koniec dokumentu'); await waitStatus('^Najlepsze dopasowanie');
  assert.ok((await highlights()).some(t=>t.includes('[LAST]')));
  const initial=calls.slice(longStart).filter(c=>c.stage==='initial');
  assert.ok(initial.length>1);
  assert.equal(new Set(initial.flatMap(c=>c.ids)).size,246);
  assert.ok(calls.slice(longStart).every(c=>c.bytes<=27000));
  record('C13: every long-document ID sent; last batch match returns; actual payload byte budget',{batches:initial.length,ids:246});
  await setDomains('jev-find.test');
  if(await input.count()) assert.equal(await input.isDisabled(),true);
  const excludedCalls=calls.length; await idle(); assert.equal(calls.length,excludedCalls);
  await page.goto('https://sub.jev-find.test/'); await action();
  assert.equal(await page.locator('[data-jev-find]').count(),0);
  await page.goto('https://jev-find.test.evil.test/'); await action(); await waitForBar();
  record('C16: live exclusion invalidates bar, subdomain blocked, similar foreign hostname allowed');
  await setDomains('');
  await options.locator('#remove-key').click();
  await input.fill('igła'); await idle();
  assert.notEqual(await count.textContent(),'0/0');
  assert.equal(await options.locator('#remove-key').isVisible(),false);
  const noKeyStart=calls.length; await idle(); assert.equal(calls.length,noKeyStart);
  record('C15: remove key immediately leaves working literal search and stops API');
  await capture(options, 'options.png');
  assert.ok((await options.locator('body').innerText()).includes('kosztem'));
  const storageKeys=await worker.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)));
  assert.deepEqual(storageKeys.sort(),['apiKey','excludedDomains']);
  record('C17: options disclose transfer/cost; only local settings, no query history',{storageKeys});
  await page.goto('chrome://extensions/shortcuts');
  await page.getByRole('heading',{name:'JEV Find',exact:true,level:2}).waitFor();
  record('C02: shortcut configurable in native browser page');
  await page.goto('https://jev-find.test/pdf'); await action();
  const pdf = await worker.evaluate(async()=> { const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); for(let i=0;i<100;i++){ if(await chrome.action.getBadgeText({tabId:tab.id})==='PDF') return await chrome.action.getTitle({tabId:tab.id}); await new Promise(resolve=>setTimeout(resolve,20)); } return ''; });
  assert.ok(pdf.includes('PDF')); assert.equal(await page.locator('[data-jev-find]').count(),0);
  record('C18: PDF embed surface explicitly unavailable without content injection',{title:pdf});
  await page.goto('chrome://version'); await action();
  await worker.evaluate(async()=> { const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); for(let i=0;i<100;i++){ if(await chrome.action.getBadgeText({tabId:tab.id})==='!') return; await new Promise(resolve=>setTimeout(resolve,20)); } });
  const unsupported=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return {title:await chrome.action.getTitle({tabId:tab.id}),badge:await chrome.action.getBadgeText({tabId:tab.id})};});
  assert.equal(unsupported.badge,'!'); assert.ok(unsupported.title.includes('niedostępna'));
  record('C18: protected browser surface shows explicit unavailable action title/badge',unsupported);
  assert.deepEqual(errors,[]);
  record('No page errors, no provider network, no runtime dependencies');
} catch(error) {
  errors.push(error.stack);
  for(const p of context.pages()) { console.error({url:p.url(),ui:await p.evaluate(()=>document.body?.innerText.slice(0,2500)).catch(()=>''),settingsStatus:await p.evaluate(()=>document.querySelector('#status')?.textContent).catch(()=>null),barStatus:await (p.frames().filter(frame => frame.url().endsWith('/bar.html')).at(-1)?.locator('.status').textContent({ timeout: 500 }) ?? Promise.resolve(null)).catch(()=>null)}); }
  console.error(error);
  process.exitCode=1;
} finally {
  await fs.writeFile(path.join(qa,'last-run.json'),JSON.stringify({date:new Date().toISOString(),extension,version,playwright:playwrightVersion,id,checks,errors,captures,calls:calls.map(({texts,...rest})=>rest),providerNetwork:'All requests fulfilled locally; DNS disabled; synthetic key only.'},null,2)+'\n');
  await context.close();
  await fs.rm(profile,{recursive:true,force:true});
}
