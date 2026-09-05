/**
 * Teaching an agent from a source, and keeping it taught.
 *
 * Indexing once is easy. What makes this worth building is the second time: a
 * source changes, and an agent that answers from what the documents said last
 * month is worse than one that says it does not know, because it is confidently
 * wrong about its own subject.
 *
 * So every chunk carries the revision it came from, a refresh writes what it
 * found and then removes what it did not, and the order matters -- writing
 * first means an agent answering questions during a refresh never sees a gap.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { createLogger, errorMessage, envString } from '@xbam/shared';
import { knowledge as knowledgeRepo, memories as memoriesRepo } from '@xbam/database';
import { memoryContentHash } from '@xbam/database';
import type { KnowledgeSourceRecord } from '@xbam/database';
import {
  chunkDocument,
  collectDocuments,
  fetchPage,
  looksLikeSecret,
  revisionFromModified,
  type Chunk,
  type RefusedFile,
} from '@xbam/memory';

const run = promisify(execFile);
const log = createLogger('knowledge');

/**
 * Sources this installation can offer without being told where anything is.
 *
 * A convenience over the general mechanism, never a mode. What comes back is an
 * ordinary source that happens to point at documentation shipped alongside the
 * application, and an owner can rename it, disable it, or delete it exactly like
 * one they attached themselves. Building it the other way round -- an "AI17Z
 * expert" switch with the project's docs wired behind it -- would make teaching
 * an agent about anything else the special case.
 *
 * Offered only when the documents are actually there. An installation that
 * shipped without them should show nothing rather than a source that indexes to
 * zero and looks broken.
 */
export interface BuiltInSource {
  name: string;
  kind: 'PATH';
  location: string;
  /** What an agent gains by being taught this, in the owner's words. */
  describes: string;
}

export async function builtInSources(): Promise<BuiltInSource[]> {
  const root = process.cwd();
  const docs = resolve(root, 'docs');
  const readable = await stat(docs)
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (!readable) return [];

  return [
    {
      name: 'AI17Z documentation',
      kind: 'PATH',
      location: docs,
      // What is actually in docs/, and nothing more.
      //
      // This used to promise memory, voice, tools, posting and Easy Mode,
      // because the architecture notes were shipped alongside. They are not any
      // more, and a source that advertises what it cannot answer produces an
      // agent that confidently says it has read something it has not.
      describes:
        'Installing and uninstalling on Windows, why Windows warns about the download, ' +
        'what leaves your machine, and how releases are signed.',
    },
  ];
}

export interface IndexReport {
  sourceId: string;
  documents: number;
  chunks: number;
  removed: number;
  revision: string | null;
  /** Files that were not read, and why. The interesting half. */
  refused: RefusedFile[];
  /** Chunks refused for carrying something that looked like a secret. */
  withheld: { path: string; reason: string }[];
  /**
   * The page had not changed since the last read, so nothing was rewritten.
   *
   * Distinct from "read nothing": one means the source is current, the other
   * means it is broken, and a screen that shows them the same way sends
   * somebody looking for a fault that is not there.
   */
  unchanged?: boolean;
  error: string | null;
}

/**
 * Folders a PATH source may point at.
 *
 * Reading a path the API was handed is a filesystem read primitive, so it is
 * confined. The default permits the installation's own directory, which is what
 * makes AI17Z's own documentation work out of the box, and nothing else until
 * somebody says so.
 */
export function allowedRoots(): string[] {
  const configured = envString('AI17Z_KNOWLEDGE_ROOTS', '') ?? '';
  const extra = configured
    .split(/[;:](?![\\/])/)
    .map((p) => p.trim())
    .filter(Boolean);
  return [process.cwd(), ...extra].map((p) => resolve(p));
}

/**
 * What the source was when it was read.
 *
 * A git commit when there is one, because that is the exact answer to "which
 * version does this describe". A date otherwise, which is weaker but is still
 * something an answer can carry.
 */
async function revisionOf(directory: string, newestModifiedAt: string | null): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', directory, 'rev-parse', '--short', 'HEAD'], { timeout: 5_000 });
    const commit = stdout.trim();
    if (commit) {
      const { stdout: dirty } = await run('git', ['-C', directory, 'status', '--porcelain'], { timeout: 5_000 }).catch(
        () => ({ stdout: '' }),
      );
      // An index built from a working tree with uncommitted edits is not the
      // commit it claims to be, and saying so is cheaper than being wrong.
      return dirty.trim() ? `${commit} (with local changes)` : commit;
    }
  } catch {
    // Not a repository, or no git. The modification date still says something.
  }
  return revisionFromModified(newestModifiedAt);
}

export interface IndexOptions {
  /** Overrides the confinement, for tests and for the installation's own docs. */
  roots?: string[];
  /** Cap on chunks written, so a wrong folder cannot fill the table. */
  maxChunks?: number;
}

/**
 * Read a source and make the agent's knowledge match it.
 *
 * Returns a report rather than throwing: a source that cannot be read is a
 * thing the owner needs to see, not an exception in a worker log.
 */
export async function indexSource(source: KnowledgeSourceRecord, options: IndexOptions = {}): Promise<IndexReport> {
  const report: IndexReport = {
    sourceId: source.id,
    documents: 0,
    chunks: 0,
    removed: 0,
    revision: null,
    refused: [],
    withheld: [],
    error: null,
  };

  if (source.kind === 'TEXT') {
    return indexText(source, report, options);
  }
  if (source.kind === 'URL') {
    return indexUrl(source, report, options);
  }
  if (!source.location) {
    report.error = 'This source has no folder to read.';
    await knowledgeRepo.updateSource(source.id, { lastError: report.error });
    return report;
  }

  let collected;
  try {
    collected = await collectDocuments(source.location, {
      allowedRoots: options.roots ?? allowedRoots(),
      extensions: source.include.length > 0 ? source.include : undefined,
    });
  } catch (error) {
    report.error = errorMessage(error);
    await knowledgeRepo.updateSource(source.id, { lastError: report.error });
    return report;
  }

  report.refused = collected.refused;
  report.revision = await revisionOf(source.location, collected.newestModifiedAt);

  const chunks: Chunk[] = [];
  for (const file of collected.files) {
    const produced = chunkDocument(file.text, {
      path: file.path,
      revision: report.revision,
      modifiedAt: file.modifiedAt,
    });
    if (produced.length > 0) report.documents += 1;
    chunks.push(...produced);
  }

  return writeChunks(source, chunks, report, options);
}

/**
 * Reads the one page this source names.
 *
 * No links are followed, ever. A page that has not changed since the last read
 * writes nothing: rewriting identical chunks churns memory rows and gains no
 * reading, and the revision hash is what makes that checkable rather than
 * assumed.
 */
async function indexUrl(
  source: KnowledgeSourceRecord,
  report: IndexReport,
  options: IndexOptions,
): Promise<IndexReport> {
  if (!source.location) {
    report.error = 'This source has no address to read.';
    await knowledgeRepo.updateSource(source.id, { lastError: report.error });
    return report;
  }

  const page = await fetchPage(source.location);
  if (page.refusal) {
    // A whole sentence somebody can act on, not "fetch failed". Recorded so the
    // screen shows why a source stopped working, which is the difference
    // between a knowledge source and a folder that silently taught nothing.
    report.error = page.refusal;
    report.refused = [{ path: source.location, reason: page.refusal }];
    await knowledgeRepo.updateSource(source.id, { lastError: page.refusal });
    return report;
  }

  report.revision = page.contentHash.slice(0, 12);
  if (source.revision === report.revision) {
    // Unchanged. Recorded as a successful read so the screen can say when it
    // last checked, which is a different fact from when it last changed.
    await knowledgeRepo.updateSource(source.id, { indexedAt: new Date().toISOString(), lastError: null });
    report.documents = 1;
    report.chunks = source.chunkCount;
    report.unchanged = true;
    return report;
  }

  const chunks = chunkDocument(page.text, {
    path: page.title || source.location,
    revision: report.revision,
    modifiedAt: page.fetchedAt,
  });
  report.documents = chunks.length > 0 ? 1 : 0;
  return writeChunks(source, chunks, report, options);
}

async function indexText(
  source: KnowledgeSourceRecord,
  report: IndexReport,
  options: IndexOptions,
): Promise<IndexReport> {
  const text = source.location ?? '';
  const chunks = chunkDocument(text, { path: source.name, revision: null, modifiedAt: null });
  report.documents = chunks.length > 0 ? 1 : 0;
  report.revision = `edited ${new Date().toISOString().slice(0, 10)}`;
  return writeChunks(source, chunks, report, options);
}

async function writeChunks(
  source: KnowledgeSourceRecord,
  chunks: Chunk[],
  report: IndexReport,
  options: IndexOptions,
): Promise<IndexReport> {
  const maxChunks = options.maxChunks ?? 5_000;
  const kept: string[] = [];

  for (const chunk of chunks.slice(0, maxChunks)) {
    // The include-list keeps a .env out; this is for the secret written inside
    // a document that was allowed, which is common in a setup guide somebody
    // filled in with real values. A knowledge chunk is something the agent will
    // repeat, so it is refused and reported rather than indexed.
    const secret = looksLikeSecret(chunk.content);
    if (secret) {
      report.withheld.push({ path: chunk.origin.path, reason: `contains what looks like ${secret}` });
      continue;
    }

    const hash = memoryContentHash(chunk.content);
    kept.push(hash);
    await memoriesRepo.writeMemory({
      agentId: source.agentId,
      scope: 'KNOWLEDGE',
      memoryType: 'DOCUMENT',
      content: chunk.content,
      summary: chunk.origin.heading || chunk.origin.path,
      knowledgeSourceId: source.id,
      origin: {
        path: chunk.origin.path,
        heading: chunk.origin.heading,
        revision: chunk.origin.revision ?? report.revision,
        modifiedAt: chunk.origin.modifiedAt,
        sourceName: source.name,
      },
      // Documents are reference material, not opinions: worth retrieving when
      // relevant, never worth volunteering.
      importance: 0.6,
      confidence: 0.9,
    });
  }
  report.chunks = kept.length;

  // Written first, removed second. A refresh must never leave the agent briefly
  // unable to answer something it could answer a moment earlier.
  report.removed = await knowledgeRepo.pruneChunks(source.id, kept);

  await knowledgeRepo.updateSource(source.id, {
    revision: report.revision,
    indexedAt: new Date().toISOString(),
    documentCount: report.documents,
    chunkCount: report.chunks,
    lastError: null,
  });

  log.info('knowledge source indexed', {
    sourceId: source.id,
    name: source.name,
    documents: report.documents,
    chunks: report.chunks,
    removed: report.removed,
    refused: report.refused.length,
    withheld: report.withheld.length,
    revision: report.revision,
  });
  return report;
}

/**
 * Re-read every source an agent has.
 *
 * Called after an update installs a new version, which is the moment an agent's
 * knowledge of its own software becomes wrong.
 */
export async function refreshAll(agentId: string, options: IndexOptions = {}): Promise<IndexReport[]> {
  const sources = await knowledgeRepo.enabledSources(agentId);
  const reports: IndexReport[] = [];
  for (const source of sources) {
    reports.push(await indexSource(source, options));
  }
  return reports;
}
