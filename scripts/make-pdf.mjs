// Renders site/print.html to site/sib-nyc-trip-backup.pdf with headless Chromium (run in GitHub Actions).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../site/', import.meta.url).pathname;
const OUT = join(ROOT, 'sib-nyc-trip-backup.pdf');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, path);
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto('http://localhost:4173/print.html');
await page.waitForFunction(() => window.__printDone || window.__printError, null, { timeout: 300000 });
const err = await page.evaluate(() => window.__printError);
if (err) { console.error(err); process.exit(1); }
await page.pdf({ path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true });
console.log('PDF written:', OUT);
await browser.close();
server.close();
