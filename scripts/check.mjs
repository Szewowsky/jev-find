import { readdir, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'extension');
for (const name of await readdir(dir)) {
  if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(dir, name)], { stdio: 'inherit' });
}
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest musi mieć wersję 3.');
// The bar page is the only web-accessible resource; it loads its own script, module and styles.
const files = [manifest.background.service_worker, manifest.options_ui.page, 'content.js', 'budget.js', 'bar.js', 'bar.css', 'gate.js', ...manifest.web_accessible_resources.flatMap(entry => entry.resources), ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {})];
if (JSON.stringify(manifest.web_accessible_resources.flatMap(entry => entry.resources)) !== JSON.stringify(['bar.html'])) throw new Error('Nieoczekiwane zasoby dostępne z sieci.');
for (const name of files) await access(path.join(dir, name));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://api.typesafe.ai/*'])) throw new Error('Nieoczekiwane uprawnienia hostów.');
console.log('Składnia i pliki manifestu: OK.');
