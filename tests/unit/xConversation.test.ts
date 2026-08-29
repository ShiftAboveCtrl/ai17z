import { describe, expect, it } from 'vitest';
import { type ArticleSnapshot, parentTextOf, replyingToHandles, resolveBranch } from '@xbam/channels';

/**
 * The nested-mention cases, frozen.
 *
 * Every fixture here is a situation AI4CZ either handled or got wrong, taken
 * from `AI4CZ_Nested_Mentions_and_Reply_Context_Handling.pdf` and from reading
 * `scripts/scrape-notifications-to-inbox.js` again. They exist so that a future
 * rewrite of the context resolver cannot quietly reintroduce the two failures
 * that mattered: replying to the wrong post, and reasoning with one line of
 * context when the thread had four.
 *
 * Each case states, explicitly:
 *   - the X structure as rendered
 *   - the expected incoming post and action target
 *   - the expected parent and ancestor order
 *   - what context is included and what is deliberately excluded
 *
 * See docs/legacy-nested-mentions.md.
 */

const ME = ['agent'];

let nextId = 100;
function article(
  handle: string,
  text: string,
  options: { replyingTo?: string[]; statusId?: string; name?: string } = {},
): ArticleSnapshot {
  const statusId = options.statusId ?? String((nextId += 1));
  return {
    index: 0,
    statusId,
    authorHandle: handle,
    authorDisplayName: options.name ?? handle,
    text,
    url: `https://x.com/${handle}/status/${statusId}`,
    createdAt: null,
    replyingTo: options.replyingTo ?? [],
  };
}

/** Page order is what X rendered; the index is assigned from it. */
function page(...articles: ArticleSnapshot[]): ArticleSnapshot[] {
  return articles.map((a, index) => ({ ...a, index }));
}

describe('case 1: a direct mention under a root post (PDF section 3)', () => {
  // POST A by @alice
  //   +-- POST B by @bob: "@agent thoughts?"   <- the mention
  const a = article('alice', 'Project Q just changed token distribution.', { statusId: '1000' });
  const b = article('bob', '@agent thoughts?', { statusId: '1001', replyingTo: ['alice'] });
  const articles = page(a, b);

  it('anchors the action target to the mention, not to the root', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '1001', selfHandles: ME });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.conversation.incoming.remoteId).toBe('1001');
    expect(outcome.conversation.incoming.authorHandle).toBe('bob');
  });

  it('carries the root post as parent context, which is what "thoughts?" refers to', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '1001', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.parent?.remoteId).toBe('1000');
    expect(outcome.conversation.parent?.authorHandle).toBe('alice');
    expect(parentTextOf(outcome.conversation)).toBe('Project Q just changed token distribution.');
  });

  it('confirms the branch against X\'s own replying-to line', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '1001', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.branchConfirmed).toBe(true);
  });
});

describe('case 2: a reply to the agent\'s own post', () => {
  // The agent posted A; @alice replied.
  const a = article('agent', 'Fees are a design choice, not a law of nature.', { statusId: '2000' });
  const b = article('alice', 'Disagree — they track block space.', { statusId: '2001', replyingTo: ['agent'] });
  const articles = page(a, b);

  it('marks the agent\'s own post as self rather than treating it as a stranger', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '2001', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.root?.isSelf).toBe(true);
    expect(outcome.conversation.incoming.isSelf).toBe(false);
  });
});

describe('case 3: a mention beneath somebody else\'s reply (PDF section 4)', () => {
  // POST A by @alice
  //   +-- POST B by @bob:     "I think this is wrong"
  //         +-- POST C by @charlie: "@agent what do you think?"
  const a = article('alice', 'The upgrade ships Thursday.', { statusId: '3000' });
  const b = article('bob', 'I think this is wrong', { statusId: '3001', replyingTo: ['alice'] });
  const c = article('charlie', '@agent what do you think?', { statusId: '3002', replyingTo: ['bob'] });
  const articles = page(a, b, c);

  it('targets C and uses B as the semantic parent, exactly as AI4CZ did', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '3002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.incoming.remoteId).toBe('3002');
    expect(outcome.conversation.parent?.remoteId).toBe('3001');
    expect(outcome.conversation.parent?.authorHandle).toBe('bob');
  });

  it('also carries A, which AI4CZ dropped', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '3002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.ancestors.map((p) => p.remoteId)).toEqual(['3000', '3001']);
    expect(outcome.conversation.root?.remoteId).toBe('3000');
  });

  it('names every participant on the branch', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '3002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.participants).toEqual(['alice', 'bob', 'charlie']);
  });
});

describe('case 4: a reply to a reply to a reply (PDF section 5)', () => {
  // A -> B -> C -> D, where D mentions the agent. This is the case the PDF
  // records as working for targeting and failing for context: AI4CZ captured
  // only C and never assembled A -> B -> C -> D.
  const a = article('alice', 'Original claim.', { statusId: '4000' });
  const b = article('bob', 'Counterpoint.', { statusId: '4001', replyingTo: ['alice'] });
  const c = article('charlie', 'Counter-counterpoint.', { statusId: '4002', replyingTo: ['bob'] });
  const d = article('dana', '@agent thoughts?', { statusId: '4003', replyingTo: ['charlie'] });
  const articles = page(a, b, c, d);

  it('targets D', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '4003', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.incoming.remoteId).toBe('4003');
  });

  it('assembles the full ancestry, oldest first — the AI4CZ regression', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '4003', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.ancestors.map((p) => p.remoteId)).toEqual(['4000', '4001', '4002']);
    expect(outcome.conversation.root?.remoteId).toBe('4000');
    expect(outcome.conversation.parent?.remoteId).toBe('4002');
  });
});

describe('case 5: sibling branches are excluded (section 37)', () => {
  // ROOT
  //  +-- branch A: @erin, @frank   (rendered below the focal: other replies)
  //  +-- branch B: @bob -> @charlie mentions the agent
  //
  // On a status page X renders the path to the focal above it and everything
  // else below. Posts below must never enter the context.
  const root = article('alice', 'Root post.', { statusId: '5000' });
  const parent = article('bob', 'On the branch that matters.', { statusId: '5001', replyingTo: ['alice'] });
  const focal = article('charlie', '@agent your view?', { statusId: '5002', replyingTo: ['bob'] });
  const other1 = article('erin', 'Unrelated reply on another branch.', { statusId: '5003' });
  const other2 = article('frank', 'Also unrelated.', { statusId: '5004' });
  const articles = page(root, parent, focal, other1, other2);

  it('keeps only the branch above the focal', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '5002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.ancestors.map((p) => p.remoteId)).toEqual(['5000', '5001']);
  });

  it('reports how many posts it deliberately left out', () => {
    const outcome = resolveBranch({ articles, focalStatusId: '5002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.excludedCount).toBe(2);
    expect(outcome.conversation.participants).not.toContain('erin');
    expect(outcome.conversation.participants).not.toContain('frank');
  });
});

describe('case 6: a mention under a post that quotes another post (PDF section 6)', () => {
  // POST A quotes POST B. @charlie replies to A mentioning the agent.
  // AI4CZ had no structured quote object at all; the quoted text sometimes
  // leaked into an article's inner text and sometimes did not.
  const a = article('alice', 'This is insane', { statusId: '6000' });
  const c = article('charlie', '@agent thoughts?', { statusId: '6001', replyingTo: ['alice'] });
  const quote = {
    remoteId: '5999',
    remoteUrl: 'https://x.com/dana/status/5999',
    authorHandle: 'dana',
    text: 'Treasury moved 400M tokens this morning.',
    media: [],
  };

  it('exposes the quoted post as structured data rather than as stray text', () => {
    const outcome = resolveBranch({ articles: page(a, c), focalStatusId: '6001', selfHandles: ME, quote });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.quote?.remoteId).toBe('5999');
    expect(outcome.conversation.quote?.authorHandle).toBe('dana');
    expect(outcome.conversation.quote?.text).toContain('400M tokens');
  });

  it('still targets the mention and not the quoted post', () => {
    const outcome = resolveBranch({ articles: page(a, c), focalStatusId: '6001', selfHandles: ME, quote });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.incoming.remoteId).toBe('6001');
  });
});

describe('case 7: the focal post cannot be found', () => {
  // AI4CZ returned `focal_article_not_found` and stopped. Anything else means
  // choosing a neighbour, which is how an automation replies to a stranger.
  it('refuses rather than falling back to a position', () => {
    const articles = page(article('alice', 'A.'), article('bob', 'B.'));
    const outcome = resolveBranch({ articles, focalStatusId: '999999', selfHandles: ME });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('focal_article_not_found');
    expect(outcome.detail).toContain('999999');
  });

  it('refuses when the page rendered nothing', () => {
    const outcome = resolveBranch({ articles: [], focalStatusId: '1', selfHandles: ME });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_articles');
  });
});

describe('case 8: the focal post rendered twice', () => {
  // X re-renders in a virtualised list, and AI4CZ guarded against the parent
  // coming back identical to the mention: `if (pt === mentionText) pt = ""`.
  it('does not present a duplicate of the mention as its own parent', () => {
    const dup = article('charlie', '@agent thoughts?', { statusId: '7000' });
    const focal = article('charlie', '@agent thoughts?', { statusId: '7001' });
    const outcome = resolveBranch({ articles: page(dup, focal), focalStatusId: '7001', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.parent).toBeNull();
    expect(parentTextOf(outcome.conversation)).toBeNull();
  });

  it('ignores a second article carrying the same status id', () => {
    const focal = article('charlie', '@agent thoughts?', { statusId: '7100' });
    const echo = { ...focal, text: 'stale render' };
    const outcome = resolveBranch({ articles: page(focal, echo), focalStatusId: '7100', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.ancestors).toHaveLength(0);
  });
});

describe('case 9: articles that are not posts', () => {
  it('drops promoted and placeholder articles, which carry no status id', () => {
    const promo: ArticleSnapshot = {
      index: 0,
      statusId: null,
      authorHandle: null,
      authorDisplayName: null,
      text: 'Discover more',
      url: null,
      createdAt: null,
      replyingTo: [],
    };
    const root = article('alice', 'Root.', { statusId: '8000' });
    const focal = article('bob', '@agent hi', { statusId: '8001', replyingTo: ['alice'] });
    const outcome = resolveBranch({ articles: page(promo, root, focal), focalStatusId: '8001', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.ancestors.map((p) => p.remoteId)).toEqual(['8000']);
  });
});

describe('case 10: bounded context on a long thread (section 36)', () => {
  it('keeps the root and the posts nearest the mention, and says what it dropped', () => {
    const chain = Array.from({ length: 20 }, (_, i) =>
      article(`user${i}`, `turn ${i}`, { statusId: String(9000 + i) }),
    );
    const focal = article('zoe', '@agent so what now?', { statusId: '9500', replyingTo: ['user19'] });
    const outcome = resolveBranch({
      articles: page(...chain, focal),
      focalStatusId: '9500',
      selfHandles: ME,
      maxAncestors: 5,
    });
    if (!outcome.ok) throw new Error(outcome.detail);

    const ids = outcome.conversation.ancestors.map((p) => p.remoteId);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe('9000'); // the root survives trimming
    expect(ids.at(-1)).toBe('9019'); // so does the direct parent
    expect(outcome.conversation.note).toContain('left out to bound the context');
  });
});

describe('case 11: the branch cross-check', () => {
  it('reports an unconfirmed branch when X names a different parent', () => {
    const a = article('alice', 'Root.', { statusId: '10000' });
    const b = article('bob', 'Middle.', { statusId: '10001' });
    // X says charlie is replying to alice, but render order puts bob above.
    const c = article('charlie', '@agent ?', { statusId: '10002', replyingTo: ['alice'] });
    const outcome = resolveBranch({ articles: page(a, b, c), focalStatusId: '10002', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.branchConfirmed).toBe(false);
    expect(outcome.conversation.note).toContain('replying to');
    // Render order still wins: the branch is reported, only flagged.
    expect(outcome.conversation.parent?.remoteId).toBe('10001');
  });

  it('treats a root post with no replying-to line as confirmed', () => {
    const solo = article('charlie', '@agent hello', { statusId: '11000' });
    const outcome = resolveBranch({ articles: page(solo), focalStatusId: '11000', selfHandles: ME });
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.conversation.parent).toBeNull();
    expect(outcome.conversation.branchConfirmed).toBe(true);
    expect(outcome.conversation.note).toContain('root of its own thread');
  });
});

describe('the action target is never an ancestor', () => {
  // The single invariant that separates "where to reply" from "what it is
  // about". Asserted over every fixture in this file at once.
  const cases: { name: string; articles: ArticleSnapshot[]; focal: string }[] = [
    {
      name: 'direct mention',
      articles: page(article('alice', 'A', { statusId: '20000' }), article('bob', '@agent', { statusId: '20001' })),
      focal: '20001',
    },
    {
      name: 'three levels deep',
      articles: page(
        article('alice', 'A', { statusId: '21000' }),
        article('bob', 'B', { statusId: '21001' }),
        article('charlie', 'C', { statusId: '21002' }),
        article('dana', '@agent', { statusId: '21003' }),
      ),
      focal: '21003',
    },
  ];

  for (const testCase of cases) {
    it(`holds for ${testCase.name}`, () => {
      const outcome = resolveBranch({
        articles: testCase.articles,
        focalStatusId: testCase.focal,
        selfHandles: ME,
      });
      if (!outcome.ok) throw new Error(outcome.detail);
      const { incoming, ancestors } = outcome.conversation;
      expect(incoming.remoteId).toBe(testCase.focal);
      expect(ancestors.map((p) => p.remoteId)).not.toContain(testCase.focal);
    });
  }
});

describe('reading the replying-to line', () => {
  it('pulls handles out of the line X renders above a reply', () => {
    const text = 'Charlie\n@charlie\n·\n2h\nReplying to @alice and @bob\n@agent what do you think?';
    expect(replyingToHandles(text)).toEqual(['alice', 'bob']);
  });

  it('returns nothing when there is no such line', () => {
    expect(replyingToHandles('Alice\n@alice\n·\n1h\nJust a post.')).toEqual([]);
  });

  it('is not fooled by the words appearing inside post text', () => {
    // The line must start with "Replying to"; a post that happens to contain
    // the phrase mid-sentence is not X's own marker.
    expect(replyingToHandles('Alice\n@alice\nI was replying to @bob earlier today.')).toEqual([]);
  });
});
