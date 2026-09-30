import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, BookmarkPlus, ChevronDown, MessageSquare, Plus, RotateCcw, Send, Square, Trash2, Users } from 'lucide-react';
import { ApiError, del, get, patch, post } from '@app/lib/api';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { EmptyState, ErrorPanel, Loading, Modal, Spinner, StatusDot, Working } from '@app/components/ui';

/**
 * Owner chat: talking to your own agents.
 *
 * The agent here is the real one, answering with its own memory and able to
 * look at its own workings, so the screen's job is to make three things
 * obvious without jargon: who you are talking to, whether it is working, and
 * what an answer rested on. The last is behind a small "What this used"
 * control on each answer, so a normal conversation stays a conversation.
 */

interface AgentRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  state: string;
}

interface Conversation {
  id: string;
  title: string;
  kind: 'AGENT' | 'ROOM';
  archivedAt: string | null;
  updatedAt: string;
  participants?: string[];
  lastMessage?: string | null;
  lastAt?: string | null;
}

interface Participant {
  agentId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
}

interface Readiness {
  agentId: string;
  state: 'HEALTHY' | 'DEGRADED' | 'NOT_CONFIGURED' | 'UNKNOWN';
  detail: string;
  fixAt?: string;
}

interface Evidence {
  model?: { provider: string; model: string; latencyMs: number } | null;
  capabilities?: { id: string; outcome: string; detail: string; output: unknown }[];
  memories?: { id: string; scope: string; text: string; source: string | null }[];
  beliefs?: string[];
  research?: { findings: { source: string; title: string; url: string | null; query: string }[]; failed: { query: string; reason: string }[] } | null;
  usedLiveState?: boolean;
  corrections?: string[];
}

interface Message {
  id: string;
  authorKind: 'OWNER' | 'AGENT' | 'NOTICE';
  agentId: string | null;
  content: string;
  status: 'PENDING' | 'ANSWERING' | 'DONE' | 'FAILED' | 'CANCELLED';
  answers: string | null;
  evidence: Evidence;
  error: string | null;
  createdAt: string;
  answeredAt: string | null;
}

interface Save {
  id: string;
  messageId: string | null;
  agentId: string;
  target: 'MEMORY' | 'KNOWLEDGE';
}

interface ConversationDetail {
  conversation: Conversation;
  participants: Participant[];
  messages: Message[];
  saves: Save[];
}

/** What a capability is called where an owner reads it. */
const CAPABILITY_WORDS: Record<string, string> = {
  'agent.self_state': 'Read its own setup',
  'agent.health_report': 'Checked what is working',
  'agent.recent_activity': 'Read what it did recently',
  'agent.growth_summary': 'Measured its growth',
  'agent.learning_status': 'Read what it is learning',
  'agent.current_goals': 'Read its goals',
  'agent.recent_reflections': 'Read its recent reflections',
  'agent.explain_belief': 'Read the evidence for a belief',
  'agent.relationship_summary': 'Read who it knows',
  'agent.explain_action': 'Read the record of an action',
  'agent.explain_silence': 'Read why it stayed silent',
  'agent.owner_decisions': 'Read your decisions',
  'agent.recent_changes': 'Read recent setup changes',
  'agent.change_setting': 'Changed one of its own settings',
  'agent.undo_change': 'Undid one of its own changes',
  'agent.cannot_change': 'Declined something chat cannot change',
  'agent.my_changes': 'Read what it changed from chat',
};

interface ChangeOutput {
  changeId: string;
  status: string;
  risk: string;
  summary: string;
  detail: string;
}

const CHANGE_IDS = new Set(['agent.change_setting', 'agent.undo_change', 'agent.cannot_change']);

/** The changes an answer made or asked about, from the capabilities it used. */
function changesIn(used: NonNullable<Evidence['capabilities']>): ChangeOutput[] {
  return used
    .filter((c) => CHANGE_IDS.has(c.id) && c.outcome === 'SUCCEEDED' && c.output && typeof (c.output as ChangeOutput).changeId === 'string')
    .map((c) => c.output as ChangeOutput);
}

const CHANGE_LABEL: Record<string, string> = {
  APPLIED: 'Changed',
  AWAITING_CONFIRMATION: 'Waiting for you',
  DECLINED: 'Left as it was',
  UNDONE: 'Undone',
  REFUSED: 'Not changed from chat',
  FAILED: 'Not changed',
};

/**
 * One change an agent made to itself, with the one thing an owner may want to
 * do about it: undo it, or confirm or decline one that is waiting.
 */
function ChangeCard({ change }: { change: ChangeOutput }) {
  const [status, setStatus] = useState(change.status);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (verb: 'undo' | 'confirm' | 'decline') => {
    setBusy(true);
    setNote(null);
    try {
      const out = await post<{ change: { status: string }; message: string }>(`/api/agent-changes/${change.changeId}/${verb}`, {});
      setStatus(out.change.status);
      setNote(out.message);
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-ink-line bg-ink-panel/40 px-3.5 py-2.5 text-sm">
      <p className="text-[11px] uppercase tracking-wide text-bone-faint">{CHANGE_LABEL[status] ?? status}</p>
      <p className="mt-0.5 break-words text-bone">{change.summary}</p>
      {note && <p className="mt-1 break-words text-xs text-bone-dim">{note}</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        {status === 'APPLIED' && (
          <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void act('undo')}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Undo
          </button>
        )}
        {status === 'AWAITING_CONFIRMATION' && (
          <>
            <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={busy} onClick={() => void act('confirm')}>
              Confirm
            </button>
            <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void act('decline')}>
              Leave it as it is
            </button>
          </>
        )}
        {busy && <Spinner />}
      </div>
    </div>
  );
}

const READY_LABEL: Record<Readiness['state'], string> = {
  HEALTHY: 'Working',
  DEGRADED: 'Something is off',
  NOT_CONFIGURED: 'Not set up',
  UNKNOWN: 'Unknown',
};

const READY_DOT: Record<Readiness['state'], 'live' | 'wait' | 'fail' | 'idle'> = {
  HEALTHY: 'live',
  DEGRADED: 'wait',
  NOT_CONFIGURED: 'idle',
  UNKNOWN: 'idle',
};

export function ChatPage() {
  const { conversationId } = useParams();
  const [showArchived, setShowArchived] = useState(false);
  const list = useResource<{ conversations: Conversation[] }>(`/api/chat/conversations?archived=${showArchived}`, [showArchived]);
  const agents = useResource<{ items: AgentRow[] }>('/api/agents');
  const names = useMemo(() => new Map((agents.data?.items ?? []).map((a) => [a.id, a])), [agents.data]);

  return (
    <main className="mx-auto max-w-page px-4 pb-24 pt-32 sm:px-8">
      <div className="grid gap-6 md:grid-cols-[18rem_minmax(0,1fr)]">
        <aside aria-label="Conversations" className={conversationId ? 'hidden md:block' : ''}>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl font-light text-bone">Chat</h1>
            <Link to="/chat" className="btn-ghost px-3 py-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New
            </Link>
          </div>
          <p className="mt-1 text-sm text-bone-faint">Private. Only you and your agents read these.</p>
          {list.loading && !list.data ? (
            <div className="mt-6">
              <Spinner />
            </div>
          ) : list.error ? (
            <p className="mt-4 text-sm text-signal-fail">{list.error}</p>
          ) : (
            <ul className="mt-4 space-y-1">
              {(list.data?.conversations ?? []).map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/chat/${c.id}`}
                    aria-current={c.id === conversationId ? 'page' : undefined}
                    className={`block rounded-lg px-3 py-2.5 transition-colors ${
                      c.id === conversationId ? 'bg-ink-panel text-bone' : 'text-bone-dim hover:bg-ink-panel/60'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm">
                      {c.kind === 'ROOM' ? <Users className="h-3.5 w-3.5 shrink-0" aria-label="Room" /> : <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      <span className="truncate">{c.title || 'Untitled'}</span>
                    </span>
                    {c.lastMessage && <span className="mt-0.5 block truncate text-[12px] text-bone-faint">{c.lastMessage}</span>}
                  </Link>
                </li>
              ))}
              {(list.data?.conversations ?? []).length === 0 && (
                <li className="px-3 py-2 text-sm text-bone-faint">{showArchived ? 'Nothing archived.' : 'No conversations yet.'}</li>
              )}
            </ul>
          )}
          <button type="button" className="btn-quiet mt-3 px-3 text-xs" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Show current conversations' : 'Show archived'}
          </button>
        </aside>

        <section aria-label="Conversation" className="min-w-0">
          {conversationId ? (
            <ConversationView key={conversationId} id={conversationId} agents={names} onChanged={list.reload} />
          ) : (
            <StartPanel agents={agents.data?.items ?? null} loading={agents.loading} onStarted={list.reload} />
          )}
        </section>
      </div>
    </main>
  );
}

// ── Starting ─────────────────────────────────────────────────────────────────

function StartPanel({ agents, loading, onStarted }: { agents: AgentRow[] | null; loading: boolean; onStarted: () => void }) {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading && !agents) return <Loading label="Loading your agents" />;
  if (!agents || agents.length === 0) {
    return (
      <EmptyState
        title="You have no agents to talk to yet."
        detail="Create one first. Chat talks to the real agent, with its own memory and setup."
        action={<Link to="/agents/new" className="btn-primary">Create an agent</Link>}
      />
    );
  }

  const toggle = (id: string) =>
    setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : current.length >= 4 ? current : [...current, id]));

  const start = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await post<{ conversation: Conversation }>('/api/chat/conversations', { agentIds: ids });
      onStarted();
      navigate(`/chat/${conversation.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The conversation could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg text-bone">Talk to an agent</h2>
        <p className="mt-1 text-sm text-bone-dim">
          Ask it anything, including about itself: what it did this week, why it did not answer something, what is broken, what it is learning.
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void start([a.id])}
                className="flex w-full items-center gap-3 rounded-lg border border-ink-line bg-ink-panel px-3 py-2.5 text-left transition-colors hover:border-bone-faint"
              >
                <AgentGlyph agentId={a.id} name={a.name} imageUrl={a.avatarUrl} size="sm" interactive={false} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-bone">{a.name}</span>
                  <span className="block text-[11px] text-bone-faint">{a.state.toLowerCase()}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {agents.length > 1 && (
        <fieldset>
          <legend className="text-lg text-bone">Or open a room</legend>
          <p className="mt-1 text-sm text-bone-dim">
            Up to four agents in one conversation. Each answers with only its own memory; what they share is what is said in the room.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {agents.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-full border border-ink-line px-3 py-1.5 text-sm text-bone-dim has-[:checked]:border-bone has-[:checked]:text-bone">
                <input type="checkbox" className="accent-current" checked={chosen.includes(a.id)} onChange={() => toggle(a.id)} />
                {a.name}
              </label>
            ))}
          </div>
          <button type="button" className="btn-primary mt-4" disabled={busy || chosen.length < 2} onClick={() => void start(chosen)}>
            {busy ? <Spinner /> : <Users className="h-4 w-4" aria-hidden />}
            Open a room with {chosen.length < 2 ? 'two or more' : chosen.length}
          </button>
        </fieldset>
      )}
      {error && <p className="text-sm text-signal-fail">{error}</p>}
    </div>
  );
}

// ── The conversation ─────────────────────────────────────────────────────────

function ConversationView({ id, agents, onChanged }: { id: string; agents: Map<string, AgentRow>; onChanged: () => void }) {
  const navigate = useNavigate();
  const detail = useResource<ConversationDetail>(`/api/chat/conversations/${id}`);
  const ready = useResource<{ agents: Readiness[] }>(`/api/chat/conversations/${id}/readiness`);
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [text, setText] = useState('');
  const [to, setTo] = useState<'ALL' | string>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const shown = data ?? detail.data;
  const waiting = Boolean(shown?.messages.some((m) => m.status === 'PENDING' || m.status === 'ANSWERING'));
  const refresh = () =>
    void get<ConversationDetail>(`/api/chat/conversations/${id}`)
      .then(setData)
      .catch(() => undefined);
  usePolling(refresh, 1_500, waiting);

  const count = shown?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  if (detail.loading && !shown) return <Loading label="Opening the conversation" />;
  if (detail.error || !shown) {
    return (
      <ErrorPanel
        title="That conversation could not be opened."
        detail={detail.error}
        actions={<Link to="/chat" className="btn-ghost">Back to chat</Link>}
      />
    );
  }

  const { conversation, participants, messages, saves } = shown;
  const room = conversation.kind === 'ROOM';
  const nameOf = (agentId: string | null) => participants.find((p) => p.agentId === agentId)?.name ?? agents.get(agentId ?? '')?.name ?? 'An agent';

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await post(`/api/chat/conversations/${id}/messages`, { content, ...(room ? { to: to === 'ALL' ? 'ALL' : [to] } : {}) });
      setText('');
      refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be sent.');
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const act = async (run: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await run();
      refresh();
      onChanged();
      after?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    }
  };

  return (
    <div className="flex min-h-[70vh] flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-line pb-4">
        <div className="min-w-0">
          <Link to="/chat" className="btn-quiet mb-2 px-0 text-xs md:hidden">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All conversations
          </Link>
          <h2 className="truncate text-lg text-bone">{conversation.title || 'Untitled'}</h2>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Who is here">
            {participants.map((p) => {
              const r = ready.data?.agents.find((a) => a.agentId === p.agentId);
              return (
                <li key={p.agentId} className="flex items-center gap-2 text-[12px] text-bone-dim">
                  <Link to={`/agents/${p.agentId}`} className="text-bone hover:underline">
                    {p.name}
                  </Link>
                  {r ? (
                    <span title={r.detail}>
                      <StatusDot state={READY_DOT[r.state]} label={READY_LABEL[r.state]} />
                    </span>
                  ) : (
                    <span className="text-bone-faint">checking</span>
                  )}
                </li>
              );
            })}
            {participants.length === 0 && <li className="text-[12px] text-bone-faint">Nobody is left in this conversation.</li>}
          </ul>
          {(ready.data?.agents ?? [])
            .filter((r) => r.state !== 'HEALTHY')
            .map((r) => (
              <p key={r.agentId} className="mt-1 break-words text-[12px] text-bone-faint">
                {participants.find((p) => p.agentId === r.agentId)?.name}: {r.detail}{' '}
                {r.fixAt && (
                  <Link to={r.fixAt} className="text-bone-dim underline">
                    Set it up
                  </Link>
                )}
              </p>
            ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="btn-quiet px-2 text-xs"
            onClick={() => void act(() => patch(`/api/chat/conversations/${id}`, { archived: !conversation.archivedAt }))}
          >
            <Archive className="h-3.5 w-3.5" aria-hidden />
            {conversation.archivedAt ? 'Unarchive' : 'Archive'}
          </button>
          {room && messages.length > 0 && (
            <button type="button" className="btn-quiet px-2 text-xs" onClick={() => void act(() => post(`/api/chat/conversations/${id}/clear`, {}))}>
              Clear room
            </button>
          )}
          <button type="button" className="btn-quiet px-2 text-xs text-signal-fail" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete
          </button>
        </div>
      </header>

      <ol className="flex-1 space-y-5 py-6" aria-live="polite">
        {messages.length === 0 && (
          <li className="text-sm text-bone-faint">
            {room
              ? 'Ask all of them something, or name one with @. For example: "Both of you, what did you learn this week?"'
              : 'Try: "What have you been doing this week?", "What is broken right now?", or paste a post and ask why it did not answer.'}
          </li>
        )}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            name={m.authorKind === 'OWNER' ? 'You' : nameOf(m.agentId)}
            saved={saves.some((s) => s.messageId === m.id)}
            onRetry={() => void act(() => post(`/api/chat/messages/${m.id}/retry`, {}))}
            onSave={() => setSaving(m)}
          />
        ))}
        <div ref={bottom} />
      </ol>

      <form onSubmit={(e) => void send(e)} className="sticky bottom-0 space-y-2 border-t border-ink-line bg-ink pb-2 pt-4">
        {room && participants.length > 1 && (
          <div role="radiogroup" aria-label="Who answers" className="flex flex-wrap gap-1.5">
            {[{ id: 'ALL', label: 'Ask all' }, ...participants.map((p) => ({ id: p.agentId, label: p.name }))].map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={to === option.id}
                onClick={() => setTo(option.id)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  to === option.id ? 'border-bone text-bone' : 'border-ink-line text-bone-faint hover:text-bone-dim'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            className="field min-h-[3rem] flex-1 resize-y"
            rows={2}
            value={text}
            disabled={Boolean(conversation.archivedAt)}
            placeholder={conversation.archivedAt ? 'Archived. Unarchive to keep talking.' : `Message ${room ? 'the room' : (participants[0]?.name ?? '')}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          {waiting ? (
            <button type="button" className="btn-ghost" onClick={() => void act(() => post(`/api/chat/conversations/${id}/stop`, {}))}>
              <Square className="h-4 w-4" aria-hidden />
              Stop
            </button>
          ) : (
            <button type="submit" className="btn-primary" disabled={sending || !text.trim() || Boolean(conversation.archivedAt)}>
              {sending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
              <span className="sr-only sm:not-sr-only">Send</span>
            </button>
          )}
        </div>
        {error && <p className="text-sm text-signal-fail">{error}</p>}
      </form>

      {saving && (
        <SaveModal
          conversationId={id}
          message={saving}
          participants={participants}
          room={room}
          onClose={() => setSaving(null)}
          onSaved={() => {
            setSaving(null);
            refresh();
          }}
        />
      )}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this conversation?">
        <p className="text-sm text-bone-dim">
          The messages go. Anything you saved from it to an agent's memory or knowledge stays saved.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void act(() => del(`/api/chat/conversations/${id}`), () => navigate('/chat'))}
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}

function MessageItem({
  message,
  name,
  saved,
  onRetry,
  onSave,
}: {
  message: Message;
  name: string;
  saved: boolean;
  onRetry: () => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = message.status === 'PENDING' || message.status === 'ANSWERING';
  const seconds = useElapsed(busy);
  const owner = message.authorKind === 'OWNER';
  const evidence = message.evidence ?? {};
  const used = evidence.capabilities ?? [];
  const hasEvidence =
    used.length > 0 ||
    (evidence.memories ?? []).length > 0 ||
    (evidence.beliefs ?? []).length > 0 ||
    Boolean(evidence.research && (evidence.research.findings.length > 0 || evidence.research.failed.length > 0));

  return (
    <li className={owner ? 'ml-auto max-w-[85%]' : 'max-w-[95%]'}>
      <p className={`text-[11px] ${owner ? 'text-right' : ''} text-bone-faint`}>
        {name} · {timeAgo(message.answeredAt ?? message.createdAt)}
        {!owner && evidence.usedLiveState && <span className="ml-2 text-bone-dim">checked its own records</span>}
      </p>
      {busy ? (
        <div className="mt-1">
          <Working
            label={message.status === 'PENDING' ? `${name} is waiting its turn` : `${name} is answering`}
            seconds={seconds}
            slowAfter={25}
            slowHint="Looking something up or waiting on the model. Nothing has failed."
          />
        </div>
      ) : message.status === 'FAILED' || message.status === 'CANCELLED' ? (
        <div className="mt-1 rounded-lg border border-signal-fail/25 bg-signal-fail/[0.04] px-3.5 py-3">
          <p className="break-words text-sm text-bone-dim">{message.error ?? 'No answer.'}</p>
          <button type="button" className="btn-quiet mt-2 px-0 text-xs" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
        </div>
      ) : (
        <div className={`mt-1 rounded-lg px-3.5 py-3 ${owner ? 'bg-ink-panel text-bone' : 'border border-ink-line text-bone'}`}>
          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{message.content}</p>
        </div>
      )}
      {!busy && !owner && message.status === 'DONE' && changesIn(used).map((c) => <ChangeCard key={c.changeId} change={c} />)}
      {!busy && message.status === 'DONE' && (
        <div className={`mt-1 flex flex-wrap gap-3 ${owner ? 'justify-end' : ''}`}>
          {!owner && hasEvidence && (
            <button type="button" className="btn-quiet px-0 text-[11px]" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
              What this used
            </button>
          )}
          <button type="button" className="btn-quiet px-0 text-[11px]" onClick={onSave} disabled={saved}>
            <BookmarkPlus className="h-3 w-3" aria-hidden />
            {saved ? 'Saved' : 'Remember this'}
          </button>
        </div>
      )}
      {open && <EvidenceDrawer evidence={evidence} />}
    </li>
  );
}

/** What an answer rested on: sources, never reasoning. */
function EvidenceDrawer({ evidence }: { evidence: Evidence }) {
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-ink-line bg-ink-panel p-3 text-[12px] text-bone-dim">
      {(evidence.capabilities ?? []).length > 0 && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">Records it read</p>
          <ul className="mt-1 space-y-1.5">
            {evidence.capabilities!.map((c, i) => (
              <li key={`${c.id}-${i}`}>
                <details>
                  <summary className="cursor-pointer text-bone">
                    {CAPABILITY_WORDS[c.id] ?? c.id}
                    {c.outcome !== 'SUCCEEDED' && <span className="ml-2 text-signal-wait">did not run: {c.detail}</span>}
                  </summary>
                  {c.output !== null && c.output !== undefined && (
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-bone-faint">
                      {JSON.stringify(c.output, null, 2)}
                    </pre>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {evidence.research && (evidence.research.findings.length > 0 || evidence.research.failed.length > 0) && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">What it looked up</p>
          <ul className="mt-1 space-y-1">
            {evidence.research.findings.map((f, i) => (
              <li key={`${f.url ?? f.title}-${i}`} className="break-words">
                <span className="text-bone-faint">{f.source}: </span>
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-bone underline decoration-bone-faint">
                    {f.title || f.url}
                  </a>
                ) : (
                  f.title
                )}
              </li>
            ))}
            {evidence.research.failed.map((f, i) => (
              <li key={`failed-${i}`} className="break-words text-signal-wait">
                Could not check "{f.query}": {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(evidence.memories ?? []).length > 0 && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">What it remembered</p>
          <ul className="mt-1 space-y-1">
            {evidence.memories!.map((m) => (
              <li key={m.id} className="break-words">
                <span className="text-bone-faint">{m.scope.toLowerCase()}</span> {m.text}
                {m.source && <span className="text-bone-faint"> ({m.source})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(evidence.beliefs ?? []).length > 0 && (
        <p>
          <span className="text-bone-faint">Beliefs it was reminded of: </span>
          {evidence.beliefs!.join(', ')}
        </p>
      )}
      {evidence.model && (
        <p className="text-bone-faint">
          Written by {evidence.model.model} in {(evidence.model.latencyMs / 1000).toFixed(1)}s.
        </p>
      )}
    </div>
  );
}

// ── Keeping something ────────────────────────────────────────────────────────

function SaveModal({
  conversationId,
  message,
  participants,
  room,
  onClose,
  onSaved,
}: {
  conversationId: string;
  message: Message;
  participants: Participant[];
  room: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState(message.content);
  const [agentIds, setAgentIds] = useState<string[]>(
    message.agentId ? [message.agentId] : participants.map((p) => p.agentId),
  );
  const [kind, setKind] = useState<'WORLD' | 'SELF' | 'KNOWLEDGE'>('WORLD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/chat/conversations/${conversationId}/saves`, {
        messageId: message.id,
        content,
        agentIds,
        target: kind === 'KNOWLEDGE' ? 'KNOWLEDGE' : 'MEMORY',
        about: kind === 'SELF' ? 'SELF' : 'WORLD',
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Remember this">
      <p className="text-sm text-bone-dim">
        Conversations are not memory. Only what you save here is kept, and only by the agents you choose.
      </p>
      <label htmlFor="save-content" className="mt-4 block text-[12px] text-bone-faint">
        What to keep
      </label>
      <textarea id="save-content" className="field mt-1 min-h-[6rem] w-full" value={content} onChange={(e) => setContent(e.target.value)} />
      {room && (
        <fieldset className="mt-4">
          <legend className="text-[12px] text-bone-faint">Keep it for</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {participants.map((p) => (
              <label key={p.agentId} className="flex items-center gap-2 text-sm text-bone-dim">
                <input
                  type="checkbox"
                  checked={agentIds.includes(p.agentId)}
                  onChange={() =>
                    setAgentIds((ids) => (ids.includes(p.agentId) ? ids.filter((x) => x !== p.agentId) : [...ids, p.agentId]))
                  }
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="mt-4">
        <legend className="text-[12px] text-bone-faint">As</legend>
        <div className="mt-1 space-y-1 text-sm text-bone-dim">
          {(
            [
              ['WORLD', 'A fact about the world, in its memory'],
              ['SELF', 'Something about itself, in its memory'],
              ['KNOWLEDGE', room ? 'Shared project knowledge, as a knowledge source for each one chosen' : 'A knowledge source it can read'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="save-kind" checked={kind === value} onChange={() => setKind(value)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="mt-3 text-sm text-signal-fail">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Do not save
        </button>
        <button type="button" className="btn-primary" disabled={busy || !content.trim() || agentIds.length === 0} onClick={() => void save()}>
          {busy ? <Spinner /> : null}
          Save
        </button>
      </div>
    </Modal>
  );
}
