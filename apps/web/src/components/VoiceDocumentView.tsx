import { AlertTriangle } from 'lucide-react';
import type { VoiceCounts, VoiceDocument } from '@xbam/shared/contracts';
import { describeFinding, type VoiceFinding } from '@app/lib/studioVoice';

/**
 * A voice, exactly as it is, and nothing but what it is.
 *
 * Rendered from the document itself field by field, never from a summary of it,
 * so what an owner reads before publishing or installing is the allowlist and
 * not somebody's description of it. Every value is text. A voice written by a
 * stranger can contain markup, and React places it as characters.
 *
 * Machine-generated and author-written strings wrap (`break-words`) so a long
 * unbroken one cannot push the page wider than a phone.
 */

const LENGTH_WORDS: Record<string, string> = {
  TERSE: 'Terse',
  SHORT: 'Short',
  MEDIUM: 'Medium',
  LONG: 'Long',
  ADAPTIVE: 'Adapts to the message',
};

function Prose({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed ${value.trim() ? 'text-bone-dim' : 'text-bone-faint'}`}>
        {value.trim() ? value : 'Empty'}
      </dd>
    </div>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="eyebrow">
        {label} <span className="text-bone-faint/70">({items.length})</span>
      </dt>
      <dd className="mt-1">
        {items.length === 0 ? (
          <span className="text-[13px] text-bone-faint">None</span>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item, index) => (
              <li key={`${index}:${item}`} className="whitespace-pre-wrap break-words rounded-md border border-ink-line px-2.5 py-1.5 text-[13px] leading-relaxed text-bone-dim">
                {item}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-line/60 py-1.5 text-[13px] last:border-b-0">
      <dt className="text-bone-faint">{label}</dt>
      <dd className="break-words text-right text-bone-dim">{value}</dd>
    </div>
  );
}

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

export function VoiceFindings({ findings }: { findings: VoiceFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2.5 rounded-lg border border-signal-wait/30 bg-signal-wait/[0.05] px-3.5 py-3" role="note">
      <p className="flex items-start gap-2 text-sm text-signal-wait">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {findings.length} passage{findings.length === 1 ? '' : 's'} to read twice
      </p>
      <p className="text-xs leading-relaxed text-bone-dim">
        Found by a pattern match, which is a prompt to look and not a verdict. These are stored as words in the voice and
        nothing more.
      </p>
      <ul className="space-y-2">
        {findings.map((finding, index) => (
          <li key={`${finding.field}:${index}`} className="min-w-0 text-xs leading-relaxed">
            <span className="text-bone">{describeFinding(finding.kind)}</span>
            <span className="block break-all font-mono text-[10px] text-bone-faint">{finding.field}</span>
            <span className="mt-0.5 block whitespace-pre-wrap break-words rounded border border-ink-line px-2 py-1 text-bone-dim">{finding.excerpt}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VoiceCountsLine({ counts }: { counts: VoiceCounts }) {
  return (
    <p className="font-mono text-[11px] leading-relaxed text-bone-faint">
      {counts.styleExamples} style example{counts.styleExamples === 1 ? '' : 's'} · {counts.topics} topic{counts.topics === 1 ? '' : 's'} ·{' '}
      {counts.prohibitedBehaviors} prohibited behaviour{counts.prohibitedBehaviors === 1 ? '' : 's'} · {counts.allowedEmoji} allowed emoji ·{' '}
      {counts.characters.toLocaleString()} characters of text
    </p>
  );
}

export function VoiceDocumentView({ document: voice }: { document: VoiceDocument }) {
  const { character, settings } = voice;
  return (
    <div className="space-y-5 rounded-lg border border-ink-line p-4">
      <div className="min-w-0">
        <p className="eyebrow">Title</p>
        <p className="mt-1 break-words text-base text-bone">{voice.title}</p>
        <p className={`mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed ${voice.summary ? 'text-bone-dim' : 'text-bone-faint'}`}>
          {voice.summary || 'No summary'}
        </p>
      </div>

      <dl className="space-y-4 border-t border-ink-line pt-4">
        <Prose label="Biography" value={character.biography} />
        <Prose label="Personality" value={character.personality} />
        <Prose label="Tone" value={character.tone} />
        <Prose label="Style guidelines" value={character.styleGuidelines} />
        <Prose label="Language policy" value={character.languagePolicy} />
        <div>
          <dt className="eyebrow">Response length</dt>
          <dd className="mt-1 text-[13px] text-bone-dim">{LENGTH_WORDS[character.responseLength] ?? character.responseLength}</dd>
        </div>
        <List label="Style examples" items={character.styleExamples} />
        <List label="Topics" items={character.topics} />
        <List label="Prohibited behaviours" items={character.prohibitedBehaviors} />
      </dl>

      <div className="border-t border-ink-line pt-4">
        <p className="eyebrow mb-1">Output settings</p>
        <dl>
          <Setting label="Emoji" value={settings.emoji.use.toLowerCase().replace(/_/g, ' ')} />
          <Setting label="Most emoji per message" value={String(settings.emoji.maxPerMessage)} />
          <Setting label="Share of messages with emoji" value={`${settings.emoji.messagesPercent}%`} />
          <Setting label="Allowed emoji" value={settings.emoji.allowed.length ? settings.emoji.allowed.join(' ') : 'None listed'} />
          <Setting label="Most characters" value={String(settings.maxCharacters)} />
          <Setting label="No hashtags" value={yesNo(settings.forbidHashtags)} />
          <Setting label="No links" value={yesNo(settings.forbidLinks)} />
          <Setting label="No mentions of other people" value={yesNo(settings.forbidMentionsOfOthers)} />
          <Setting label="Strip surrounding quotes" value={yesNo(settings.stripSurroundingQuotes)} />
        </dl>
      </div>
    </div>
  );
}
