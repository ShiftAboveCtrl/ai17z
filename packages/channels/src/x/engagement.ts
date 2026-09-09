import { PipelineError } from '@xbam/shared';
import type { Locator, Page } from '@xbam/browser';
import type { ActionRequest, ActionResult, ChannelContext, VerificationResult } from '../contract';
import { SEL, articleForStatus } from './selectors';
import type { ArticleSnapshot } from './conversation';
import { goto, readArticle, withSession } from './page';
import { buildStatusUrl, extractStatusId } from './targets';

/**
 * Liking and reposting, as a desired state rather than a toggle.
 *
 * Separate from the composer because nothing here writes anything: it looks at
 * which of two controls the page is showing and clicks only when the state it
 * wants does not already hold. Retrying a toggle is how an automation unlikes
 * a post it liked a moment ago.
 */

/**
 * What each engagement looks like on the page, in both states.
 *
 * `settled` is the selector that is present once the desired state holds, and
 * `control` the one that is present while it does not. They are different test
 * ids rather than one element with an attribute, which is what lets this be
 * expressed as a desired state instead of a toggle.
 */
const ENGAGEMENTS = {
  LIKE: { control: SEL.like, settled: SEL.unlike, done: 'liked', doing: 'Liking' },
  REPOST: { control: SEL.repost, settled: SEL.unrepost, done: 'reposted', doing: 'Reposting' },
} as const;

/**
 * Ensures a post is liked, or reposted. Never toggles.
 *
 * The distinction is the whole design. An autonomous agent that clicks the like
 * control because it decided to like something will *unlike* a post it already
 * liked -- and it will do that precisely when a retry happens, which is exactly
 * when it is least wanted. So the state is read first and the click only
 * happens if the state is wrong.
 *
 * That also makes recovery free: a worker that died after clicking comes back,
 * finds the post already in the desired state, and reports success having
 * touched nothing. There is no separate reconciliation path to keep correct
 * because reading the state first *is* the reconciliation.
 */
export async function engagePost(
  ctx: ChannelContext,
  request: ActionRequest,
  verification: VerificationResult,
  type: 'LIKE' | 'REPOST',
): Promise<ActionResult> {
  const statusId = extractStatusId(verification.targetRef)!;
  const url = buildStatusUrl(verification.targetRef)!;
  const anchor = articleForStatus(statusId);

  return withSession(ctx, 'ACTION', async ({ page }) => {
    // Navigated and re-anchored here rather than trusting where verification
    // left the tab, for the same reason a reply does it: the action tab is
    // shared, and engaging with whatever happens to be loaded is how an
    // automation likes a stranger's post.
    await anchorTarget(page, statusId, url);
    const outcome = await ensureEngaged(page, page.locator(anchor).first(), type, statusId);

    return {
      status: 'EXECUTED' as const,
      remoteActionId: statusId,
      remoteActionUrl: url,
      verification: {
        ...verification,
        detail: `${verification.detail} ${outcome.detail}`,
        evidence: { ...verification.evidence, ...outcome.evidence },
      },
    };
  });
}

export interface EngagementOutcome {
  detail: string;
  evidence: { alreadyInState: boolean; clicks: number };
}

/**
 * Brings one article to the desired engagement state, and proves it got there.
 *
 * Separated from the session and navigation around it so the decision -- which
 * is the part that must never toggle -- can be exercised without a browser.
 */
export async function ensureEngaged(
  page: Page,
  article: Locator,
  type: 'LIKE' | 'REPOST',
  statusId: string,
): Promise<EngagementOutcome> {
  const spec = ENGAGEMENTS[type];

  // Read before acting. This is both the desired-state check and the whole of
  // the reconciliation a retry needs: a worker that died after clicking comes
  // back, finds the state already right, and touches nothing.
  const already = await article
    .locator(spec.settled)
    .first()
    .isVisible()
    .catch(() => false);
  if (already) {
    return {
      detail: `Already ${spec.done}; nothing was clicked.`,
      evidence: { alreadyInState: true, clicks: 0 },
    };
  }

  const control = article.locator(spec.control).first();
  if (!(await control.isVisible().catch(() => false))) {
    throw PipelineError.retryable(
      'engagement_control_missing',
      `The ${type.toLowerCase()} control was not visible on status ${statusId}.`,
    );
  }
  await control.click({ timeout: 10_000 });

  if (type === 'REPOST') {
    // X asks which kind. Plain repost, explicitly -- the entry beside it opens
    // a quote composer, and a quote is a different action with a different
    // meaning that nobody asked for here.
    const confirm = page.locator(SEL.repostConfirm).first();
    const offered = await confirm
      .waitFor({ state: 'visible', timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
    if (!offered) {
      throw PipelineError.retryable('repost_menu_missing', 'X did not offer the repost menu.');
    }
    await confirm.click({ timeout: 8_000 });
  }

  // Proved on the page, not assumed from the click. A click that opened a menu
  // and went nowhere looks identical to one that worked, from here.
  const settled = await article
    .locator(spec.settled)
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!settled) {
    throw PipelineError.retryable(
      'engagement_did_not_settle',
      `Status ${statusId} still does not read as ${spec.done} after acting.`,
    );
  }

  return { detail: `Now ${spec.done}.`, evidence: { alreadyInState: false, clicks: 1 } };
}

/**
 * Loads the target and proves the article on screen is the intended post.
 *
 * Lifted out of the reply path so that likes and reposts get exactly the same
 * wrong-target protection rather than a second implementation of it. There is
 * no positional fallback here and there never was: no matching article means a
 * stop, because acting on the article that happens to be first is how an
 * automation engages with the wrong post.
 */
export async function anchorTarget(page: Page, statusId: string, url: string): Promise<ArticleSnapshot> {
  await goto(page, url);
  const anchor = articleForStatus(statusId);
  const rendered = await page
    .locator(anchor)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!rendered) {
    throw PipelineError.retryable(
      'target_not_rendered',
      `Status ${statusId} did not render on ${url}, so there was nothing to act on.`,
      { url },
    );
  }
  const onPage = await readArticle(page, anchor);
  if (onPage.statusId !== statusId) {
    throw PipelineError.review(
      'target_moved',
      `The anchored article now reports status ${onPage.statusId ?? 'unknown'}, expected ${statusId}.`,
    );
  }
  return onPage;
}
