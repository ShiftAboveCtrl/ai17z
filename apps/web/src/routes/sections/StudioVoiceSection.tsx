import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Megaphone, Undo2 } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { useElapsed, useResource } from '@app/lib/hooks';
import {
  shortDigest,
  type ListingsAnswer,
  type PublishAnswer,
  type StudioLinkState,
  type VoicePreview,
  type VoiceStatus,
} from '@app/lib/studioVoice';
import { Field, Modal, RetryablePanel, Spinner, Toggle, Working } from '@app/components/ui';
import { VoiceCountsLine, VoiceDocumentView, VoiceFindings } from '@app/components/VoiceDocumentView';
import { Section } from './Section';

/**
 * Publishing this agent's voice to Studio.
 *
 * Preview first, then publish. Nothing leaves the installation until the owner
 * has seen the exact document, checked it and pressed the button that names its
 * digest; the server holds the preview and refuses a publish for any other
 * digest, so this page cannot publish something it did not show.
 *
 * It is the voice and nothing else, which is why the preview is the document
 * itself and not a description of it. See `docs/architecture/STUDIO_VOICE_PUBLISH.md`.
 */

type Phase = 'idle' | 'previewing' | 'publishing' | 'unpublishing';

interface Problem {
  title: string;
  detail: string;
  retry: () => void;
  retryLabel?: string;
}

const NEEDS_LINK: Record<Exclude<StudioLinkState, 'LINKED'>, string> = {
  NOT_CONFIGURED: 'This installation has no Studio address set, so there is nowhere to publish to.',
  NOT_LINKED: 'This installation is not linked to a Studio account yet.',
  PENDING: 'Linking to Studio has started and is waiting for you to approve it on Studio.',
  REVOKED: 'The link to Studio was ended. Link again to publish.',
};

const WORKING_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  previewing: 'Building the preview',
  publishing: 'Publishing to Studio',
  unpublishing: 'Taking the listing down',
};

export function StudioVoiceSection({ index, agentId, agentName, compact }: { index: number; agentId: string; agentName: string; compact?: boolean }) {
  const status = useResource<VoiceStatus>(`/api/agents/${agentId}/studio-voice`);
  const linked = status.data?.studio.state === 'LINKED';
  const listings = useResource<ListingsAnswer>(linked ? '/api/studio/voices' : null);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<VoicePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [published, setPublished] = useState<Extract<PublishAnswer, { state: 'PUBLISHED' }> | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDown, setConfirmDown] = useState(false);
  // Which request the page is still waiting on. "Stop waiting" bumps it, and an
  // answer that arrives for an older one is ignored rather than shown.
  const run = useRef(0);
  const seconds = useElapsed(phase !== 'idle');

  const busy = phase !== 'idle';
  const listing = status.data?.listing ?? null;
  const studioView = listings.data?.ok ? listings.data.listings.find((l) => l.listing_id === listing?.listingId) : undefined;

  const edited = () => {
    // The preview is of these words. Changing them makes it a different document.
    setPreview(null);
    setConfirmed(false);
    setPublished(null);
    setProblem(null);
  };

  const stopWaiting = () => {
    run.current += 1;
    setPhase('idle');
    setNotice(
      phase === 'publishing'
        ? 'Stopped waiting. The request may already have reached Studio: the listing status below shows what Studio holds, and publishing the same preview again is one version, not two.'
        : phase === 'unpublishing'
          ? 'Stopped waiting. Check the listing status below to see whether Studio took it down.'
          : 'Stopped waiting.',
    );
  };

  const makePreview = async () => {
    const mine = ++run.current;
    setPhase('previewing');
    setProblem(null);
    setNotice(null);
    setPublished(null);
    setConfirmed(false);
    try {
      const answer = await post<{ ok: true; preview: VoicePreview } | { ok: false; why: string }>(`/api/agents/${agentId}/studio-voice/preview`, {
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      if (mine !== run.current) return;
      if (!answer.ok) {
        setPreview(null);
        setProblem({ title: 'There is no voice to preview yet.', detail: answer.why, retry: () => void makePreview() });
      } else {
        setPreview(answer.preview);
      }
    } catch (e) {
      if (mine !== run.current) return;
      setProblem({ title: 'The preview could not be built.', detail: e instanceof ApiError ? e.message : 'Something went wrong building the preview.', retry: () => void makePreview() });
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  const publish = async () => {
    if (!preview || !confirmed) return;
    const mine = ++run.current;
    setPhase('publishing');
    setProblem(null);
    setNotice(null);
    try {
      const answer = await post<PublishAnswer>(`/api/agents/${agentId}/studio-voice/publish`, { digest: preview.digest });
      if (mine !== run.current) return;
      if (answer.state === 'PUBLISHED') {
        setPublished(answer);
        setPreview(null);
        setConfirmed(false);
        status.reload();
        listings.reload();
      } else {
        // Studio did not answer. The preview is kept on the server, so trying
        // again is the same request and cannot make a second version.
        setProblem({ title: 'Studio did not take it.', detail: answer.why, retry: () => void publish(), retryLabel: 'Publish again' });
      }
    } catch (e) {
      if (mine !== run.current) return;
      const refusedState = e instanceof ApiError && e.status === 409 ? (e.details as { state?: string } | undefined)?.state : undefined;
      if (refusedState) {
        // The server said no to this digest: it is stale, edited or expired.
        // Publishing it again cannot help; looking again can.
        setPreview(null);
        setConfirmed(false);
        setProblem({ title: 'That preview can no longer be published.', detail: (e as ApiError).message, retry: () => void makePreview(), retryLabel: 'Preview again' });
      } else {
        setProblem({ title: 'The publish did not go through.', detail: e instanceof ApiError ? e.message : 'Something went wrong publishing.', retry: () => void publish(), retryLabel: 'Publish again' });
      }
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  const unpublish = async () => {
    if (!listing) return;
    const mine = ++run.current;
    setConfirmDown(false);
    setPhase('unpublishing');
    setProblem(null);
    setNotice(null);
    try {
      const answer = await post<{ state: 'UNPUBLISHED'; listingId: string } | { state: 'NOT_CONFIRMED' | 'UNAVAILABLE'; why: string }>(
        `/api/agents/${agentId}/studio-voice/unpublish`,
        { listingId: listing.listingId },
      );
      if (mine !== run.current) return;
      if (answer.state === 'UNPUBLISHED') {
        setNotice('Taken down. Nobody can start a new install from it. Copies people already installed are theirs and are unchanged.');
        setPreview(null);
        status.reload();
        listings.reload();
      } else {
        setProblem({ title: 'Studio did not take it down.', detail: answer.why, retry: () => void unpublish(), retryLabel: 'Try again' });
      }
    } catch (e) {
      if (mine !== run.current) return;
      setProblem({ title: 'The listing could not be taken down.', detail: e instanceof ApiError ? e.message : 'Something went wrong.', retry: () => void unpublish(), retryLabel: 'Try again' });
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  let body;
  if (status.loading && !status.data) {
    body = <Working label="Reading the Studio link" seconds={0} />;
  } else if (status.error && !status.data) {
    body = <RetryablePanel title="The publishing status could not be read." detail={status.error} onRetry={status.reload} />;
  } else if (status.data && status.data.studio.state !== 'LINKED') {
    body = (
      <div className="space-y-3 rounded-lg border border-ink-line p-4" role="note">
        <p className="text-sm text-bone">Publishing needs a linked Studio.</p>
        <p className="max-w-prose text-[13px] leading-relaxed text-bone-dim">{NEEDS_LINK[status.data.studio.state as Exclude<StudioLinkState, 'LINKED'>]}</p>
        <Link to="/plugins" className="btn-ghost">
          Link Studio on the Plugins screen
        </Link>
        <p className="max-w-prose text-xs leading-relaxed text-bone-faint">
          Installing a voice someone else published does not need a link, and neither does reading one.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-6">
        {/* What Studio holds for this agent, as this installation last heard. */}
        {listing && (
          <div className="min-w-0 space-y-3 rounded-lg border border-ink-line p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`chip ${listing.status === 'PUBLISHED' ? 'border-signal-live/40 text-signal-live' : ''}`}>
                {listing.status === 'PUBLISHED' ? 'Published' : 'Taken down'}
              </span>
              <span className="min-w-0 break-all font-mono text-[11px] text-bone-faint">{listing.listingId}</span>
            </div>
            <ul className="space-y-1 text-[13px] text-bone-dim">
              {listing.versions.map((version) => (
                <li key={version.version} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-bone">Version {version.version}</span>
                  <span className="font-mono text-[11px] text-bone-faint">{shortDigest(version.digest)}</span>
                  <span className="text-xs text-bone-faint">{new Date(version.publishedAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              {studioView && listing.status === 'PUBLISHED' && (
                <a href={studioView.url} target="_blank" rel="noreferrer noopener" className="btn-quiet px-0 text-xs">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  View on Studio
                </a>
              )}
              {listing.status === 'PUBLISHED' && (
                <button type="button" className="btn-quiet px-0 text-xs hover:text-signal-fail" onClick={() => setConfirmDown(true)} disabled={busy}>
                  <Undo2 className="h-3.5 w-3.5" aria-hidden />
                  Unpublish
                </button>
              )}
            </div>
            {listings.data && !listings.data.ok && (
              <p className="break-words text-xs leading-relaxed text-bone-faint">Studio's own list could not be read: {listings.data.why}</p>
            )}
            {listings.error && <RetryablePanel title="Studio's list could not be read." detail={listings.error} onRetry={listings.reload} />}
          </div>
        )}

        <div className="space-y-4">
          <p className="max-w-prose text-[13px] leading-relaxed text-bone-dim">
            Publishes <span className="text-bone">how this agent sounds</span> so other people can install it as a new agent of their own: the character
            answers, the style examples and the output settings. Not its memory, accounts, keys, permissions, plugins, models or picture, and not its operator
            instructions.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Listing title" htmlFor="voice-title" hint={`Leave blank to use "${agentName}".`}>
              <input
                id="voice-title"
                className="field"
                value={title}
                maxLength={80}
                disabled={busy}
                onChange={(e) => {
                  setTitle(e.target.value);
                  edited();
                }}
              />
            </Field>
            <Field label="Listing summary" htmlFor="voice-summary" hint="Leave blank to use this agent's description.">
              <input
                id="voice-summary"
                className="field"
                value={summary}
                maxLength={500}
                disabled={busy}
                onChange={(e) => {
                  setSummary(e.target.value);
                  edited();
                }}
              />
            </Field>
          </div>
          <button type="button" className="btn-ghost" onClick={() => void makePreview()} disabled={busy}>
            {phase === 'previewing' ? <Spinner className="h-3.5 w-3.5" /> : <Megaphone className="h-3.5 w-3.5" aria-hidden />}
            {preview ? 'Preview again' : 'Preview what would be published'}
          </button>
        </div>

        {busy && (
          <Working
            label={WORKING_LABEL[phase as Exclude<Phase, 'idle'>]}
            seconds={seconds}
            slowHint={
              phase === 'publishing'
                ? 'Still waiting on Studio. If this stops, publishing again is the same request and cannot make a second version.'
                : 'Still going. Nothing has failed; it is just slow.'
            }
            onCancel={stopWaiting}
            cancelLabel="Stop waiting"
          />
        )}

        {problem && <RetryablePanel title={problem.title} detail={problem.detail} onRetry={problem.retry} retryLabel={problem.retryLabel ?? 'Try again'} />}
        {notice && <p className="break-words rounded-lg border border-ink-line px-3.5 py-3 text-[13px] leading-relaxed text-bone-dim" role="status">{notice}</p>}

        {published && (
          <div className="min-w-0 space-y-1.5 rounded-lg border border-signal-live/30 bg-signal-live/[0.06] p-4" role="status">
            <p className="text-sm text-bone">
              {published.alreadyPublished ? `This exact voice was already version ${published.version}. Nothing changed.` : `Published as version ${published.version}.`}
            </p>
            <p className="break-all font-mono text-[11px] text-bone-faint">{published.listingId}</p>
            <a href={published.url} target="_blank" rel="noreferrer noopener" className="btn-quiet px-0 text-xs">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              View on Studio
            </a>
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="eyebrow">This is exactly what would be published</p>
              <VoiceCountsLine counts={preview.counts} />
            </div>
            <VoiceDocumentView document={preview.document} />
            <VoiceFindings findings={preview.findings} />

            <div className="min-w-0 space-y-1 rounded-lg border border-ink-line px-3.5 py-3">
              <p className="eyebrow">Digest</p>
              <p className="break-all font-mono text-[11px] leading-relaxed text-bone-dim">{preview.digest}</p>
              <p className="text-xs text-bone-faint">
                {preview.listingId ? `Adds version ${preview.nextVersion} to your listing.` : 'Starts a new listing, as version 1.'} This preview can be published until{' '}
                {new Date(preview.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
              </p>
            </div>

            <ul className="max-w-prose space-y-1.5 text-xs leading-relaxed text-bone-faint">
              {preview.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>

            <Toggle
              checked={confirmed}
              onChange={setConfirmed}
              disabled={busy}
              label={`I have read this voice, and I want it public as ${shortDigest(preview.digest)}`}
              description="Anyone can read a published voice, signed in or not. A version, once published, is never changed."
            />
            <button type="button" className="btn-primary" onClick={() => void publish()} disabled={busy || !confirmed}>
              {phase === 'publishing' && <Spinner />}
              Publish {preview.listingId ? `version ${preview.nextVersion}` : 'to Studio'} ({shortDigest(preview.digest)})
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <Section id="publish-voice" index={index} eyebrow="Share" heading="Publish voice" lede="Let other people install how this agent sounds, and nothing else about it." compact={compact}>
        {body}
      </Section>
      <Modal open={confirmDown} onClose={() => setConfirmDown(false)} title="Unpublish this voice?">
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-bone-dim">
            The listing comes down and nobody can start a new install from it. <span className="text-bone">It cannot reach a copy somebody already
            installed</span>: those agents are theirs and keep the voice they have. Publishing again later starts a new listing.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-danger flex-1" onClick={() => void unpublish()}>
              Unpublish
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDown(false)}>
              Keep it published
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
