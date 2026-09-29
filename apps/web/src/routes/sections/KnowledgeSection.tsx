import { useState } from 'react';
import { BookOpen, FolderOpen, Globe, RefreshCw, Trash2, FileText, ShieldAlert, Library, GitBranch } from 'lucide-react';
import { ApiError, del, get, patch, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner, StatusDot, Toggle } from '@app/components/ui';
import { Section } from './Section';

type SourceKind = 'UPLOAD' | 'PATH' | 'TEXT' | 'URL' | 'DOCUMENTATION_SITE' | 'GITHUB_REPOSITORY';
type NewKind = Exclude<SourceKind, 'UPLOAD'>;
type Freshness = 'HEALTHY' | 'REFRESH_DUE' | 'REFRESHING' | 'CHANGED' | 'FAILED' | 'UNAVAILABLE' | 'NEVER_READ';

interface Labels {
  version?: string | null;
  generation?: string | null;
  authority?: 'OFFICIAL' | 'COMMUNITY' | 'OWNER' | null;
}

interface KnowledgeDocument {
  docKey: string;
  title: string | null;
  docKind: 'DOC' | 'SOURCE' | 'README' | 'PAGE';
  revision: string;
  chunkCount: number;
  fetchedAt: string;
}

/** A collection is many documents behind one name, read by the worker. */
const COLLECTION_KINDS: SourceKind[] = ['DOCUMENTATION_SITE', 'GITHUB_REPOSITORY'];

/** What each freshness verdict is called, and how it is shown. */
const FRESHNESS: Record<Freshness, { label: string; dot: 'live' | 'wait' | 'fail' | 'idle' }> = {
  HEALTHY: { label: 'Up to date', dot: 'idle' },
  REFRESH_DUE: { label: 'Refresh due', dot: 'wait' },
  REFRESHING: { label: 'Reading now', dot: 'live' },
  CHANGED: { label: 'Changed', dot: 'live' },
  FAILED: { label: 'Last read failed', dot: 'fail' },
  UNAVAILABLE: { label: 'Unavailable', dot: 'fail' },
  NEVER_READ: { label: 'Waiting to be read', dot: 'wait' },
};

interface KnowledgeSource {
  id: string;
  name: string;
  kind: SourceKind;
  freshness: Freshness;
  labels: Labels;
  lastChange: { added: number; changed: number; removed: number; unchanged: number; at: string } | null;
  lastSuccessAt: string | null;
  refreshingSince: string | null;
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
  const [kind, setKind] = useState<NewKind>('PATH');
  const [generation, setGeneration] = useState('');
  const [authority, setAuthority] = useState<'' | 'OFFICIAL' | 'COMMUNITY' | 'OWNER'>('');
  const [maxPages, setMaxPages] = useState('150');
  const [sourcePaths, setSourcePaths] = useState('');
  const [openDocs, setOpenDocs] = useState<Record<string, KnowledgeDocument[] | 'loading'>>({});
  // Null means only when asked. Never automatic by default: a source that
  // re-reads on its own is one nobody remembers agreeing to.
  const [refreshMinutes, setRefreshMinutes] = useState<string>('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ name: string; report: IndexReport } | null>(null);

  const sources = view.data?.sources ?? [];
  // A collection is read by the worker, so watch it while it is being read.
  usePolling(() => view.reload(), 5_000, sources.some((s) => s.freshness === 'REFRESHING' || s.freshness === 'NEVER_READ'));

  const toggleDocs = async (source: KnowledgeSource) => {
    if (openDocs[source.id]) {
      setOpenDocs(({ [source.id]: _closed, ...rest }) => rest);
      return;
    }
    setOpenDocs((o) => ({ ...o, [source.id]: 'loading' }));
    try {
      const response = (await get(`/api/knowledge/${source.id}/documents`)) as { documents: KnowledgeDocument[] };
      setOpenDocs((o) => ({ ...o, [source.id]: response.documents }));
    } catch {
      setOpenDocs(({ [source.id]: _failed, ...rest }) => rest);
    }
  };

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

  const create = (payload: {
    name: string;
    kind: NewKind;
    location: string;
    refreshIntervalMinutes?: number | null;
    labels?: Labels;
    config?: Record<string, unknown>;
  }) =>
    run('create', async () => {
      const response = (await post(`/api/agents/${agentId}/knowledge`, payload)) as {
        source: KnowledgeSource;
        report: IndexReport | null;
        queued?: boolean;
      };
      // A collection is queued for the worker; its card shows it being read.
      if (response.report) setReport({ name: payload.name, report: response.report });
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
                    {/*
                      Named rather than hidden: the icon is the only thing that
                      says whether this is a folder, a page or a file, so
                      hiding it would take that away rather than tidy it.
                    */}
                    {source.kind === 'PATH' ? (
                      <FolderOpen className="h-4 w-4 shrink-0" role="img" aria-label="Folder" />
                    ) : source.kind === 'DOCUMENTATION_SITE' ? (
                      <Library className="h-4 w-4 shrink-0" role="img" aria-label="Documentation site" />
                    ) : source.kind === 'GITHUB_REPOSITORY' ? (
                      <GitBranch className="h-4 w-4 shrink-0" role="img" aria-label="GitHub repository" />
                    ) : source.kind === 'URL' ? (
                      <Globe className="h-4 w-4 shrink-0" role="img" aria-label="Web page" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0" role="img" aria-label="File" />
                    )}
                    <span className="font-medium">{source.name}</span>
                    <StatusDot state={FRESHNESS[source.freshness].dot} label={FRESHNESS[source.freshness].label} />
                  </div>
                  {(source.labels?.generation || source.labels?.version || source.labels?.authority) && (
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      {[source.labels.generation, source.labels.version, source.labels.authority?.toLowerCase()]
                        .filter(Boolean)
                        .map((label) => (
                          <span key={label} className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-bone-dim">
                            {label}
                          </span>
                        ))}
                    </p>
                  )}
                  {(source.kind === 'PATH' || source.kind === 'URL' || COLLECTION_KINDS.includes(source.kind)) && (
                    <p className="mt-1 break-words font-mono text-[11px] text-bone-faint">{source.location}</p>
                  )}
                  {source.kind === 'URL' && (
                    <p className="mt-1 text-[11px] text-bone-faint">
                      {source.refreshIntervalMinutes
                        ? `Re-read every ${source.refreshIntervalMinutes} minutes. This page only, no links followed.`
                        : 'Only re-read when you ask. This page only, no links followed.'}
                    </p>
                  )}
                  {COLLECTION_KINDS.includes(source.kind) && (
                    <p className="mt-1 text-[11px] text-bone-faint">
                      {source.kind === 'DOCUMENTATION_SITE'
                        ? 'Every page under this address, within its limits, honouring robots.txt.'
                        : 'The README and documentation at one commit, and source only where you chose.'}{' '}
                      {source.refreshIntervalMinutes ? `Re-read every ${Math.round(source.refreshIntervalMinutes / 60)} hours.` : 'Re-read when you ask.'}
                    </p>
                  )}
                  {source.freshness === 'REFRESHING' && source.refreshingSince && (
                    <p className="mt-2 text-sm text-bone-dim">Reading since {timeAgo(source.refreshingSince)}. The rest of the agent is unaffected.</p>
                  )}
                  {source.lastChange && COLLECTION_KINDS.includes(source.kind) && (
                    <p className="mt-2 text-sm text-bone-dim">
                      Last read {timeAgo(source.lastChange.at)}:{' '}
                      {source.lastChange.added + source.lastChange.changed + source.lastChange.removed === 0
                        ? 'nothing had changed.'
                        : [
                            source.lastChange.added ? `${source.lastChange.added} new` : null,
                            source.lastChange.changed ? `${source.lastChange.changed} changed` : null,
                            source.lastChange.removed ? `${source.lastChange.removed} removed` : null,
                          ]
                            .filter(Boolean)
                            .join(', ') + '.'}
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
                          report: IndexReport | null;
                        };
                        if (response.report) setReport({ name: source.name, report: response.report });
                      })
                    }
                  >
                    {busy === `refresh-${source.id}` ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                    Read again
                  </button>
                  <button
                    type="button"
                    // The only control here with no words in it, and it is the
                    // destructive one: a screen reader announced "button".
                    aria-label={`Remove ${source.name}`}
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
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>

              {source.lastError && (
                <p className="mt-3 flex items-start gap-2 rounded border border-signal-fail/40 bg-signal-fail/5 p-2 text-sm text-signal-fail">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{source.lastError}</span>
                </p>
              )}
              {COLLECTION_KINDS.includes(source.kind) && source.documentCount > 0 && (
                <div className="mt-3">
                  <button type="button" className="btn-quiet px-0 text-xs" aria-expanded={Boolean(openDocs[source.id])} onClick={() => void toggleDocs(source)}>
                    {openDocs[source.id] ? 'Hide' : 'Show'} the {source.documentCount} {source.kind === 'GITHUB_REPOSITORY' ? 'files' : 'pages'} it read
                  </button>
                  {openDocs[source.id] === 'loading' && <Spinner />}
                  {Array.isArray(openDocs[source.id]) && (
                    <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                      {(openDocs[source.id] as KnowledgeDocument[]).map((d) => (
                        <li key={d.docKey} className="flex items-baseline justify-between gap-3 text-[11px]">
                          <span className="min-w-0 break-words font-mono text-bone-dim">{d.docKey}</span>
                          <span className="shrink-0 text-bone-faint">
                            {d.docKind === 'SOURCE' ? 'code, ' : ''}
                            {d.chunkCount} passage{d.chunkCount === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
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
            {busy === 'create' ? <Spinner /> : <FolderOpen className="h-4 w-4" aria-hidden />}
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
              onChange={(e) => setKind(e.target.value as NewKind)}
            >
              <option value="PATH">A folder on this machine</option>
              <option value="URL">A page on the web</option>
              <option value="DOCUMENTATION_SITE">A documentation site (every page under an address)</option>
              <option value="GITHUB_REPOSITORY">A public GitHub repository</option>
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
          ) : kind === 'DOCUMENTATION_SITE' ? (
            <>
              <Field
                label="First page"
                htmlFor="k-site"
                hint="Every page under this address is read, and nothing outside it: https://docs.example.com/v2/ stays in /v2/."
              >
                <input id="k-site" className="field font-mono text-[13px]" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="https://docs.example.com/" />
              </Field>
              <Field label="How many pages at most" htmlFor="k-pages" hint="A limit, not a target. Most documentation sites are well under it.">
                <select id="k-pages" className="field" value={maxPages} onChange={(e) => setMaxPages(e.target.value)}>
                  <option value="50">50 pages</option>
                  <option value="150">150 pages</option>
                  <option value="300">300 pages</option>
                  <option value="500">500 pages</option>
                </select>
              </Field>
              <p className="text-[12px] leading-relaxed text-bone-faint">
                Read by the worker, a page at a time with a pause between each, honouring robots.txt and any page that asks not
                to be indexed. The first read can take a few minutes; this screen shows it happening. Later reads rewrite only
                the pages that changed.
              </p>
            </>
          ) : kind === 'GITHUB_REPOSITORY' ? (
            <>
              <Field label="Repository" htmlFor="k-repo" hint="Public repositories only. Give it as owner/name or its GitHub address.">
                <input id="k-repo" className="field font-mono text-[13px]" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="owner/name" />
              </Field>
              <Field
                label="Source folders to read as well (optional)"
                htmlFor="k-src"
                hint="Comma separated, such as contracts, src/router. Left empty, only the README and documentation are read."
              >
                <input id="k-src" className="field font-mono text-[13px]" value={sourcePaths} onChange={(e) => setSourcePaths(e.target.value)} />
              </Field>
            </>
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

          <details className="rounded border border-ink-line p-3" open={COLLECTION_KINDS.includes(kind)}>
            <summary className="cursor-pointer text-sm text-bone-dim">Which version is this, and who publishes it?</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field
                label="Version or generation"
                htmlFor="k-gen"
                hint="Such as V1 or V2. Two versions of one product should be two sources, so answers never mix them."
              >
                <input id="k-gen" className="field" value={generation} onChange={(e) => setGeneration(e.target.value)} placeholder="V2" />
              </Field>
              <Field label="Published by" htmlFor="k-auth">
                <select id="k-auth" className="field" value={authority} onChange={(e) => setAuthority(e.target.value as typeof authority)}>
                  <option value="">Not said</option>
                  <option value="OFFICIAL">The project itself</option>
                  <option value="COMMUNITY">The community</option>
                  <option value="OWNER">Me</option>
                </select>
              </Field>
            </div>
            {COLLECTION_KINDS.includes(kind) && (
              <Field label="Read it again" htmlFor="k-coll-refresh" hint="Only what changed is rewritten.">
                <select id="k-coll-refresh" className="field" value={refreshMinutes} onChange={(e) => setRefreshMinutes(e.target.value)}>
                  <option value="">Only when I ask</option>
                  <option value="1440">Every day</option>
                  <option value="10080">Every week</option>
                </select>
              </Field>
            )}
          </details>

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
                  refreshIntervalMinutes: (kind === 'URL' || COLLECTION_KINDS.includes(kind)) && refreshMinutes ? Number(refreshMinutes) : null,
                  labels: {
                    ...(generation.trim() ? { generation: generation.trim() } : {}),
                    ...(authority ? { authority } : {}),
                  },
                  config:
                    kind === 'DOCUMENTATION_SITE'
                      ? { maxPages: Number(maxPages) }
                      : kind === 'GITHUB_REPOSITORY'
                        ? { sourcePaths: sourcePaths.split(',').map((p) => p.trim()).filter(Boolean) }
                        : {},
                })
              }
            >
              {busy === 'create' && <Spinner />}
              {COLLECTION_KINDS.includes(kind) ? 'Start reading' : 'Read it now'}
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
