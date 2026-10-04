import type { Page } from 'playwright-core';

/**
 * Showing an owner the real browser their agent is using.
 *
 * Not a second browser, not a screenshot poll, and not a video file: Chrome's
 * own screencast, taken over a CDP session on the page the agent already has.
 * An owner watching something other than the actual tab would be watching a
 * reassuring fiction, which is worse than not watching.
 *
 * The parameters below are the real ones. `Page.startScreencast` takes
 * `format`, `quality`, `maxWidth`, `maxHeight` and `everyNthFrame`, the
 * `Page.screencastFrame` event delivers base64 `data` with `metadata` and a
 * `sessionId`, and `Page.screencastFrameAck` is the flow control. Read from
 * the protocol definition of the Playwright version this repository pins,
 * because that is what the worker actually drives Chrome with.
 *
 * The acknowledgement is the part that protects the host. Chrome keeps
 * producing frames while they are acknowledged, so a slow owner connection is
 * handled by not acknowledging rather than by growing a queue on the machine
 * holding everybody's tenants.
 */

export interface ScreencastBounds {
  format: 'jpeg' | 'png';
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
  maxUnackedFrames: number;
  idleStopAfterMs: number;
}

export interface ScreencastFrame {
  /** Base64, exactly as Chrome produced it. Relayed, never stored. */
  data: string;
  /** Chrome's own frame metadata: offsets, scale, device dimensions. */
  metadata: Record<string, unknown>;
}

export interface ScreencastHandle {
  /** Stop and detach. Safe to call twice. */
  stop(): Promise<void>;
  /** Frames Chrome has sent that this side has not acknowledged. */
  unacked(): number;
  /** Whether frames are still flowing. */
  live(): boolean;
}

/**
 * Start a screencast on a page and hand each frame to a sink.
 *
 * The sink returning false means the owner is not keeping up. That is the
 * signal to stop acknowledging, which makes Chrome stop sending, which is the
 * whole backpressure mechanism; nothing here buffers on the host's behalf.
 *
 * Frames are passed along and dropped. There is no recording, no file and no
 * row: watching an agent work is not the same as keeping a video of it, and a
 * stream that happens to also archive everything an agent reads is a different
 * and much more sensitive product.
 */
export async function startScreencast(
  page: Page,
  bounds: ScreencastBounds,
  sink: (frame: ScreencastFrame) => boolean | Promise<boolean>,
): Promise<ScreencastHandle> {
  const session = await page.context().newCDPSession(page);
  let unacked = 0;
  let live = true;
  let lastWanted = Date.now();

  const onFrame = async (payload: unknown) => {
    const frame = payload as { data: string; metadata?: Record<string, unknown>; sessionId: number };
    unacked += 1;
    let wanted = false;
    try {
      wanted = await sink({ data: frame.data, metadata: frame.metadata ?? {} });
    } catch {
      // A sink that throws is a viewer that has gone away. Treated as not
      // wanting frames rather than as an error worth propagating into Chrome.
      wanted = false;
    }
    if (wanted) lastWanted = Date.now();

    // Acknowledge only while the viewer is keeping up and the queue is short.
    // Withholding this is what makes Chrome stop, so it is the one piece of
    // flow control that cannot be skipped.
    if (wanted && unacked <= bounds.maxUnackedFrames) {
      try {
        await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
        unacked = Math.max(0, unacked - 1);
      } catch {
        // The session went away underneath us; the stop below will tidy up.
        live = false;
      }
    } else {
      /*
        Declined rather than queued. This frame will never be acknowledged, so
        counting it for ever made one stutter past the bound permanent: the
        comparison above stayed false and the stream could not resume after the
        viewer caught up. The counter means "waiting to be acknowledged".
      */
      unacked = Math.max(0, unacked - 1);
    }

    /*
      Checked here as well as on the timer. Here is immediate and free while
      frames are still arriving; the timer is for after they stop, which is
      exactly what withholding an acknowledgement causes. One without the
      other is either a slow stop or no stop at all.
    */
    if (Date.now() - lastWanted > bounds.idleStopAfterMs) {
      live = false;
      await stop();
    }
  };

  session.on('Page.screencastFrame', onFrame);

  /*
    On its own timer, because the check cannot live in the frame handler: not
    acknowledging is what makes Chrome stop sending, so the handler stops being
    called and the condition that would end the cast is never evaluated again.
    A stream nobody is watching then stays open on the machine holding
    everybody's tenants, with a renderer drawing frames into nothing.

    The same asymmetry this project already paid fifty-six minutes for: a wait
    had a bound and a hold did not.
  */
  const idleCheckMs = Math.max(1_000, Math.floor(bounds.idleStopAfterMs / 3));
  const idleTimer = setInterval(() => {
    if (Date.now() - lastWanted > bounds.idleStopAfterMs) void stop();
  }, idleCheckMs);
  // Never the reason a worker cannot exit.
  idleTimer.unref?.();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    live = false;
    clearInterval(idleTimer);
    // Each step is attempted independently: a page that has already gone is
    // the ordinary way a stream ends, not a failure worth reporting.
    try {
      await session.send('Page.stopScreencast');
    } catch {
      // Already gone.
    }
    try {
      session.off('Page.screencastFrame', onFrame);
    } catch {
      // Already detached.
    }
    try {
      await session.detach();
    } catch {
      // Already detached.
    }
  };

  try {
    await session.send('Page.startScreencast', {
      format: bounds.format,
      quality: bounds.quality,
      maxWidth: bounds.maxWidth,
      maxHeight: bounds.maxHeight,
      everyNthFrame: bounds.everyNthFrame,
    });
  } catch (error) {
    await stop();
    throw new Error(`The browser would not start a screencast: ${(error as Error).message}`);
  }

  return {
    stop,
    unacked: () => unacked,
    live: () => live && !stopped,
  };
}
