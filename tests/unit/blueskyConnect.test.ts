import { describe, expect, it } from 'vitest';
import { settingsAfterReconnect } from '@xbam/runtime';

describe('the settings an account keeps when it is linked again', () => {
  it('goes back to the default server when the new link names none', () => {
    // The review case: an account once linked to its own server, reconnected
    // without one. Keeping the old address would send the new password there.
    const after = settingsAfterReconnect({ bluesky: { serviceUrl: 'https://pds.example.invalid' }, note: 'kept' }, {});
    expect(after).toEqual({ note: 'kept' });
    expect(JSON.stringify(after)).not.toContain('pds.example.invalid');
  });

  it('replaces the server when the new link names another', () => {
    const after = settingsAfterReconnect(
      { bluesky: { serviceUrl: 'https://old.example.invalid' } },
      { bluesky: { serviceUrl: 'https://new.example.invalid' } },
    );
    expect(after).toEqual({ bluesky: { serviceUrl: 'https://new.example.invalid' } });
  });

  it('keeps other Bluesky settings and every other key', () => {
    const after = settingsAfterReconnect({ bluesky: { serviceUrl: 'https://a.example.invalid', langs: ['en'] }, x: 1 }, {});
    expect(after).toEqual({ bluesky: { langs: ['en'] }, x: 1 });
  });

  it('leaves an account that never had a server alone', () => {
    expect(settingsAfterReconnect({}, {})).toEqual({});
  });
});

describe('what a Bluesky sign-in problem says', () => {
  it('has a plain sentence and a fix for each state that needs a person', async () => {
    const { describeSignIn } = await import('@xbam/shared/contracts');
    for (const status of ['NEEDS_AUTH', 'CHALLENGE_REQUIRES_USER', 'ERROR', 'DISCONNECTED'] as const) {
      const said = describeSignIn('bluesky', status);
      expect(said, status).not.toBeNull();
      expect(said!.what.length).toBeGreaterThan(20);
      // A Bluesky account has no browser. Nothing here may send anybody to one.
      expect(`${said!.what} ${said!.fix}`, status).not.toMatch(/browser|window|chrome|\bX\b/i);
    }
    expect(describeSignIn('bluesky', 'CONNECTED')).toBeNull();
  });

  it('never answers a challenge, and says so', async () => {
    const { describeSignIn } = await import('@xbam/shared/contracts');
    expect(describeSignIn('bluesky', 'CHALLENGE_REQUIRES_USER')!.fix).toMatch(/never answers/);
  });

  it('has nothing to say for another channel, whose own sign-in describes itself', async () => {
    const { describeSignIn } = await import('@xbam/shared/contracts');
    expect(describeSignIn('x', 'NEEDS_AUTH')).toBeNull();
    expect(describeSignIn('mock', 'ERROR')).toBeNull();
  });
});
