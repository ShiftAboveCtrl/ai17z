import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const mediaResolve = readFileSync(resolve(root, 'packages/runtime/src/mediaResolve.ts'), 'utf8');
const xAdapter = readFileSync(resolve(root, 'packages/channels/src/x/index.ts'), 'utf8');
const gateway = readFileSync(resolve(root, 'packages/models/src/gateway.ts'), 'utf8');

/**
 * Two invariants that are load-bearing and were resting on nothing.
 *
 * Both are the same shape of mistake: a request routed to the wrong resource
 * still succeeds, and produces a confident answer about something it never
 * looked at. Neither fails loudly, which is exactly why they need a test rather
 * than a comment.
 */
describe('an image is only ever sent to something that can see', () => {
  it('asks for the vision role by name', () => {
    expect(mediaResolve).toMatch(/role: 'vision'/);
  });

  it('never falls back to another role when there is no vision model', () => {
    // Falling back sends an image to a model that cannot read it, and gets back
    // a fluent description of nothing. An unread image is a gap the prompt is
    // required to state; a fabricated one is a lie nobody can see.
    const asks = mediaResolve.slice(mediaResolve.indexOf("role: 'vision'") - 600, mediaResolve.indexOf("role: 'vision'") + 600);
    expect(asks).not.toMatch(/role: 'primary'/);
    expect(asks).not.toMatch(/role: 'fallback/);
  });

  it('checks a vision model exists before trying', () => {
    expect(mediaResolve).toMatch(/c\.role === 'vision'/);
  });

  it('honours a single requested role rather than walking the fallback chain', () => {
    // The gateway is where a role request could quietly widen. `only` must
    // produce a one-role order, not a starting point in the chain.
    expect(gateway).toMatch(/const order = only \? \[only\] : FALLBACK_ORDER/);
  });
});

describe('looking things up never touches the tab that posts', () => {
  it('uses the RESEARCH role for the web search', () => {
    expect(xAdapter).toMatch(/withSession\(ctx, 'RESEARCH'/);
  });

  it('does not do its searching on the action tab', () => {
    // The action tab is where a reply is verified and sent. A monitor or a
    // search navigating it is how an automation replies to whatever happened
    // to be loaded.
    const search = xAdapter.slice(xAdapter.indexOf("withSession(ctx, 'RESEARCH'"));
    const nextSession = search.indexOf('withSession(ctx,', 1);
    const body = nextSession === -1 ? search : search.slice(0, nextSession);
    expect(body).not.toMatch(/'ACTION'/);
  });
});
