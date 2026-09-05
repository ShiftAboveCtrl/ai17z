import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Spinner } from '@app/components/ui';
import { Section } from './Section';

interface Fingerprint {
  sampleCount: number;
  medianChars: number;
  p90Chars: number;
  medianSentences: number;
  questionRate: number;
  exclamationRate: number;
  emojiRate: number;
  hashtagRate: number;
  fragmentRate: number;
  contractionRate: number;
  firstPersonRate: number;
  characteristicWords: string[];
  typicalOpeners: string[];
}

interface VoiceData {
  fingerprint: Fingerprint;
  pinned: boolean;
  derivedAt: string | null;
  sources: string[];
}

interface ScoreResult {
  text: string;
  applied: string[];
  report: {
    voice: { score: number; lowConfidence: boolean; dimensions: { name: string; score: number; detail: string }[] };
    generic: { score: number; reasons: string[] };
    repetition: { score: number; reason: string | null };
    outcome: string;
    reason: string;
  };
}

/** A rate as a bar, because the number is less legible than the proportion. */
function Habit({ label, rate }: { label: string; rate: number }) {
  const percent = Math.round(rate * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-ink-line">
        <span className="block h-full bg-bone-faint" style={{ width: `${Math.max(percent, rate > 0 ? 2 : 0)}%` }} />
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-bone-faint">
        {percent === 0 && rate > 0 ? '<1%' : `${percent}%`}
      </span>
    </div>
  );
}

/**
 * How the agent writes, measured.
 *
 * The whole point is that these are quantities rather than adjectives: "dry" is
 * a label each model reads differently, "median 54 characters, questions 8%" is
 * a target that does not move when the model behind it changes.
 */
export function VoiceSection({
  index,
  agentId,
  compact,
}: {
  index: number;
  agentId: string;
  compact?: boolean;
}) {
  const { data, loading, reload } = useResource<VoiceData>(`/api/agents/${agentId}/voice`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<ScoreResult | null>(null);
  const [scoring, setScoring] = useState(false);

  const derive = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/voice/derive`, { force: true });
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The fingerprint could not be derived.');
    } finally {
      setBusy(false);
    }
  };

  const score = async () => {
    setScoring(true);
    setError(null);
    try {
      setResult(await post<ScoreResult>(`/api/agents/${agentId}/voice/score`, { text: draft }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be scored.');
    } finally {
      setScoring(false);
    }
  };

  const fingerprint = data?.fingerprint;
  const thin = (fingerprint?.sampleCount ?? 0) < 20;

  return (
    <Section
      compact={compact}
      id="voice"
      index={index}
      eyebrow="Voice"
      heading="How it writes."
      lede="Measured from what the agent actually publishes, so the same identity survives a change of model. The model decides what is worth saying; this decides how it is said."
      explain={
        <>
          <p><strong>The rules about how it writes, rather than what it writes about.</strong> Length, punctuation, emoji, whether it uses your capitalisation habits.</p>
          <p>These are applied to the finished text, not asked for in the prompt. A model told to use few emoji forgets by the third paragraph; surplus ones are simply removed instead.</p>
        </>
      }
    >
      {loading && !data ? (
        <Spinner />
      ) : !fingerprint || fingerprint.sampleCount === 0 ? (
        <EmptyState
          title="Nothing measured yet."
          detail="A fingerprint is derived from published replies, or from the style examples in the persona. Once the agent has posted a few times this fills in."
          action={
            <button type="button" className="btn-ghost" onClick={() => void derive()} disabled={busy}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              Derive from what exists
            </button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <p className="eyebrow">Length</p>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-light tabular-nums text-bone">{fingerprint.medianChars}</span>
                <span className="text-sm text-bone-faint">characters, typically</span>
              </div>
              <p className="text-xs leading-relaxed text-bone-faint">
                Rarely over {fingerprint.p90Chars}. About {fingerprint.medianSentences} sentence
                {fingerprint.medianSentences === 1 ? '' : 's'} per reply.
              </p>
            </div>

            <div className="space-y-2">
              <p className="eyebrow mb-3">Habits</p>
              <Habit label="Questions" rate={fingerprint.questionRate} />
              <Habit label="Exclamations" rate={fingerprint.exclamationRate} />
              <Habit label="Emoji" rate={fingerprint.emojiRate} />
              <Habit label="Hashtags" rate={fingerprint.hashtagRate} />
              <Habit label="Fragments" rate={fingerprint.fragmentRate} />
              <Habit label="Contractions" rate={fingerprint.contractionRate} />
              <Habit label="First person" rate={fingerprint.firstPersonRate} />
            </div>
          </div>

          {fingerprint.characteristicWords.length > 0 && (
            <div className="mt-5">
              <p className="eyebrow mb-3">Words it actually uses</p>
              <div className="flex flex-wrap gap-1.5">
                {fingerprint.characteristicWords.slice(0, 20).map((word) => (
                  <span key={word} className="rounded border border-ink-line px-2 py-0.5 text-xs text-bone-dim">
                    {word}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-ink-line pt-5">
            <p className="font-mono text-[10px] text-bone-faint">
              {fingerprint.sampleCount} samples
              {data?.sources.length ? ` from ${data.sources.join(' and ')}` : ''}
              {data?.derivedAt ? ` · measured ${timeAgo(data.derivedAt)}` : ''}
            </p>
            <button type="button" className="btn-quiet ml-auto text-xs" onClick={() => void derive()} disabled={busy}>
              {busy && <Spinner className="h-3 w-3" />}
              Measure again
            </button>
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => void patch(`/api/agents/${agentId}/voice`, { pinned: !data?.pinned }).then(reload)}
            >
              {data?.pinned ? 'Let it re-measure' : 'Freeze this fingerprint'}
            </button>
          </div>

          {thin && (
            <p className="mt-3 text-xs leading-relaxed text-signal-wait">
              Fewer than 20 samples, so these proportions are not worth much yet. They firm up as the agent posts.
            </p>
          )}
        </>
      )}

      <div className="mt-6 border-t border-ink-line pt-8">
        <p className="eyebrow mb-3">Try something</p>
        <p className="mb-4 max-w-xl text-sm leading-relaxed text-bone-dim">
          Paste anything and see what the gate would do with it, without publishing. This is the same path a real
          reply takes, minus the model rewrite.
        </p>
        <Field label="Draft" htmlFor="voicedraft">
          <textarea
            id="voicedraft"
            className="field min-h-[5rem]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Great question! I think adoption is really what compounds here. Hope that helps!"
          />
        </Field>
        <button
          type="button"
          className="btn-ghost mt-3"
          onClick={() => void score()}
          disabled={scoring || !draft.trim()}
        >
          {scoring && <Spinner className="h-3.5 w-3.5" />}
          Score it
        </button>

        {result && (
          <div className="mt-5 space-y-4 rounded-lg border border-ink-line bg-ink-panel/60 p-4">
            <div className="grid grid-cols-3 gap-4">
              <Metric label="Voice" value={result.report.voice.score} good="high" />
              <Metric label="Generic AI" value={result.report.generic.score} good="low" />
              <Metric label="Repetition" value={result.report.repetition.score} good="low" />
            </div>

            <p className={`text-sm leading-relaxed ${result.report.outcome === 'accept' ? 'text-bone-dim' : 'text-signal-wait'}`}>
              {result.report.reason}
            </p>

            {result.applied.length > 0 && (
              <p className="font-mono text-[10px] text-bone-faint">applied: {result.applied.join(', ')}</p>
            )}

            {result.text !== draft && (
              <div>
                <p className="eyebrow mb-2">What it would send</p>
                <p className="whitespace-pre-wrap rounded-lg border border-ink-line bg-ink-raised px-3.5 py-3 text-sm leading-relaxed text-bone">
                  {result.text}
                </p>
              </div>
            )}

            {result.report.generic.reasons.length > 0 && (
              <ul className="space-y-1">
                {result.report.generic.reasons.map((reason) => (
                  <li key={reason} className="text-xs text-bone-faint">
                    — it {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {error && <p className="mt-4 break-words text-sm text-signal-fail">{error}</p>}
    </Section>
  );
}

function Metric({ label, value, good }: { label: string; value: number; good: 'high' | 'low' }) {
  const healthy = good === 'high' ? value >= 70 : value <= 30;
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-light tabular-nums ${healthy ? 'text-bone' : 'text-signal-wait'}`}>
        {value}
      </p>
    </div>
  );
}
