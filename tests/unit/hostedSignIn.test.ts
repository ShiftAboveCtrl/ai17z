import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_STOP,
  CREDENTIAL_FORBIDDEN_PLACES,
  HOSTED_SIGNIN_ROUTES,
  REFUSED_SIGNIN_ROUTES,
  ROUTE_DESCRIPTIONS,
  credentialPlacement,
  defaultRoute,
  routeVerdict,
  signInCommitments,
} from '@xbam/runtime';

/**
 * The refusal that is easier to drop than to keep.
 *
 * A central store of every customer's password for somebody else's service is
 * the obvious way to make hosted sign-in convenient, so the test is written
 * against the refusals rather than against the happy path: if somebody deletes
 * one of these lists, this file fails before a reviewer has to notice.
 */

describe('the routes that exist', () => {
  it('has exactly two', () => {
    expect(HOSTED_SIGNIN_ROUTES).toEqual(['OWNER_DRIVES_STREAM', 'RUNTIME_HELD_CREDENTIAL']);
    expect(ROUTE_DESCRIPTIONS).toHaveLength(2);
  });

  it('defaults to the owner typing into the page themselves', () => {
    expect(defaultRoute()).toBe('OWNER_DRIVES_STREAM');
  });

  it('says where the credential lands for each', () => {
    for (const route of ROUTE_DESCRIPTIONS) {
      expect(route.credentialLands.length, route.route).toBeGreaterThan(30);
    }
  });

  it('says the default route stores the credential nowhere', () => {
    const owner = ROUTE_DESCRIPTIONS.find((r) => r.route === 'OWNER_DRIVES_STREAM')!;
    expect(owner.credentialLands).toMatch(/^Nowhere/);
  });

  it('says a stored credential stays on its own runtime under its own key', () => {
    const stored = ROUTE_DESCRIPTIONS.find((r) => r.route === 'RUNTIME_HELD_CREDENTIAL')!;
    expect(stored.credentialLands.toLowerCase()).toContain('never in the control plane');
    expect(stored.isDefault).toBe(false);
  });

  it('says what each route does not buy', () => {
    for (const route of ROUTE_DESCRIPTIONS) {
      expect(route.limits.length, route.route).toBeGreaterThanOrEqual(3);
    }
  });

  it('admits a stored password still needs a person when 2FA is on', () => {
    const stored = ROUTE_DESCRIPTIONS.find((r) => r.route === 'RUNTIME_HELD_CREDENTIAL')!;
    expect(stored.limits.join(' ')).toContain('still needs a person');
  });

  it('does not describe the stream as end to end encrypted', () => {
    // A frame rendered on a host and sent through a control plane is neither.
    const owner = ROUTE_DESCRIPTIONS.find((r) => r.route === 'OWNER_DRIVES_STREAM')!;
    expect(owner.limits.join(' ')).toContain('not end to end encrypted');
  });

  it('accepts a route that exists and refuses one that does not', () => {
    expect(routeVerdict('OWNER_DRIVES_STREAM').allowed).toBe(true);
    const out = routeVerdict('MAGIC_AUTO_LOGIN');
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('OWNER_DRIVES_STREAM');
  });
});

describe('the routes that are refused', () => {
  const all = REFUSED_SIGNIN_ROUTES.map((r) => `${r.proposal} ${r.why}`).join(' ').toLowerCase();

  it('refuses a central form collecting username, password and code', () => {
    expect(all).toContain('studio form collecting x username, password and 2fa code');
  });

  it('refuses a vault the control plane can read', () => {
    expect(all).toContain('vault the control plane can read');
  });

  it('refuses relaying a second factor code', () => {
    // Relaying it rather than typing it does not change what it is.
    expect(all).toContain('relaying');
    expect(all).toContain('does not change what it is');
  });

  it('refuses a CAPTCHA solver in any form', () => {
    expect(all).toContain('no solver, no bypass, no setting');
  });

  it("refuses importing a customer's session cookies", () => {
    expect(all).toContain('session cookies');
    expect(all).toContain('phishing');
  });

  it('refuses holding recovery or backup codes', () => {
    expect(all).toContain('recovery code');
    expect(all).toContain('concentrated it');
  });

  it("refuses anything that evades a service's own controls", () => {
    expect(all).toContain('evading a service');
  });

  it('gives every refusal a reason an owner would accept', () => {
    for (const refused of REFUSED_SIGNIN_ROUTES) {
      expect(refused.why.length, refused.proposal).toBeGreaterThan(60);
    }
  });
});

describe('where a credential may live', () => {
  it('refuses every place it has no business being', () => {
    for (const place of CREDENTIAL_FORBIDDEN_PLACES) {
      const out = credentialPlacement(`written to ${place}`);
      expect(out.ok, place).toBe(false);
    }
  });

  it('refuses the control plane database specifically', () => {
    const out = credentialPlacement('the control plane database');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('control plane database');
  });

  it('refuses browser_tasks.params, which is persisted in the clear', () => {
    expect(credentialPlacement('browser_tasks.params').ok).toBe(false);
  });

  it('refuses anything a model can see', () => {
    expect(credentialPlacement('prompt context or anything a model can see').ok).toBe(false);
  });

  it('accepts only the runtime own sealed store', () => {
    expect(credentialPlacement("sealed in the runtime's own database").ok).toBe(true);
    expect(credentialPlacement('encrypted on the runtime under its own key').ok).toBe(true);
  });

  it('refuses a destination nobody listed rather than allowing it', () => {
    // A new place nobody thought of is refused by default, which is the
    // opposite of how a denylist alone behaves.
    expect(credentialPlacement('a new service somebody added last week').ok).toBe(false);
    expect(credentialPlacement('   ').ok).toBe(false);
  });
});

describe('the stop', () => {
  it('is stated in full, in this file, rather than linked elsewhere', () => {
    // Somebody reading this file is looking for the exception, and finding a
    // link is how a reader concludes there might be one.
    expect(CHALLENGE_STOP).toContain('never answers a security challenge');
    for (const thing of ['CAPTCHA', 'second factor', 'hardware key', 'locked account']) {
      expect(CHALLENGE_STOP, thing).toContain(thing);
    }
  });

  it('says there is no setting and no hosted exception', () => {
    expect(CHALLENGE_STOP).toContain('no setting for this');
    expect(CHALLENGE_STOP).toContain('hosting does not create one');
  });

  it('carries the secret placement rules alongside the refusals', () => {
    const commitments = signInCommitments().join(' ');
    expect(commitments).toContain('No key exists that opens more than one tenant.');
    expect(commitments).toContain('never answers a security challenge');
  });
});
