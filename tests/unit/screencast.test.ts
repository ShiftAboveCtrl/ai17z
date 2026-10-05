import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startScreencast, type ScreencastBounds } from '@xbam/browser';
import { STREAM_BOUNDS } from '@xbam/runtime';

/**
 * Showing an owner the real browser, bounded so one viewer cannot hurt a host.
 *
 * The CDP session is a fake. What is being proved is the flow control, because
 * that is the part that protects a machine holding other people's tenants:
 * Chrome keeps sending while frames are acknowledged, so the only safe
 * response to a slow viewer is to stop acknowledging.
 */

const bounds: ScreencastBounds = { ...STREAM_BOUNDS };

/** A CDP session that records what it was sent and can emit frames on demand. */
function fakeSession(options: { startFails?: boolean; ackFails?: boolean } = {}) {
  const sent: { method: string; params?: unknown }[] = [];
  const handlers = new Map<string, ((p: unknown) => unknown)[]>();
  let detached = false;
  const session = {
    sent,
    detached: () => detached,
    on(event: string, fn: (p: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    off(event: string, fn: (p: unknown) => unknown) {
      handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
    },
    async send(method: string, params?: unknown) {
      if (method === 'Page.startScreencast' && options.startFails) throw new Error('no screencast here');
      if (method === 'Page.screencastFrameAck' && options.ackFails) throw new Error('session gone');
      sent.push({ method, params });
      return {};
    },
    async detach() {
      detached = true;
    },
    async emit(event: string, payload: unknown) {
      for (const fn of handlers.get(event) ?? []) await fn(payload);
    },
    listenerCount(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
  return session;
}

function pageWith(session: ReturnType<typeof fakeSession>) {
  return { context: () => ({ newCDPSession: async () => session }) } as never;
}

const frame = (sessionId: number) => ({ data: 'base64frame', metadata: { offsetTop: 0 }, sessionId });

describe('starting a stream', () => {
  it('asks Chrome for exactly the bounds it was given', async () => {
    const session = fakeSession();
    await startScreencast(pageWith(session), bounds, () => true);
    const start = session.sent.find((s) => s.method === 'Page.startScreencast');
    expect(start).toBeTruthy();
    // Every bound is a real parameter rather than an intention.
    expect(start!.params).toEqual({
      format: bounds.format,
      quality: bounds.quality,
      maxWidth: bounds.maxWidth,
      maxHeight: bounds.maxHeight,
      everyNthFrame: bounds.everyNthFrame,
    });
  });

  it('cleans up and explains when the browser refuses', async () => {
    const session = fakeSession({ startFails: true });
    await expect(startScreencast(pageWith(session), bounds, () => true)).rejects.toThrow(/would not start a screencast/);
    // No listener and no session left behind by a failed start.
    expect(session.listenerCount('Page.screencastFrame')).toBe(0);
    expect(session.detached()).toBe(true);
  });
});

describe('the acknowledgement is the flow control', () => {
  it('acknowledges a frame the viewer kept up with', async () => {
    const session = fakeSession();
    const handle = await startScreencast(pageWith(session), bounds, () => true);
    await session.emit('Page.screencastFrame', frame(1));
    expect(session.sent.filter((s) => s.method === 'Page.screencastFrameAck')).toHaveLength(1);
    expect(handle.unacked()).toBe(0);
  });

  it('stops acknowledging when the viewer is not keeping up', async () => {
    // Chrome keeps sending while frames are acknowledged, so withholding the
    // acknowledgement is the only thing that makes it stop. The alternative
    // is a queue on a machine holding everybody's tenants.
    const session = fakeSession();
    const handle = await startScreencast(pageWith(session), bounds, () => false);
    await session.emit('Page.screencastFrame', frame(1));
    await session.emit('Page.screencastFrame', frame(2));
    expect(session.sent.filter((s) => s.method === 'Page.screencastFrameAck')).toHaveLength(0);
    /*
      Nothing is awaiting an acknowledgement: these two frames were declined
      rather than queued, and will never be acknowledged. Counting them for
      ever made one stutter past the bound permanent, so the stream could not
      resume once the viewer caught up.
    */
    expect(handle.unacked()).toBe(0);
  });

  it('treats a sink that throws as a viewer that has gone', async () => {
    const session = fakeSession();
    await startScreencast(pageWith(session), bounds, () => {
      throw new Error('socket closed');
    });
    // Not propagated into Chrome, and not acknowledged either.
    await expect(session.emit('Page.screencastFrame', frame(1))).resolves.toBeUndefined();
    expect(session.sent.filter((s) => s.method === 'Page.screencastFrameAck')).toHaveLength(0);
  });

  it('stops acknowledging once more frames are outstanding than allowed', async () => {
    const session = fakeSession();
    // A sink that wants frames but never lets the count fall, by failing acks.
    const acking = fakeSession({ ackFails: true });
    const handle = await startScreencast(pageWith(acking), bounds, () => true);
    for (let i = 0; i < bounds.maxUnackedFrames + 2; i += 1) {
      await acking.emit('Page.screencastFrame', frame(i + 1));
    }
    // The failed acks mark the stream dead rather than looping for ever.
    expect(handle.live()).toBe(false);
    expect(session.sent).toHaveLength(0);
  });
});

describe('stopping', () => {
  it('stops the cast, detaches and removes its listener', async () => {
    const session = fakeSession();
    const handle = await startScreencast(pageWith(session), bounds, () => true);
    await handle.stop();
    expect(session.sent.some((s) => s.method === 'Page.stopScreencast')).toBe(true);
    expect(session.listenerCount('Page.screencastFrame')).toBe(0);
    expect(session.detached()).toBe(true);
    expect(handle.live()).toBe(false);
  });

  it('is safe to call twice', async () => {
    // A page that has already gone is the ordinary way a stream ends.
    const session = fakeSession();
    const handle = await startScreencast(pageWith(session), bounds, () => true);
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(session.sent.filter((s) => s.method === 'Page.stopScreencast')).toHaveLength(1);
  });

  it('stops itself once nobody has wanted a frame for the idle window', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const handle = await startScreencast(pageWith(session), { ...bounds, idleStopAfterMs: 1_000 }, () => false);
      vi.setSystemTime(Date.now() + 2_000);
      await session.emit('Page.screencastFrame', frame(1));
      // Streaming to an empty room on somebody else's machine is not free.
      expect(handle.live()).toBe(false);
      expect(session.sent.some((s) => s.method === 'Page.stopScreencast')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a stream leaves behind', () => {
  it('keeps no frames', async () => {
    // Watching an agent work is not keeping a video of it, and a stream that
    // archives everything an agent reads is a different, far more sensitive
    // product.
    const session = fakeSession();
    const seen: string[] = [];
    const handle = await startScreencast(pageWith(session), bounds, (f) => {
      seen.push(f.data);
      return true;
    });
    await session.emit('Page.screencastFrame', frame(1));
    await handle.stop();
    // The sink saw it; nothing in the handle retains it.
    expect(seen).toEqual(['base64frame']);
    expect(JSON.stringify(handle)).not.toContain('base64frame');
  });
});

describe('a stream that nobody is watching stops', () => {
  const SOURCE = readFileSync(
    join(__dirname, '..', '..', 'packages', 'browser', 'src', 'screencast.ts'),
    'utf8',
  );

  it('stops with no further frame arriving at all', async () => {
    /*
      The one that matters, and the one a source assertion cannot make: not
      acknowledging is what makes Chrome stop sending, so the handler stops
      being called and anything that decides to stop from inside it never runs
      again. This advances the clock and emits nothing. A mutation that guts
      the timer's body leaves the `setInterval` call in place, so only
      behaviour catches it.
    */
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const handle = await startScreencast(pageWith(session), { ...bounds, idleStopAfterMs: 1_000 }, () => false);
      expect(handle.live()).toBe(true);

      // No frame is emitted. Only time passes.
      await vi.advanceTimersByTimeAsync(2_500);

      expect(handle.live()).toBe(false);
      expect(session.sent.some((x) => x.method === 'Page.stopScreencast')).toBe(true);
      expect(session.listenerCount('Page.screencastFrame')).toBe(0);
      expect(session.detached()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps streaming while the viewer is still asking for frames', async () => {
    // The other half: a timer that stopped a healthy stream would be worse
    // than one that never fired.
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const handle = await startScreencast(pageWith(session), { ...bounds, idleStopAfterMs: 1_000 }, () => true);
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(400);
        await session.emit('Page.screencastFrame', frame(i + 1));
      }
      expect(handle.live()).toBe(true);
      expect(session.sent.some((x) => x.method === 'Page.stopScreencast')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decides to stop on a timer rather than inside the frame handler', () => {
    /*
      Not acknowledging is what makes Chrome stop sending, so a check that
      lives in the frame handler is a check that stops running exactly when it
      is needed. The cast then stays open on the machine holding everybody's
      tenants.
    */
    // Both, not either. The handler is immediate and free while frames are
    // arriving; the timer is for after they stop, which is what withholding
    // an acknowledgement causes.
    expect(SOURCE).toContain('setInterval(');
    const handler = SOURCE.slice(SOURCE.indexOf('const onFrame'), SOURCE.indexOf("session.on('Page.screencastFrame'"));
    expect(handler).toContain('idleStopAfterMs');
    const afterHandler = SOURCE.slice(SOURCE.indexOf("session.on('Page.screencastFrame'"));
    expect(afterHandler).toContain('idleStopAfterMs');
  });

  it('clears that timer when the cast stops', () => {
    // A lock whose release can be lost is not a lock, and a timer whose clear
    // can be missed is a worker that will not exit.
    const stop = SOURCE.slice(SOURCE.indexOf('const stop = async'));
    expect(stop.slice(0, stop.indexOf('try {'))).toContain('clearInterval(idleTimer)');
  });

  it('does not hold a process open on its own', () => {
    expect(SOURCE).toContain('idleTimer.unref');
  });

  it('counts frames waiting to be acknowledged rather than frames that arrived', () => {
    // Counting a declined frame for ever made one stutter past the bound
    // permanent: the stream could not resume after the viewer caught up.
    expect(SOURCE).toContain('Declined rather than queued');
    const handler = SOURCE.slice(SOURCE.indexOf('const onFrame'), SOURCE.indexOf("session.on('Page.screencastFrame'"));
    // One decrement on the acknowledged path and one on the declined path.
    expect(handler.match(/unacked = Math\.max\(0, unacked - 1\)/g)?.length).toBe(2);
  });
});
