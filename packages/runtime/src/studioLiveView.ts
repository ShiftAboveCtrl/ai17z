import { accounts as accountsRepo, ops } from '@xbam/database';
import { browserEnabled, peekRolePage, sessionTabs, setOwnerHolding, startScreencast, type ScreencastHandle } from '@xbam/browser';
import { getChannelAdapter } from '@xbam/channels';
import { createLogger, errorMessage } from '@xbam/shared';
import type { Page } from 'playwright-core';
import { STREAM_BOUNDS, applyTakeover, type TakeoverState } from './browserTakeover';
import { studioViewFrame } from './studioLink';

const log = createLogger('studio-live-view');

/**
 * Watching, and when the owner allows it taking control of, an agent's real
 * browser from AI17Z Studio.
 *
 * Two switches, both off by default. Live view (`studio.liveView`) sends
 * pictures of whatever the agent's signed-in browser shows. Take control
 * (`studio.takeover`) additionally lets the owner click and type into it from
 * Studio, which is the thing somebody who stole their Studio session would
 * want most, so it is its own decision, and Studio also asks for a sign-in in
 * the last fifteen minutes before it will send a single key.
 *
 * Watching never gets in the agent's way: the frames come from Chrome's own
 * screencast of the tab the agent already has, found through `peekRolePage`,
 * which takes no lease and no lock.
 *
 * Taking control follows `browserTakeover.ts`. The owner asks; the account is
 * marked held at once, so the agent starts nothing new (`leaseSession`
 * refuses with a retryable error); an operation already holding a tab is
 * allowed to finish; then the owner has the page. Giving it back clears the
 * mark, and the agent's next operation reads the page afresh, as every
 * operation already does. Owner input is delivered with the next frame's
 * answer and never logged, stored, retried or replayed
 * (`SENSITIVE_INPUT_RULES`); a security challenge on the page is the owner's
 * to answer, which is the point of handing it to them.
 *
 * Bounded three ways: Studio says on every frame whether anybody is still
 * watching, a view ends after `MAX_VIEW_MS` regardless and gives control back
 * as it ends, and the screencast stops itself when nothing wants frames.
 */

const LIVE_VIEW_SETTING = 'studio.liveView';
const TAKEOVER_SETTING = 'studio.takeover';
/** A view ends after this long whatever happens, and somebody starts another. */
export const MAX_VIEW_MS = 10 * 60_000;
/** At most this many frames a second reach Studio while watching, and more while the owner is driving. */
const WATCH_FRAME_GAP_MS = 1_000;
const DRIVE_FRAME_GAP_MS = 300;
/** How long the agent's current operation may take to finish before the owner is told to try again. */
export const YIELD_WAIT_MS = 60_000;
/** The most owner events applied from one answer. */
const MAX_INPUT_PER_FRAME = 20;
/** A smaller picture than the hosted stream: this one crosses the internet. */
const BOUNDS = { ...STREAM_BOUNDS, maxWidth: 960, maxHeight: 640, quality: 50 };
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export interface SwitchSetting {
  enabled: boolean;
  changedAt: string | null;
}

async function readSwitch(key: string): Promise<SwitchSetting> {
  return (await ops.getSetting<SwitchSetting>(key)) ?? { enabled: false, changedAt: null };
}

export const studioLiveViewSetting = () => readSwitch(LIVE_VIEW_SETTING);
export const studioTakeoverSetting = () => readSwitch(TAKEOVER_SETTING);

export async function setStudioLiveView(enabled: boolean, by: string | null): Promise<SwitchSetting> {
  const next = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(LIVE_VIEW_SETTING, next);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.live_view.enabled' : 'studio.live_view.disabled', entityType: 'settings', entityId: 'studio' });
  if (!enabled) await stopAllViews();
  return next;
}

export async function setStudioTakeover(enabled: boolean, by: string | null): Promise<SwitchSetting> {
  const next = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(TAKEOVER_SETTING, next);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.takeover.enabled' : 'studio.takeover.disabled', entityType: 'settings', entityId: 'studio' });
  if (!enabled) for (const agentId of [...views.keys()]) await releaseControl(agentId);
  return next;
}

/** Whether this process can show a browser at all: only the worker that owns them can. */
export function canShowBrowser(): boolean {
  return browserEnabled();
}

interface View {
  handle: ScreencastHandle;
  ends: NodeJS.Timeout;
  page: Page;
  accountId: string;
  state: TakeoverState;
  heldSince: number | null;
}

const views = new Map<string, View>();

export function viewing(agentId: string): boolean {
  return views.has(agentId);
}

export function controlState(agentId: string): TakeoverState | null {
  return views.get(agentId)?.state ?? null;
}

export async function stopView(agentId: string): Promise<boolean> {
  const view = views.get(agentId);
  if (!view) return false;
  await releaseControl(agentId);
  views.delete(agentId);
  clearTimeout(view.ends);
  await view.handle.stop().catch(() => undefined);
  return true;
}

export async function stopAllViews(): Promise<void> {
  for (const agentId of [...views.keys()]) await stopView(agentId);
}

/**
 * One owner event on the page. Playwright's mouse and keyboard, which speak
 * CDP Input underneath, and nothing that reaches anything but this page.
 */
export async function applyOwnerInput(page: Pick<Page, 'mouse' | 'keyboard'>, event: unknown): Promise<boolean> {
  if (!event || typeof event !== 'object') return false;
  const e = event as { t?: unknown; x?: unknown; y?: unknown; button?: unknown; dy?: unknown; text?: unknown; key?: unknown };
  const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : null);
  switch (e.t) {
    case 'click': {
      const x = coord(e.x);
      const y = coord(e.y);
      if (x === null || y === null) return false;
      await page.mouse.click(x, y, { button: e.button === 'right' ? 'right' : 'left' });
      return true;
    }
    case 'scroll': {
      const x = coord(e.x);
      const y = coord(e.y);
      if (x === null || y === null || typeof e.dy !== 'number' || !Number.isFinite(e.dy)) return false;
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, e.dy)));
      return true;
    }
    case 'text':
      if (typeof e.text !== 'string' || e.text.length === 0 || e.text.length > 200) return false;
      await page.keyboard.insertText(e.text);
      return true;
    case 'key':
      if (typeof e.key !== 'string' || !NAMED_KEYS.has(e.key)) return false;
      await page.keyboard.press(e.key);
      return true;
    default:
      return false;
  }
}

/**
 * Starts a view of one agent's browser and returns a sentence for the owner.
 * The agent id is core's own; Studio names the agent by it.
 */
export async function startView(agentId: string, agentName: string): Promise<{ ok: boolean; sentence: string }> {
  if (!(await studioLiveViewSetting()).enabled) return { ok: false, sentence: 'Live view is off on this AI17Z. Turn it on there, under Plugins, AI17Z Studio.' };
  if (!canShowBrowser()) return { ok: false, sentence: 'This part of AI17Z does not run the browser.' };
  if (views.has(agentId)) return { ok: true, sentence: `${agentName}'s browser is already being shown.` };

  let page: Page | null = null;
  let accountId: string | null = null;
  for (const link of await accountsRepo.listAgentAccounts(agentId)) {
    if (!link.enabled) continue;
    const account = await accountsRepo.getAccount(link.accountId);
    if (!account || !getChannelAdapter(account.channel).requiresBrowser) continue;
    page = (peekRolePage(account.id, 'ACTION') ?? peekRolePage(account.id, 'MENTIONS') ?? peekRolePage(account.id, 'NOTIFICATIONS')) as Page | null;
    if (page) {
      accountId = account.id;
      break;
    }
  }
  if (!page || !accountId) return { ok: false, sentence: `${agentName}'s browser is not open on its machine right now, so there is nothing to show.` };

  let lastSent = 0;
  let sending = false;
  const handle = await startScreencast(page, BOUNDS, async (frame) => {
    const now = Date.now();
    const view = views.get(agentId);
    const driving = view?.state === 'OWNER_CONTROL';
    // Acknowledged without sending: Chrome keeps the latest picture coming,
    // and Studio sees at most one a second, or a few while the owner drives.
    if (sending || now - lastSent < (driving ? DRIVE_FRAME_GAP_MS : WATCH_FRAME_GAP_MS)) return true;
    sending = true;
    lastSent = now;
    try {
      const meta = frame.metadata as { deviceWidth?: unknown; deviceHeight?: unknown };
      const size =
        typeof meta.deviceWidth === 'number' && typeof meta.deviceHeight === 'number' && meta.deviceWidth > 0 && meta.deviceHeight > 0
          ? { width: Math.round(meta.deviceWidth), height: Math.round(meta.deviceHeight) }
          : undefined;
      const answer = await studioViewFrame({ protocol: 1, agent_id: agentId, at: new Date(now).toISOString(), format: 'jpeg', data: frame.data, ...(size ? { size } : {}), control: driving });
      if (!answer.ok || !answer.watching) {
        void stopView(agentId);
        return false;
      }
      if (driving && view) {
        for (const event of answer.input.slice(0, MAX_INPUT_PER_FRAME)) {
          try {
            await applyOwnerInput(view.page, event);
          } catch (error) {
            // What failed is said; what was typed never is.
            log.warn('an owner input could not be applied to the page', { message: errorMessage(error).slice(0, 120) });
            break;
          }
        }
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
  views.set(agentId, { handle, ends, page, accountId, state: 'AGENT_CONTROL', heldSince: null });
  await ops.audit({ actorUserId: null, action: 'studio.live_view.started', entityType: 'agent', entityId: agentId, data: { via: 'studio' } });
  return { ok: true, sentence: `Showing ${agentName}'s browser. It stops when nobody is watching, and after ten minutes.` };
}

/**
 * The owner asks for the page. The agent starts nothing new from this moment,
 * finishes what it is doing, and then the page is theirs.
 */
export async function takeControl(agentId: string, agentName: string, wait = YIELD_WAIT_MS): Promise<{ ok: boolean; sentence: string }> {
  if (!(await studioTakeoverSetting()).enabled) return { ok: false, sentence: 'Taking control from Studio is off on this AI17Z. Turn it on there, under Plugins, AI17Z Studio.' };
  const view = views.get(agentId);
  if (!view) return { ok: false, sentence: `Watch ${agentName}'s browser first; control is handed over inside a live view.` };
  if (view.state === 'OWNER_CONTROL') return { ok: true, sentence: `You already have ${agentName}'s browser.` };
  view.state = applyTakeover(view.state, 'OWNER_REQUESTS').state;
  setOwnerHolding(view.accountId, true);
  const deadline = Date.now() + wait;
  while (sessionTabs(view.accountId).some((t) => t.state === 'BUSY')) {
    if (Date.now() > deadline) {
      setOwnerHolding(view.accountId, false);
      view.state = 'AGENT_CONTROL';
      return { ok: false, sentence: `${agentName} did not finish what it was doing within a minute. Nothing was handed over; try again.` };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  view.state = applyTakeover(view.state, 'AGENT_YIELDED').state;
  view.heldSince = Date.now();
  await ops.audit({ actorUserId: null, action: 'studio.takeover.started', entityType: 'agent', entityId: agentId, data: { via: 'studio' } });
  return { ok: true, sentence: `You have ${agentName}'s browser. It does nothing in it until you give it back.` };
}

/** The owner gives the page back; the agent's next operation reads it afresh. */
export async function releaseControl(agentId: string): Promise<boolean> {
  const view = views.get(agentId);
  if (!view || view.state === 'AGENT_CONTROL') return false;
  setOwnerHolding(view.accountId, false);
  const heldMs = view.heldSince ? Date.now() - view.heldSince : 0;
  // Released, then resumed: the agent's next operation is what reads the page afresh.
  view.state = applyTakeover(applyTakeover(view.state, 'OWNER_RELEASES').state, 'AGENT_RESUMED').state;
  view.heldSince = null;
  // That it happened and for how long, never what was done.
  await ops.audit({ actorUserId: null, action: 'studio.takeover.ended', entityType: 'agent', entityId: agentId, data: { via: 'studio', heldSeconds: Math.round(heldMs / 1000) } });
  return true;
}
