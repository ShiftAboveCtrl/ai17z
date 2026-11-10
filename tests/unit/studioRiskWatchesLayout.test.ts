import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';

/** The shipped Studio risk watch screens, rendered with fixture data, at desktop and phone width. */
describe('Studio risk watch screens at desktop and mobile sizes', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    const tailwindConfig = (await import(pathToFileURL(resolve('apps/web/tailwind.config.js')).href)).default;
    const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below', threshold: 10000, studioMetric: 'LIQUIDITY_BELOW' };
    const before = { value: 12500, source: 'jupiter', observedAt: '2026-11-09T09:00:00Z', definition: 'Index liquidity in USD across the token pools. This is not a safety rating.' };
    const after = { ...before, value: 7300, observedAt: '2026-11-09T09:05:00Z' };
    const data = {
      baselines: [{ sourceId: 's', watchKey: 'w', watch, state: null, lastRead: before, reason: 'Waiting for a second valid reading.', provenance: 'STUDIO_RISK_WATCH' }],
      candidates: [{ id: 'c', sourceId: 's', provenance: 'STUDIO_RISK_WATCH', evidence: { watch, before, after }, reason: 'Context only; posting candidates are switched off.', ideaStatus: null, ideaError: null, jobStatus: null, jobError: null }],
    };
    const base = { lastPollAt: null, lastSuccessAt: null, lastResultAt: null, idleReason: null, consecutiveFailures: 0, nextPollAt: null, enabled: true, status: 'HEALTHY', kind: 'market_signal', config: { mayTrigger: false } };
    const studioSource = { ...base, id: 'a', provenance: 'STUDIO_RISK_WATCH', label: 'Studio risk watch: LIQUIDITY_BELOW', target: 'studio-risk:binding:watch:revision' };
    const ownerSource = { ...base, id: 'b', provenance: 'OWNER', label: 'Market and wallet signals', target: null };
    const bound = { binding: { accountId: 'acc', enabled: true, mayTrigger: false, syncedAt: '2026-11-09T09:00:00Z', expiresAt: null, lastError: null }, pendingObservations: 1 };
    const view = (props: object) => `React.createElement(V, ${JSON.stringify({ accountId: 'acc', loading: false, error: null, saving: false, problem: null, ...props })})`;
    const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio risk watch verification</title></head><body><main id="root" style="max-width:720px;margin:auto;padding:16px"></main><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {SignalEvidence} from '/src/components/SignalRadar.tsx'; import {RadarSourceItem} from '/src/components/RadarPanel.tsx';
      import {StudioRiskWatchesView as V} from '/src/components/StudioRiskWatchesPanel.tsx'; import '/src/styles.css';
      const noop = () => undefined;
      createRoot(document.getElementById('root')).render(React.createElement('div', {className:'space-y-6'},
        React.createElement('ul', null,
          React.createElement(RadarSourceItem, {source:${JSON.stringify(studioSource)}, busy:false, onRetry:noop, onRemove:noop}),
          React.createElement(RadarSourceItem, {source:${JSON.stringify(ownerSource)}, busy:false, onRetry:noop, onRemove:noop})),
        React.createElement(SignalEvidence, {data:${JSON.stringify(data)}}),
        ${view({ status: { binding: null, pendingObservations: 0 } })},
        ${view({ status: bound })},
        ${view({ status: null, loading: true })},
        ${view({ status: null, error: 'The API did not answer, so the Studio risk watch settings could not be read at all. ' + 'x'.repeat(90) })},
        ${view({ status: bound, saving: true, problem: 'Link this installation to Studio first, then turn this on again.' })}));
    </script></body></html>`;
    server = await createServer({
      root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'),
      server: { port: 43920 + process.pid % 10000, host: '127.0.0.1', open: false, strictPort: true, watch: null, hmr: false },
      css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [resolve('apps/web/src/**/*.{ts,tsx}').replaceAll('\\', '/')] })] } },
      plugins: [{ name: 'risk-test-page', configureServer(s) {
        s.middlewares.use('/__risk-test', (_req, res, next) => {
          void s.transformIndexHtml('/__risk-test.html', html).then(page => {
            res.setHeader('Content-Type', 'text/html'); res.end(page);
          }).catch(next);
        });
      } }],
    });
    await server.listen();
    origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
    await mkdir('.screenshots', { recursive: true });
  });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  it.each([1440, 390])('shows provenance, reasons and every opt-in state without overflow at %i px', async width => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${origin}/__risk-test`);
      await page.getByRole('heading', { name: 'Retained baselines' }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByText('From your Studio risk watch list.').count()).toBeGreaterThanOrEqual(3);
      // The Studio source has no remove control; the owner's has one.
      expect(await page.getByRole('button', { name: /^Remove / }).count()).toBe(1);
      expect(await page.getByText(/follows your Studio risk watch link/).isVisible()).toBe(true);
      expect(await page.getByText('Context only; posting candidates are switched off.').isVisible()).toBe(true);
      expect(await page.getByRole('switch').count()).toBe(6); // two per loaded view; loading and error show none
      expect(await page.getByRole('button', { name: 'Try again' }).isVisible()).toBe(true);
      expect(await page.getByText('Loading your Studio risk watch settings').isVisible()).toBe(true);
      expect(await page.getByRole('alert').innerText()).toContain('Link this installation to Studio first');
      const clipped = await page.locator('p, h3, h4, span').evaluateAll(els => els.filter(e => e.getBoundingClientRect().right > innerWidth + 1).length);
      expect(clipped).toBe(0);
      await page.screenshot({ path: `.screenshots/studio-risk-watches-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
