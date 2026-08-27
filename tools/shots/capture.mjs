/**
 * Visual validation harness.
 *
 * Loads XBAM at several viewports with a real session token and writes
 * screenshots to var/shots. Console errors are collected and reported so a
 * silent runtime failure cannot pass as a good-looking page.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173';
const TOKEN = process.env.SHOT_TOKEN ?? '';
const OUT = 'var/shots';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'ultrawide', width: 2200, height: 1000 },
];

const PAGES = JSON.parse(process.env.SHOT_PAGES ?? '[["home","/"],["activity","/activity"],["settings","/settings"],["create","/agents/new"]]');

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: process.env.SHOT_REDUCED === '1' ? 'reduce' : 'no-preference',
  });
  await context.addInitScript((token) => {
    if (token) window.localStorage.setItem('ai17z.session', token);
  }, TOKEN);

  for (const [name, path] of PAGES) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(1200);
      const suffix = process.env.SHOT_REDUCED === '1' ? '-reduced' : '';
      await page.screenshot({ path: `${OUT}/${name}-${viewport.name}${suffix}.png`, fullPage: false });
      if (errors.length) problems.push({ page: name, viewport: viewport.name, errors });
    } catch (error) {
      problems.push({ page: name, viewport: viewport.name, errors: [String(error).split('\n')[0]] });
    }
    await page.close();
  }
  await context.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(problems, null, 2));
if (problems.length === 0) console.log('All screens rendered with no console errors.');
else {
  console.log(`${problems.length} screen(s) reported console errors:`);
  for (const p of problems) console.log(`  ${p.page} @ ${p.viewport}: ${p.errors.slice(0, 2).join(' | ')}`);
}
