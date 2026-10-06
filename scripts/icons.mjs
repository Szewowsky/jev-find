// Renders the extension icons from SVG in headless Chromium: icon16 from its pixel-grid drawing, the rest from the master.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JEV_PLAYWRIGHT_MODULE || 'playwright');
const icons = path.join(root, 'extension/icons');
const sources = { 16: 'source-16.svg', 32: 'source.svg', 48: 'source.svg', 128: 'source.svg' };
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
try {
  for (const [size, file] of Object.entries(sources)) {
    const svg = await readFile(path.join(icons, file), 'utf8');
    const page = await browser.newPage({ viewport: { width: +size, height: +size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`);
    // Transparent outside the tile, so the rounded corners blend with any toolbar.
    await page.screenshot({ path: path.join(icons, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: +size, height: +size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Ikony 16, 32, 48 i 128 px w extension/icons.');
