import { normalizeDomain } from './core.js';

const STORAGE_DEFAULTS = { apiKey: '', excludedDomains: [] };
const form = document.querySelector('#settings-form');
const keyInput = document.querySelector('#api-key');
const keyLabel = document.querySelector('#api-key-label');
const keyState = document.querySelector('#key-state');
const keyStateText = document.querySelector('#key-state-text');
const removeRow = document.querySelector('#remove-row');
const removeKeyButton = document.querySelector('#remove-key');
const domainsInput = document.querySelector('#excluded-domains');
const domainsCount = document.querySelector('#domains-count');
const status = document.querySelector('#status');
let hasSavedKey = false;

function report(message, kind = 'success') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function renderKeyState(hasKey) {
  hasSavedKey = hasKey;
  keyState.dataset.state = hasKey ? 'saved' : 'missing';
  keyStateText.textContent = hasKey ? 'Zapisany' : 'Brak klucza';
  removeRow.hidden = !hasKey;
  keyLabel.textContent = hasKey ? 'Zastąp klucz' : 'Wklej klucz';
  keyInput.placeholder = hasKey ? 'Wklej nowy klucz' : 'Wklej klucz API';
}

function renderDomainsCount() {
  domainsCount.textContent = String(parseDomains(domainsInput.value).domains.length);
}

// macOS reports "⌥⇧F", other systems "Alt+Shift+F".
function shortcutKeys(shortcut) {
  if (shortcut.includes('+')) return shortcut.split('+');
  const keys = [];
  let rest = shortcut;
  while (rest && '⌃⌥⇧⌘'.includes(rest[0])) { keys.push(rest[0]); rest = rest.slice(1); }
  return rest ? [...keys, rest] : keys;
}

// Shows the shortcut the browser actually uses, including one the user changed.
async function renderShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === '_execute_action')?.shortcut || '';
  for (const target of document.querySelectorAll('[data-shortcut]')) {
    const parts = shortcut ? shortcutKeys(shortcut).map((key) => Object.assign(document.createElement('kbd'), { textContent: key })) : [document.createTextNode('nie ustawiono')];
    target.replaceChildren(...parts);
  }
}

async function prepareStorage() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
}

function parseDomains(value) {
  const entries = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const domains = [];
  const invalid = [];
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!domain) invalid.push(entry);
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, invalid };
}

async function loadSettings() {
  await prepareStorage();
  const { apiKey, excludedDomains } = await chrome.storage.local.get(STORAGE_DEFAULTS);
  renderKeyState(Boolean(apiKey));
  domainsInput.value = Array.isArray(excludedDomains) ? excludedDomains.join('\n') : '';
  renderDomainsCount();
  form.querySelector('button[type=submit]').disabled = false;
}

domainsInput.addEventListener('input', renderDomainsCount);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { domains, invalid } = parseDomains(domainsInput.value);
  if (invalid.length) {
    report(`Nie rozpoznaję tej domeny: ${invalid[0]}`, 'error');
    domainsInput.focus();
    return;
  }

  try {
    const next = { excludedDomains: domains };
    const newKey = keyInput.value.trim();
    if (newKey) next.apiKey = newKey;
    await chrome.storage.local.set(next);
    keyInput.value = '';
    renderKeyState(Boolean(newKey) || hasSavedKey);
    domainsInput.value = domains.join('\n');
    renderDomainsCount();
    report('Ustawienia zapisane.');
  } catch {
    report('Nie udało się zapisać ustawień. Spróbuj ponownie.', 'error');
  }
});

removeKeyButton.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ apiKey: '' });
    keyInput.value = '';
    renderKeyState(false);
    report('Zapisany klucz został usunięty.');
  } catch {
    report('Nie udało się usunąć klucza. Spróbuj ponownie.', 'error');
  }
});

document.querySelector('#shortcut-link').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

document.querySelector('#version').textContent = chrome.runtime.getManifest().version;
renderShortcut().catch(() => {});
loadSettings().catch(() => report('Nie udało się wczytać ustawień przeglądarki.', 'error'));
