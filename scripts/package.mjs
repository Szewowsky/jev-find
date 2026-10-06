import { mkdir, rm, cp, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Nieprawidłowa wersja manifestu.');
execFileSync(process.execPath, ['--test', ...['core.test.js', 'gate.test.js', 'budget.test.js', 'background.test.js'].map(name => path.join(root, 'tests', name))], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { stdio: 'inherit' });
const dist = path.join(root, 'dist');
const staged = path.join(dist, 'JEV-Find');
const zip = path.join(dist, `jev-find-${manifest.version}.zip`);
await mkdir(dist, { recursive: true });
await rm(staged, { recursive: true, force: true });
await rm(zip, { force: true });
await mkdir(path.join(staged, 'icons'), { recursive: true });
// Only runtime files cross the distribution boundary; no profile or test data.
const files = ['manifest.json', 'background.js', 'core.js', 'budget.js', 'content.js', 'bar.html', 'bar.css', 'bar.js', 'gate.js', 'options.html', 'options.css', 'options.js', ...new Set(Object.values(manifest.icons))];
for (const file of files) await cp(path.join(root, 'extension', file), path.join(staged, file));
// Every module import and every script or stylesheet of a packaged page must be packaged too.
for (const file of files.filter(name => /\.(js|html)$/.test(name))) {
  const source = await readFile(path.join(staged, file), 'utf8');
  const references = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.\/[^'"]+)['"]|<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match => match[1] || match[2]);
  for (const reference of references) await access(path.join(staged, path.dirname(file), reference)).catch(() => { throw new Error(`${file} odwołuje się do ${reference}, którego nie ma w paczce.`); });
}
await cp(path.join(root, 'INSTALL.md'), path.join(staged, 'PRZECZYTAJ.md'));
execFileSync('zip', ['-q', '-r', zip, 'JEV-Find'], { cwd: dist });
execFileSync('unzip', ['-t', zip], { stdio: 'inherit' });
console.log(zip);
