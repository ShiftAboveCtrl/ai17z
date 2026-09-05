import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(resolve(__dirname, '../../apps/worker/src/main.ts'), 'utf8');

/**
 * The wiring that has no other alarm.
 *
 * `deliverNotifications` is thoroughly tested on its own, and every one of
 * those tests passes if the worker never calls it. Remove the call and nothing
 * fails: the notifications keep being raised, the web UI keeps showing them,
 * and the transport somebody set up on their phone simply goes quiet. The first
 * sign would be an account locked out overnight that nobody was told about,
 * which is the exact thing the feature exists to prevent.
 *
 * A file-content test rather than a behavioural one, because the thing being
 * asserted is that a line exists in a process this suite does not run.
 */
describe('the worker actually delivers notifications', () => {
  it('registers the transports at startup', () => {
    expect(worker).toContain('installTelegramTransport()');
  });

  it('calls the delivery sweep', () => {
    expect(worker).toContain('deliverNotifications()');
  });

  it('runs delivery after the sweep that raises them', () => {
    // Otherwise anything raised this minute waits for the next pass, which
    // turns a sixty-second notification into a two-minute one for no reason.
    expect(worker.indexOf('sweepNotifications()')).toBeLessThan(worker.indexOf('deliverNotifications()'));
  });

  it('keeps delivery outside the sweep it follows', () => {
    // Its own try/catch, so a slow HTTPS call or a transport failure cannot
    // take down the sweep that decides what is wrong with the installation.
    const after = worker.slice(worker.indexOf('deliverNotifications()') - 400, worker.indexOf('deliverNotifications()'));
    expect(after).toContain('try {');
  });

  it('sends the heartbeat, which is what makes silence mean something', () => {
    expect(worker).toContain('telegramHeartbeat()');
  });
});
