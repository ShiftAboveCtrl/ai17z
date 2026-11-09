import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';

/** Render the shipped component and CSS, with fixture data and no running account. */
describe('signal radar at desktop and mobile sizes', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    const tailwindConfig = (await import(pathToFileURL(resolve('apps/web/tailwind.config.js')).href)).default;
    const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below', threshold: 10000 };
    const before = { value: 12500, source: 'GeckoTerminal fixture', observedAt: '2026-11-09T09:00:00Z', definition: 'Median USD pool liquidity, provider top 20. Coverage is bounded.' };
    const after = { ...before, value: 7300, observedAt: '2026-11-09T09:05:00Z' };
    const data = {
      baselines: [{ sourceId: 'source', watchKey: 'watch', watch, state: { baseline: before, latest: after, active: true, generation: 1 }, lastRead: { ...after, value: null }, reason: 'Reading unavailable; retained baseline unchanged. Condition remains latched.' }],
      candidates: [{ id: 'candidate', sourceId: 'source', evidence: { watch, before, after }, reason: 'In idea backlog; posting gates have not run.', ideaStatus: 'unused', ideaError: null, jobStatus: null, jobError: null }],
    };
    const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signal radar verification</title></head><body><main id="root" style="max-width:1120px;margin:auto;padding:24px"></main><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {SignalRadar} from '/src/components/SignalRadar.tsx'; import '/src/styles.css';
      createRoot(document.getElementById('root')).render(React.createElement(SignalRadar, {accountId:'fixture', source:${JSON.stringify({ id: 'source', config: { watches: [watch], mayTrigger: false } })}, data:${JSON.stringify(data)},reload:()=>{document.body.dataset.saved='true'}}));
    </script></body></html>`;
    server = await createServer({
      root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'),
      server: { port: 41920 + process.pid % 10000, host: '127.0.0.1', open: false, strictPort: true, watch: null, hmr: false },
      css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [resolve('apps/web/src/**/*.{ts,tsx}').replaceAll('\\', '/')] })] } },
      plugins: [{ name: 'signal-test-page', configureServer(s) {
        s.middlewares.use('/__signal-test', (_req, res, next) => {
          void s.transformIndexHtml('/__signal-test.html', html).then(page => {
            res.setHeader('Content-Type', 'text/html'); res.end(page);
          }).catch(next);
        });
      } }],
    });
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    await mkdir('.screenshots', { recursive: true });
  });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  it.each([1440, 390])('AC6 configuration and before/after evidence remain readable at %i px', async width => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${origin}/__signal-test`);
      await page.getByRole('heading', { name: 'Market and wallet signals' }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByText('Unavailable', { exact: true }).isVisible()).toBe(true);
      expect(await page.getByText('12500', { exact: true }).last().isVisible()).toBe(true);
      expect(await page.getByText('7300', { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole('checkbox').isChecked()).toBe(false);
      const fields = await page.locator('input:not([type=radio]):not([type=checkbox]), button').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().height));
      expect(fields.every(height => height >= 48)).toBe(true);
      await page.screenshot({ path: `.screenshots/signal-radar-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
      await page.getByRole('textbox', { name: 'Exact mint or address' }).fill('$SOL');
      await page.getByRole('button', { name: 'Add owner pin' }).click();
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').innerText()).toContain('exact mint');
      await page.route('**/api/accounts/fixture/radar', route => route.fulfill({ json: { ok: true, data: {} } }));
      await page.getByRole('textbox', { name: 'Exact mint or address' }).fill('11111111111111111111111111111111');
      await page.getByRole('button', { name: 'Add owner pin' }).click();
      await page.waitForFunction(() => document.body.dataset.saved === 'true');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
