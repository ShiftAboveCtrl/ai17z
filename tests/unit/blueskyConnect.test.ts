import { describe, expect, it } from 'vitest';

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
