import { accounts as accountsRepo, ops } from '@xbam/database';
import { browserEnabled, peekRolePage, startScreencast, type ScreencastHandle } from '@xbam/browser';
import { getChannelAdapter } from '@xbam/channels';
import { createLogger, errorMessage } from '@xbam/shared';
import { STREAM_BOUNDS } from './browserTakeover';
import { studioViewFrame } from './studioLink';

const log = createLogger('studio-live-view');

/**
 * Watching an agent's real browser from AI17Z Studio.
 *
 * Its own switch (`studio.liveView`), off by default and separate from
 * control: a live view sends pictures of whatever the agent's signed-in
 * browser shows, which is more than its name and state, and an owner who
 * agreed to the second has not agreed to the first.
 *
 * Look, never touch. The frames come from Chrome's own screencast of the tab
 * the agent already has (`startScreencast`, with the acknowledgement as the
 * backpressure), found through `peekRolePage`, which takes no lease and no
 * lock: watching the action tab must never hold up a reply. Nothing here
 * dispatches input. Typing into the browser stays with whoever is at the
 * machine, which is also where a sign-in challenge is answered.
 *
 * Bounded three ways: Studio says on every frame whether anybody is still
 * watching, a view ends after `MAX_VIEW_MS` regardless, and the screencast
 * stops itself when nothing wants frames. Frames are relayed and dropped;
 * nothing here writes one to disk.
 */

const LIVE_VIEW_SETTING = 'studio.liveView';
/** A view ends after this long whatever happens, and somebody starts another. */
export const MAX_VIEW_MS = 10 * 60_000;
/** At most this many frames a second reach Studio, whatever Chrome produces. */
const MIN_FRAME_GAP_MS = 1_000;
/** A smaller picture than the hosted stream: this one crosses the internet once a second. */
const BOUNDS = { ...STREAM_BOUNDS, maxWidth: 960, maxHeight: 640, quality: 50 };

export interface LiveViewSetting {
  enabled: boolean;
  changedAt: string | null;
}

export async function studioLiveViewSetting(): Promise<LiveViewSetting> {
  return (await ops.getSetting<LiveViewSetting>(LIVE_VIEW_SETTING)) ?? { enabled: false, changedAt: null };
}

export async function setStudioLiveView(enabled: boolean, by: string | null): Promise<LiveViewSetting> {
  const next = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(LIVE_VIEW_SETTING, next);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.live_view.enabled' : 'studio.live_view.disabled', entityType: 'settings', entityId: 'studio' });
  if (!enabled) await stopAllViews();
  return next;
}

/** Whether this process can show a browser at all: only the worker that owns them can. */
export function canShowBrowser(): boolean {
  return browserEnabled();
}

const views = new Map<string, { handle: ScreencastHandle; ends: NodeJS.Timeout }>();

export function viewing(agentId: string): boolean {
  return views.has(agentId);
}

export async function stopView(agentId: string): Promise<boolean> {
  const view = views.get(agentId);
  if (!view) return false;
  views.delete(agentId);
  clearTimeout(view.ends);
  await view.handle.stop().catch(() => undefined);
  return true;
}

export async function stopAllViews(): Promise<void> {
  for (const agentId of [...views.keys()]) await stopView(agentId);
}

/**
 * Starts a view of one agent's browser and returns a sentence for the owner.
 * The agent id is core's own; Studio names the agent by it.
 */
export async function startView(agentId: string, agentName: string): Promise<{ ok: boolean; sentence: string }> {
  if (!(await studioLiveViewSetting()).enabled) return { ok: false, sentence: 'Live view is off on this AI17Z. Turn it on there, under Plugins, AI17Z Studio.' };
  if (!canShowBrowser()) return { ok: false, sentence: 'This part of AI17Z does not run the browser.' };
  if (views.has(agentId)) return { ok: true, sentence: `${agentName}'s browser is already being shown.` };

  let page = null;
  for (const link of await accountsRepo.listAgentAccounts(agentId)) {
    if (!link.enabled) continue;
    const account = await accountsRepo.getAccount(link.accountId);
    if (!account || !getChannelAdapter(account.channel).requiresBrowser) continue;
    page = peekRolePage(account.id, 'ACTION') ?? peekRolePage(account.id, 'MENTIONS') ?? peekRolePage(account.id, 'NOTIFICATIONS');
    if (page) break;
  }
  if (!page) return { ok: false, sentence: `${agentName}'s browser is not open on its machine right now, so there is nothing to show.` };

  let lastSent = 0;
  let sending = false;
  const handle = await startScreencast(page, BOUNDS, async (frame) => {
    const now = Date.now();
    // Acknowledged without sending: Chrome keeps the latest picture coming,
    // and Studio sees at most one a second.
    if (sending || now - lastSent < MIN_FRAME_GAP_MS) return true;
    sending = true;
    lastSent = now;
    try {
      const answer = await studioViewFrame({ protocol: 1, agent_id: agentId, at: new Date(now).toISOString(), format: 'jpeg', data: frame.data });
      if (!answer.ok || !answer.watching) {
        void stopView(agentId);
        return false;
      }
      return true;
    } catch (error) {
      log.warn('a live view frame did not reach Studio', { message: errorMessage(error) });
      void stopView(agentId);
      return false;
    } finally {
      sending = false;
    }
  });
  const ends = setTimeout(() => void stopView(agentId), MAX_VIEW_MS);
  ends.unref?.();
  views.set(agentId, { handle, ends });
  await ops.audit({ actorUserId: null, action: 'studio.live_view.started', entityType: 'agent', entityId: agentId, data: { via: 'studio' } });
  return { ok: true, sentence: `Showing ${agentName}'s browser. It stops when nobody is watching, and after ten minutes.` };
}
