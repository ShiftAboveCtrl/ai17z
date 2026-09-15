import { useResource } from '@app/lib/hooks';
import { Spinner } from '@app/components/ui';
import { Gaps } from './shared';

/**
 * One person, in two halves that are never merged.
 *
 * **What passed between us** comes from relationship memory: replies the agent
 * actually published and messages it actually received. **What their account
 * says** is an observation of a public timeline, read when somebody asked for
 * it, carrying when it was read and what the reader could not see.
 *
 * Keeping them apart is not a layout preference. `relationships.topics` renders
 * in a prompt as "You have discussed: ...", so a screen that blended the two
 * would let "they post about Solana" become a conversation the agent then
 * refers to out loud. The headings here say which is which for the same reason
 * the data does.
 */

interface Reading {
  sampleSize?: number;
  confident?: boolean;
  topics?: { term: string; count: number }[];
  hashtags?: { term: string; count: number }[];
  mentions?: { term: string; count: number }[];
  mix?: { posts: number; replies: number; quotes: number };
  postsPerDay?: number | null;
  earliest?: string | null;
  latest?: string | null;
  typicalLikes?: number | null;
  typicalReplies?: number | null;
  engagementSampleSize?: number;
  examples?: { id: string; text: string; createdAt: string | null; url: string | null }[];
}

export interface PersonDetail {
  handle: string;
  relationship: {
    displayName: string | null;
    userId: string | null;
    familiarity: string;
    disposition: string;
    interactionCount: number;
    inboundCount: number;
    outboundCount: number;
    lastInteractionAt: string | null;
    summary: string;
    ownerNote: string;
    topics: string[];
    callbacks: { label: string; detail: string; uses: number }[];
  } | null;
  observed: {
    handle: string;
    userId: string | null;
    displayName: string | null;
    bio: string | null;
    followers: number | null;
    following: number | null;
    posts: number | null;
    verified: boolean | null;
    protected: boolean | null;
    location: string | null;
    website: string | null;
    joinedAt: string | null;
    outcome: string;
    detail: string;
    backend: string;
    observedAt: string;
    gaps: string[];
    observations: Reading;
  } | null;
  said: {
    eventId: string;
    type: string;
    text: string;
    url: string | null;
    occurredAt: string | null;
    state: string;
    replyText: string | null;
    replyUrl: string | null;
    repliedAt: string | null;
    foundBy: string[];
  }[];
}

const STATES: Record<string, string> = {
  REPLIED: 'Answered',
  DRY_RUN: 'Drafted, not sent',
  DECLINED: 'Decided not to answer',
  NEEDS_REVIEW: 'Waiting for you',
  WORKING: 'Being worked on',
  FAILED: 'Failed',
  NOT_ACTIONED: 'Not answered',
};

function when(iso: string | null): string {
  if (!iso) return 'at an unknown time';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';
  return at.toLocaleString();
}

function count(value: number | null | undefined): string {
  // Null is "the reader could not see this", which is not the same claim as a
  // number and must not be rendered as one.
  return typeof value === 'number' ? value.toLocaleString() : 'not visible';
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-[12px] leading-relaxed">
      <span className="w-28 shrink-0 text-bone-faint">{label}</span>
      <span className="min-w-0 break-words text-bone-dim">{value}</span>
    </div>
  );
}

function Terms({ items, label }: { items: { term: string; count: number }[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{label}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item.term}
            className="rounded-md border border-ink-line px-2 py-0.5 text-[12px] text-bone-dim"
            // The count is what makes this evidence rather than a word cloud.
            title={`${item.count} time${item.count === 1 ? '' : 's'} in the posts that were read`}
          >
            {item.term} <span className="font-mono text-[10px] text-bone-faint">{item.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PersonPanel({ agentId, handle }: { agentId: string; handle: string }) {
  const view = useResource<PersonDetail>(`/api/agents/${agentId}/people/${encodeURIComponent(handle)}`);

  if (view.loading) return <Spinner />;
  if (view.error || !view.data) {
    return <p className="text-[12px] text-bone-faint">{view.error ?? 'That could not be loaded.'}</p>;
  }

  const { relationship, observed, said } = view.data;
  const reading = observed?.observations ?? {};

  return (
    <div className="space-y-5 border-t border-ink-line pt-4">
      {/* ── What their account says ─────────────────────────────────────── */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">What their account says</p>

        {!observed && (
          <p className="mt-2 text-[12px] leading-relaxed text-bone-faint">
            Nobody has read this account yet. Reading it asks X for their profile and recent posts through the browser
            you are signed in to — it never follows, likes, replies or messages anybody.
          </p>
        )}

        {observed && observed.outcome !== 'OK' && (
          // A refusal is an answer. "They made their account private" and
          // "nobody has looked" are different things to tell somebody.
          <p className="mt-2 break-words text-[12px] leading-relaxed text-bone-dim">{observed.detail}</p>
        )}

        {observed && observed.outcome === 'OK' && (
          <div className="mt-2 space-y-1.5">
            {observed.bio && <p className="break-words text-[13px] leading-relaxed text-bone-dim">{observed.bio}</p>}
            <div className="mt-3 space-y-1">
              <Row label="Followers" value={count(observed.followers)} />
              <Row label="Following" value={count(observed.following)} />
              <Row label="Posts" value={count(observed.posts)} />
              {observed.location && <Row label="Location" value={observed.location} />}
              {observed.joinedAt && <Row label="On X since" value={when(observed.joinedAt)} />}
              {observed.userId && <Row label="Account id" value={observed.userId} />}
              {reading.postsPerDay !== null && reading.postsPerDay !== undefined && (
                <Row
                  label="Posts a day"
                  value={`${reading.postsPerDay} across the ${reading.sampleSize ?? 0} posts that were read`}
                />
              )}
              {reading.mix && (
                <Row
                  label="What they write"
                  value={`${reading.mix.replies} replies, ${reading.mix.posts} posts, ${reading.mix.quotes} quotes`}
                />
              )}
              {reading.typicalLikes !== null && reading.typicalLikes !== undefined && (
                <Row
                  label="Typical post"
                  value={`${reading.typicalLikes} likes, ${reading.typicalReplies ?? 0} replies (middle of ${reading.engagementSampleSize ?? 0} counted)`}
                />
              )}
            </div>

            <Terms items={reading.topics ?? []} label="Keeps coming up" />
            <Terms items={reading.hashtags ?? []} label="Hashtags" />
            <Terms items={reading.mentions ?? []} label="Talks to or about" />

            {(reading.examples ?? []).length > 0 && (
              <div className="mt-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
                  Some of what they wrote
                </p>
                <ul className="mt-2 space-y-2">
                  {(reading.examples ?? []).map((example) => (
                    <li key={example.id} className="rounded-lg border border-ink-line px-3 py-2">
                      <p className="break-words text-[12px] leading-relaxed text-bone-dim">{example.text}</p>
                      {example.url && (
                        <a
                          className="mt-1 inline-block break-all text-[11px] text-bone-faint hover:text-bone-dim"
                          href={example.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {example.url}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-3 break-words text-[11px] leading-relaxed text-bone-faint">
              Read {when(observed.observedAt)} by {observed.backend}.
              {reading.confident === false && reading.sampleSize
                ? ` This rests on ${reading.sampleSize} posts, which is a small sample.`
                : ''}
            </p>
          </div>
        )}

        {observed && <Gaps items={observed.gaps} label="Not seen" />}
      </section>

      {/* ── What has passed between us ──────────────────────────────────── */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">What has passed between you</p>
        {!relationship && (
          <p className="mt-2 text-[12px] leading-relaxed text-bone-faint">
            This agent has never exchanged anything with them.
          </p>
        )}
        {relationship && (
          <div className="mt-2 space-y-1">
            <Row
              label="How well known"
              value={`${relationship.familiarity.toLowerCase()} — ${relationship.inboundCount} from them, ${relationship.outboundCount} from the agent`}
            />
            <Row label="Last exchange" value={when(relationship.lastInteractionAt)} />
            {relationship.disposition !== 'NEUTRAL' && (
              <Row label="You marked them" value={relationship.disposition.toLowerCase()} />
            )}
            {relationship.topics.length > 0 && (
              // Only ever what the agent and this person actually discussed.
              // Never filled from the timeline read above it.
              <Row label="You discussed" value={relationship.topics.join(', ')} />
            )}
            {relationship.ownerNote && <Row label="Your note" value={relationship.ownerNote} />}
          </div>
        )}
      </section>

      {/* ── What this agent saw them say ────────────────────────────────── */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
          What this agent saw them say
        </p>
        {said.length === 0 && (
          <p className="mt-2 text-[12px] leading-relaxed text-bone-faint">Nothing of theirs has reached this agent.</p>
        )}
        <ul className="mt-2 space-y-2">
          {said.map((item) => (
            <li key={item.eventId} className="rounded-lg border border-ink-line px-3 py-2">
              <p className="break-words text-[12px] leading-relaxed text-bone-dim">{item.text}</p>
              <p className="mt-1 text-[11px] text-bone-faint">
                {when(item.occurredAt)} · {STATES[item.state] ?? item.state}
                {item.foundBy.length > 0 ? ` · found by ${item.foundBy.join(', ')}` : ''}
              </p>
              {item.replyText && (
                <p className="mt-2 break-words border-l border-ink-line pl-3 text-[12px] leading-relaxed text-bone-faint">
                  The agent answered: {item.replyText}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
