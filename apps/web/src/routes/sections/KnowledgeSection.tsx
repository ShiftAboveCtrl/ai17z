import { useState } from 'react';
import { BookOpen, FolderOpen, Globe, RefreshCw, Trash2, FileText, ShieldAlert } from 'lucide-react';
import { ApiError, del, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner, Toggle } from '@app/components/ui';
import { Section } from './Section';

interface KnowledgeSource {
  id: string;
  name: string;
  kind: 'UPLOAD' | 'PATH' | 'TEXT' | 'URL';
  refreshIntervalMinutes: number | null;
  location: string | null;
  revision: string | null;
  enabled: boolean;
  indexedAt: string | null;
  documentCount: number;
  chunkCount: number;
  lastError: string | null;
}

interface IndexReport {
  documents: number;
  chunks: number;
  removed: number;
  revision: string | null;
  refused: { path: string; reason: string }[];
  withheld: { path: string; reason: string }[];
  error: string | null;
}

interface KnowledgeView {
  sources: KnowledgeSource[];
  /** Folders this installation is allowed to read. */
  roots: string[];
  available: { name: string; kind: 'PATH'; location: string; describes: string }[];
}

/**
 * What an agent has been taught, and from where.
 *
 * Nobody using this needs the word "chunk", an index, or an embedding. They need
 * to know which documents their agent has read, whether it worked, when it last
 * looked, and how to make it look again. Everything below is written to answer
 * those four questions and nothing else.
 *
 * The two failure modes are both spelled out rather than left to be discovered:
 * a folder this installation cannot see, which is the normal case when the API
 * runs in Docker and the documents are on somebody's desktop; and a document
 * that was skipped because it looked like it held a password.
 */
export function KnowledgeSection({ index, agentId }: { index: number; agentId: string }) {
  const view = useResource<KnowledgeView>(`/api/agents/${agentId}/knowledge`);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'PATH' | 'TEXT' | 'URL'>('PATH');
  // Null means only when asked. Never automatic by default: a source that
  // re-reads on its own is one nobody remembers agreeing to.
  const [refreshMinutes, setRefreshMinutes] = useState<string>('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ name: string; report: IndexReport } | null>(null);

  const sources = view.data?.sources ?? [];

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      view.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const create = (payload: { name: string; kind: 'PATH' | 'TEXT' | 'URL'; location: string; refreshIntervalMinutes?: number | null }) =>
    run('create', async () => {
      const response = (await post(`/api/agents/${agentId}/knowledge`, payload)) as {
        source: KnowledgeSource;
        report: IndexReport;
      };
      setReport({ name: payload.name, report: response.report });
      setAdding(false);
      setName('');
      setLocation('');
    });

  return (
    <Section
      id="knowledge"
      index={index}
      eyebrow="Knowledge"
      heading="What this agent has read"
      lede="Point it at documents and it can answer from them. Anything it reads is quoted as something it looked up, never as something it knows, and what a source stops saying it stops saying too."
      explain={
        <>
          <p><strong>Documents you give the agent to read.</strong> A folder, a file, a web page, or text you paste. It quotes from them rather than from a training set.</p>
          <p>Every answer that uses one records which document and which version it came from, so you can check where a claim came from instead of taking its word.</p>
        </>
      }
    >
      {view.loading && <Spinner />}

      {sources.length === 0 && !view.loading && (
        <EmptyState
          title="This agent has not been given anything to read"
          detail="Attach a folder of documents, or paste in the facts it should know. It will read them now, and again whenever you ask."
          action={
            <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
              Add something to read
            </button>
          }
        />
      )}

      {sources.length > 0 && (
        <div className="space-y-3">
          {sources.map((source) => (
            <div key={source.id} className="rounded border border-ink-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {source.kind === 'PATH' ? (
                      <FolderOpen className="h-4 w-4 shrink-0" />
                    ) : source.kind === 'URL' ? (
                      <Globe className="h-4 w-4 shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0" />
                    )}
                    <span className="font-medium">{source.name}</span>
                  </div>
                  {(source.kind === 'PATH' || source.kind === 'URL') && (
                    <p className="mt-1 break-words font-mono text-[11px] text-bone-faint">{source.location}</p>
                  )}
                  {source.kind === 'URL' && (
                    <p className="mt-1 text-[11px] text-bone-faint">
                      {source.refreshIntervalMinutes
                        ? `Re-read every ${source.refreshIntervalMinutes} minutes. This page only, no links followed.`
                        : 'Only re-read when you ask. This page only, no links followed.'}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-bone-dim">
                    {source.indexedAt ? (
                      <>
                        {source.documentCount} document{source.documentCount === 1 ? '' : 's'}, read{' '}
                        {timeAgo(source.indexedAt)}
                        {source.revision ? ` at ${source.revision}` : ''}
                      </>
                    ) : (
                      'Not read yet'
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Toggle
                    checked={source.enabled}
                    onChange={(enabled) =>
                      run(`toggle-${source.id}`, async () => {
                        await patch(`/api/knowledge/${source.id}`, { enabled });
                      })
                    }
                    label={source.enabled ? 'In use' : 'Set aside'}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`refresh-${source.id}`, async () => {
                        const response = (await post(`/api/knowledge/${source.id}/refresh`, {})) as {
                          report: IndexReport;
                        };
                        setReport({ name: source.name, report: response.report });
                      })
                    }
                  >
                    {busy === `refresh-${source.id}` ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
                    Read again
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-signal-fail"
                    disabled={busy !== null}
                    onClick={() => {
                      // Withdrawing a source withdraws what it taught, which is
                      // not obvious and is not undoable.
                      if (!confirm(`Remove "${source.name}"? The agent will forget everything it read there.`)) return;
                      void run(`delete-${source.id}`, async () => {
                        await del(`/api/knowledge/${source.id}`);
                      });
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {source.lastError && (
                <p className="mt-3 flex items-start gap-2 rounded border border-signal-fail/40 bg-signal-fail/5 p-2 text-sm text-signal-fail">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{source.lastError}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-signal-fail">{error}</p>}

      <div className="mt-6 flex flex-wrap gap-3 border-t border-ink-line pt-6">
        <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={busy !== null}>
          <BookOpen className="h-4 w-4" />
          Give it something to read
        </button>

        {(view.data?.available ?? []).map((offer) => (
          <button
            key={offer.name}
            type="button"
            className="btn-ghost"
            disabled={busy !== null || sources.some((s) => s.name === offer.name)}
            title={offer.describes}
            onClick={() => void create({ name: offer.name, kind: 'PATH', location: offer.location })}
          >
            {busy === 'create' ? <Spinner /> : <FolderOpen className="h-4 w-4" />}
            Teach it about {offer.name}
          </button>
        ))}
      </div>

      <Modal open={adding} title="Give this agent something to read" onClose={() => setAdding(false)}>
        <div className="space-y-5">
          <Field label="What is it called?" htmlFor="k-name" hint="Shown when the agent says where an answer came from.">
            <input id="k-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Product documentation" />
          </Field>

          <Field label="Where is it?" htmlFor="k-kind">
            <select
              id="k-kind"
              className="field"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'PATH' | 'TEXT' | 'URL')}
            >
              <option value="PATH">A folder on this machine</option>
              <option value="URL">A page on the web</option>
              <option value="TEXT">I will paste it in</option>
            </select>
          </Field>

          {kind === 'PATH' ? (
            <Field
              label="Folder"
              htmlFor="k-location"
              hint={
                view.data?.roots?.length
                  ? `This installation can read: ${view.data.roots.join(', ')}`
                  : 'Markdown and text files inside it. Anything that looks like a password is skipped.'
              }
            >
              <input
                id="k-location"
                className="field font-mono text-[13px]"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={view.data?.roots?.[0] ?? '/path/to/docs'}
              />
            </Field>
          ) : kind === 'URL' ? (
            <>
              <Field
                label="Address"
                htmlFor="k-url"
                hint="This page and nothing else. Links on it are never followed, so add a source per page you want read."
              >
                <input
                  id="k-url"
                  className="field font-mono text-[13px]"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="https://example.com/docs/getting-started"
                />
              </Field>
              <Field
                label="Read it again"
                htmlFor="k-refresh"
                hint="A page that has not changed writes nothing, so a schedule costs little. You can always read it now by hand."
              >
                <select
                  id="k-refresh"
                  className="field"
                  value={refreshMinutes}
                  onChange={(e) => setRefreshMinutes(e.target.value)}
                >
                  <option value="">Only when I ask</option>
                  <option value="60">Every hour</option>
                  <option value="1440">Every day</option>
                  <option value="10080">Every week</option>
                </select>
              </Field>
              <p className="text-[12px] leading-relaxed text-bone-faint">
                AI17Z reads the page as it is served and does not run its JavaScript. A site that builds itself in the
                browser will say so rather than being added empty. If the site asks automated readers to stay out in
                its robots.txt, that is respected.
              </p>
            </>
          ) : (
            <Field label="The text" htmlFor="k-text" hint="Headings help: each section becomes something the agent can find on its own.">
              <textarea id="k-text" rows={10} className="field resize-y" value={location} onChange={(e) => setLocation(e.target.value)} />
            </Field>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !name.trim() || !location.trim()}
              onClick={() =>
                void create({
                  name: name.trim(),
                  kind,
                  location: location.trim(),
                  refreshIntervalMinutes: kind === 'URL' && refreshMinutes ? Number(refreshMinutes) : null,
                })
              }
            >
              {busy === 'create' && <Spinner />}
              Read it now
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={report !== null} title={report ? `Read ${report.name}` : ''} onClose={() => setReport(null)}>
        {report && (
          <div className="space-y-4 text-sm">
            {report.report.error ? (
              <p className="text-signal-fail">{report.report.error}</p>
            ) : (
              <p>
                Read {report.report.documents} document{report.report.documents === 1 ? '' : 's'} into{' '}
                {report.report.chunks} passage{report.report.chunks === 1 ? '' : 's'} the agent can find on its own
                {report.report.removed > 0
                  ? `, and forgot ${report.report.removed} that the source no longer contains`
                  : ''}
                .
                {report.report.revision ? ` This is ${report.report.revision}.` : ''}
              </p>
            )}

            {report.report.withheld.length > 0 && (
              <div>
                <p className="flex items-center gap-2 font-medium text-signal-warn">
                  <ShieldAlert className="h-4 w-4" />
                  Left out, because it looked like a secret
                </p>
                <ul className="mt-2 space-y-1 text-bone-dim">
                  {report.report.withheld.map((w) => (
                    <li key={w.path} className="break-words font-mono text-[11px]">
                      {w.path} — {w.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.report.refused.length > 0 && (
              <details>
                {/* The interesting half: somebody who pointed at the wrong
                    folder learns it from seeing what was skipped. */}
                <summary className="cursor-pointer text-bone-dim">
                  {report.report.refused.length} file{report.report.refused.length === 1 ? '' : 's'} skipped
                </summary>
                <ul className="mt-2 space-y-1 text-bone-faint">
                  {report.report.refused.slice(0, 40).map((r) => (
                    <li key={r.path} className="break-words font-mono text-[11px]">
                      {r.path} — {r.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Modal>
    </Section>
  );
}
