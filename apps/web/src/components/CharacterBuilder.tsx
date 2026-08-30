import { useRef, useState } from 'react';
import { Download, FileText, Sparkles, Upload, Wand2 } from 'lucide-react';
import type { CharacterAnswers, CharacterCompleteness } from '@xbam/shared/contracts';
import { ApiError, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { ErrorPanel, Field, Spinner } from './ui';

/**
 * Four ways to describe a character, and the same answers out of all of them.
 *
 * Typing ten fields is the honest way and almost nobody does it, so the other
 * three exist: say what you want in a paragraph and let the agent's own model
 * fill it in; hand a brief to whatever assistant you already use and bring the
 * answer back; or point it at a public account and learn from what that account
 * actually posts.
 *
 * Nothing here saves. Every route produces a draft with a completeness score,
 * and the person reads it before it becomes the agent.
 */

type Mode = 'describe' | 'template' | 'learn';

export interface CharacterDraft {
  answers: CharacterAnswers;
  completeness: CharacterCompleteness;
  source: 'TYPED' | 'DESCRIBED' | 'TEMPLATE' | 'LEARNED';
}

export function CharacterBuilder({
  agentId,
  onDraft,
}: {
  agentId: string;
  onDraft: (draft: CharacterDraft) => void;
}) {
  const [mode, setMode] = useState<Mode>('describe');

  return (
    <div className="space-y-5 rounded-xl border border-ink-line bg-ink-raised/30 p-5">
      <div>
        <p className="eyebrow mb-1">Build the character for me</p>
        <p className="text-[13px] leading-relaxed text-bone-faint">
          Any of these fills in every field. You see the result before it is saved.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {(
          [
            ['describe', 'Describe it', Wand2, 'Say what you want in a paragraph'],
            ['template', 'Use a brief', FileText, 'Fill one in with another assistant'],
            ['learn', 'Learn from an account', Sparkles, 'Read what somebody actually posts'],
          ] as const
        ).map(([value, label, Icon, hint]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
              mode === value
                ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                : 'border-ink-line text-bone-dim hover:border-bone-faint'
            }`}
          >
            <span className="flex items-center gap-2 text-sm">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {label}
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-bone-faint">{hint}</span>
          </button>
        ))}
      </div>

      {mode === 'describe' && <DescribeIt agentId={agentId} onDraft={onDraft} />}
      {mode === 'template' && <UseTemplate agentId={agentId} onDraft={onDraft} />}
      {mode === 'learn' && <LearnFromAccount agentId={agentId} onDraft={onDraft} />}
    </div>
  );
}

/** The agent's own model turns a paragraph into every field. */
function DescribeIt({ agentId, onDraft }: { agentId: string; onDraft: (draft: CharacterDraft) => void }) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<CharacterDraft>(`/api/agents/${agentId}/character/describe`, { description });
      onDraft({ ...result, source: 'DESCRIBED' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be built.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Field
        label="Who is this character?"
        htmlFor="describe"
        hint="Be as specific as you like. What they care about, how they talk, what they would never say, who they are talking to."
      >
        <textarea
          id="describe"
          rows={6}
          className="field resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A dry comedian who mostly talks about airports and small indignities. Never explains a joke, never punches down, undercuts his own point before anyone else can. Talks to people who are already tired."
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void build()}
          disabled={busy || description.trim().length < 20}
        >
          {busy ? <Spinner /> : <Wand2 className="h-4 w-4" aria-hidden />}
          Build the character
        </button>
        <span className="text-[11px] text-bone-faint">Uses the model you connected to this agent.</span>
      </div>
      {error && <ErrorPanel title="That could not be built." detail={error} />}
    </div>
  );
}

/** A brief filled in somewhere else and brought back. */
function UseTemplate({ agentId, onDraft }: { agentId: string; onDraft: (draft: CharacterDraft) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const read = async (file: File) => {
    setError(null);
    // Text formats are read here; a PDF has to be pasted, because pulling text
    // out of one in the browser needs a library this app has no other use for.
    if (/\.(md|markdown|txt|json)$/i.test(file.name) || file.type.startsWith('text/')) {
      setText(await file.text());
      return;
    }
    setError(
      `${file.name} is not a text file. Open it, copy the JSON block at the end of the brief, and paste it below.`,
    );
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<CharacterDraft>(`/api/agents/${agentId}/character/from-template`, { text });
      onDraft({ ...result, source: 'TEMPLATE' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be read.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="space-y-1.5 text-[13px] leading-relaxed text-bone-dim">
        <li>
          <span className="text-bone-faint">1.</span> Download the brief.
        </li>
        <li>
          <span className="text-bone-faint">2.</span> Give it to ChatGPT, Claude, or anything else, along with a
          description of your character. Ask it to fill in the JSON at the end.
        </li>
        <li>
          <span className="text-bone-faint">3.</span> Paste what comes back here.
        </li>
      </ol>

      <div className="flex flex-wrap gap-2">
        <a className="btn-ghost" href="/api/character-template" download>
          <Download className="h-4 w-4" aria-hidden />
          Download the brief
        </a>
        <button type="button" className="btn-quiet" onClick={() => fileInput.current?.click()}>
          <Upload className="h-4 w-4" aria-hidden />
          Open a file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.txt,.json,text/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void read(file);
          }}
        />
      </div>

      <Field label="Paste the filled-in brief" htmlFor="template" hint="The whole file, or just the JSON block at the end.">
        <textarea
          id="template"
          rows={6}
          className="field resize-y font-mono text-[12px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "name": "...", "personality": "...", "examples": [ ... ] }'
        />
      </Field>

      <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || text.trim().length < 2}>
        {busy ? <Spinner /> : <FileText className="h-4 w-4" aria-hidden />}
        Read it
      </button>
      {error && <ErrorPanel title="That could not be read." detail={error} />}
    </div>
  );
}

interface LearnedPayload {
  ready: boolean;
  answers: CharacterAnswers | null;
  completeness: CharacterCompleteness | null;
  detail?: string;
  source: { id: string; handle: string | null; status: string; itemCount?: number } | null;
  evidence?: { traits: number; examples: number; topics: number; beliefs: number };
}

/**
 * Learning a voice from a public account.
 *
 * The corpus rules from the advanced screens hold here: raw posts never enter a
 * prompt, only derived traits do, and every trait cites the posts it came from.
 * What is shown is a draft of what was learned, not a fact about the agent.
 */
function LearnFromAccount({ agentId, onDraft }: { agentId: string; onDraft: (draft: CharacterDraft) => void }) {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const learned = useResource<LearnedPayload>(`/api/agents/${agentId}/character/learned`);

  const working = started && !learned.data?.ready;
  usePolling(() => learned.reload(), 4_000, working);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/character/learn`, { handle: handle.trim().replace(/^@/, ''), limit: 600 });
      setStarted(true);
      setTimeout(() => learned.reload(), 3_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That account could not be read.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-bone-faint">
        Reads an account's public posts and works out how it writes: sentence length, what it argues about, how it
        answers people. It keeps the derived description, not the posts.
      </p>

      <Field label="Which account?" htmlFor="learn-handle" hint="A public X account. Without the @.">
        <input
          id="learn-handle"
          className="field"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="someone_funny"
        />
      </Field>

      <button type="button" className="btn-primary" onClick={() => void start()} disabled={busy || !handle.trim()}>
        {busy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
        Learn from this account
      </button>

      {working && (
        <p className="rounded-lg border border-ink-line px-3.5 py-3 text-[13px] leading-relaxed text-bone-dim">
          {learned.data?.detail ?? 'Reading the account. This takes a minute or two.'}
        </p>
      )}

      {learned.data?.ready && learned.data.answers && (
        <div className="space-y-3 rounded-lg border border-signal-live/40 bg-signal-live/[0.06] p-4">
          <p className="text-sm text-bone">Here is what it learned.</p>
          {learned.data.evidence && (
            <p className="font-mono text-[10px] text-bone-faint">
              {learned.data.evidence.examples} examples · {learned.data.evidence.topics} topics ·{' '}
              {learned.data.evidence.beliefs} positions
            </p>
          )}
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-bone-dim">
            {learned.data.answers.caresAbout.length > 0 && (
              <li>Talks about {learned.data.answers.caresAbout.slice(0, 6).join(', ')}</li>
            )}
            {learned.data.answers.examples.slice(0, 3).map((example) => (
              <li key={example} className="text-bone-faint">
                &ldquo;{example.slice(0, 120)}&rdquo;
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              onDraft({
                answers: learned.data!.answers!,
                completeness: learned.data!.completeness!,
                source: 'LEARNED',
              })
            }
          >
            Use this
          </button>
        </div>
      )}

      {error && <ErrorPanel title="That account could not be read." detail={error} />}
    </div>
  );
}

/** What a draft is missing, so somebody can see what to add. */
export function CompletenessBar({ completeness }: { completeness: CharacterCompleteness }) {
  const tone =
    completeness.score >= 80 ? 'bg-signal-live' : completeness.score >= 50 ? 'bg-signal-calm' : 'bg-signal-wait';
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">How complete</p>
        <span className="font-mono text-[10px] text-bone-faint">{completeness.score}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink-line">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${completeness.score}%` }} />
      </div>
      {completeness.missing.length > 0 && (
        <ul className="space-y-1 pt-1">
          {completeness.missing.slice(0, 4).map((item) => (
            <li key={item.key} className="text-[12px] leading-relaxed text-bone-faint">
              <span className="text-bone-dim">{item.ask}</span> {item.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
