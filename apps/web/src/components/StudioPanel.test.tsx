import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { StudioPanel } from './StudioPanel';

(globalThis as { React?: unknown }).React = React;
const fixture = vi.hoisted(() => ({ state: 'NOT_LINKED' }));
vi.mock('../lib/hooks', () => ({
  useResource: () => ({ data: { state: fixture.state, origin: 'https://ai17z.io', pending: { userCode: 'BCDF-GHJK', verificationUri: 'https://ai17z.io/connect', verificationUriComplete: 'https://ai17z.io/connect?code=BCDF-GHJK', expiresAt: '2030-01-01' } }, reload: vi.fn() }),
  useElapsed: () => 0,
  usePolling: vi.fn(),
}));
beforeEach(() => { fixture.state = 'NOT_LINKED'; });
it('offers the public Studio directly when a fresh install has no registry address', () => {
  fixture.state = 'NOT_CONFIGURED';
  expect(renderToStaticMarkup(React.createElement(StudioPanel))).toContain('Link to ai17z.io');
});
it('explains the payoff before asking the owner to link', () => {
  const html = renderToStaticMarkup(React.createElement(StudioPanel));
  expect(html).toContain('Link this installation for browser control, live view and your Studio plugins, with each permission kept off until you enable it.');
});
it('labels the prefilled approval link and explains the return to this tab', () => {
  fixture.state = 'PENDING';
  const html = renderToStaticMarkup(React.createElement(StudioPanel));
  expect(html).toContain('Open Studio to approve');
  expect(html).toContain('The code is filled in for you');
  expect(html).toContain('Return to this tab');
  expect(html).toContain('https://ai17z.io/connect?code=BCDF-GHJK');
});
