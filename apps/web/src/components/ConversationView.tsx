interface ContextMessage {
  role: string;
  authorHandle?: string | null;
  text: string;
}

interface ResolvedContext {
  targetAuthorHandle: string | null;
  targetUrl: string | null;
  incomingText: string;
  parentText: string | null;
  thread: ContextMessage[];
  conversation: { root?: { text?: string; authorHandle?: string | null } | null } | null;
  meta: Record<string, unknown>;
}

interface Retrieval {
  memoryId: string;
  scope: string;
  summary: string | null;
  content: string;
  reason: string;
}

/** One turn in the chain, rendered the same way wherever it came from. */
function Turn({
  label,
  who,
  text,
  ours,
}: {
  label: string;
  who: string | null;
  text: string;
  ours?: boolean;
}) {
  return (
    <li className={`rounded-lg border p-3 ${ours ? 'border-signal-calm/40 bg-signal-calm/[0.05]' : 'border-bone/10 bg-black/20'}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
        {label}
        {who && <span className="ml-2 normal-case tracking-normal">@{who.replace(/^@/, '')}</span>}
      </p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-bone">{text}</p>
    </li>
  );
}

/**
 * The conversation as AI17Z actually understood it.
 *
 * The thing that goes wrong with nested mentions is invisible in a flat list:
 * a mention four levels down reads identically to one at the top, and the
 * difference between them is the entire reason replies used to land on the
 * wrong post. Laying out root, ancestors, the incoming message and the answer
 * in order makes "did it understand where it was" a question somebody can
 * answer by looking.
 *
 * What was used is shown beside it -- memory, research, relationship -- and
 * what was thought is not. There is no chain-of-thought here and there should
 * not be: it is not stored, it is not shown, and an explanation reconstructed
 * after the fact would be a plausible story rather than a record.
 */
export function ConversationView({
  context,
  retrievals,
  reply,
}: {
  context: ResolvedContext | null;
  retrievals: Retrieval[];
  reply: string | null;
}) {
  if (!context) return null;

  const meta = context.meta ?? {};
  const research = meta.research as { findings?: { source: string; title: string }[]; failed?: unknown[] } | undefined;
  const relationship = meta.relationship as { summary?: string; familiarity?: string } | undefined;
  const engagement = meta.engagement as { decision?: string; reason?: string } | undefined;
  const root = context.conversation?.root;

  // Prior turns, oldest first, excluding the incoming message itself.
  const earlier = (context.thread ?? []).slice(0, -1);

  return (
    <section className="space-y-6">
      <div>
        <p className="eyebrow">The conversation</p>
        <h3 className="mt-2 text-base font-light text-bone">What it was answering, and where</h3>
      </div>

      <ol className="space-y-2">
        {root?.text && <Turn label="Root of the thread" who={root.authorHandle ?? null} text={root.text} />}
        {earlier.map((message, index) => (
          <Turn
            key={index}
            label={message.role === 'OUTBOUND' ? 'Your agent, earlier' : 'Earlier in the thread'}
            who={message.authorHandle ?? null}
            text={message.text}
            ours={message.role === 'OUTBOUND'}
          />
        ))}
        {context.parentText && <Turn label="The post above" who={null} text={context.parentText} />}
        <Turn label="What it was answering" who={context.targetAuthorHandle} text={context.incomingText} />
        {reply && <Turn label="What your agent said" who={null} text={reply} ours />}
      </ol>

      {/* What went into it. Never how it was reasoned about. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {engagement?.decision && (
          <div className="rounded-lg border border-bone/10 bg-black/20 p-3">
            <p className="eyebrow">Whether to answer</p>
            <p className="mt-1.5 break-words text-[13px] text-bone-dim">
              {engagement.decision.toLowerCase()} &mdash; {engagement.reason}
            </p>
          </div>
        )}

        {relationship?.summary && (
          <div className="rounded-lg border border-bone/10 bg-black/20 p-3">
            <p className="eyebrow">Who this is</p>
            <p className="mt-1.5 break-words text-[13px] text-bone-dim">
              {relationship.familiarity ? `${relationship.familiarity.toLowerCase()} — ` : ''}
              {relationship.summary}
            </p>
          </div>
        )}

        {research && (research.findings?.length || research.failed?.length) && (
          <div className="rounded-lg border border-bone/10 bg-black/20 p-3">
            <p className="eyebrow">Looked up</p>
            <ul className="mt-1.5 space-y-1 text-[13px] text-bone-dim">
              {(research.findings ?? []).map((finding, index) => (
                <li key={index} className="break-words">
                  {finding.source} &mdash; {finding.title}
                </li>
              ))}
              {(research.failed?.length ?? 0) > 0 && (
                // A gap that was looked for and not found is worth showing: it
                // is the difference between "did not check" and "could not".
                <li className="text-amber-300">{research.failed!.length} lookup(s) did not work.</li>
              )}
            </ul>
          </div>
        )}

        {retrievals.length > 0 && (
          <div className="rounded-lg border border-bone/10 bg-black/20 p-3">
            <p className="eyebrow">Remembered</p>
            <ul className="mt-1.5 space-y-1 text-[13px] text-bone-dim">
              {retrievals.slice(0, 6).map((memory) => (
                <li key={memory.memoryId} className="break-words">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">{memory.scope}</span>{' '}
                  {memory.summary?.trim() || memory.content.slice(0, 120)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
