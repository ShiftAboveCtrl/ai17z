/**
 * Deciding which files an agent is allowed to be taught from.
 *
 * The realistic accident is not an attacker. It is an owner pointing a source at
 * a project folder that happens to contain a `.env`, and thereby teaching the
 * agent a master key which it can then repeat to anybody who asks it something
 * adjacent. This repository's own root contains exactly such a file, and it is
 * the first folder anybody will try.
 *
 * So the rule is an include-list, not a deny-list. A deny-list is a promise to
 * have thought of everything; an include-list of document extensions excludes
 * secrets because secrets are not documents, which stays true for file types
 * nobody here has heard of yet.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep, extname, basename } from 'node:path';

/** What a document has to be to be read at all. */
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'] as const;

/**
 * Refused whatever the include-list says.
 *
 * Belt and braces: a `secrets.md` is a document by extension, and somebody will
 * eventually have one. This cannot catch everything, which is why the indexed
 * file list is shown back to the owner.
 */
const REFUSED_NAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /credentials?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

/** Directories never worth walking, and in two cases never safe to. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Bigger than any prose document, and a sign of something generated. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface SourceFile {
  /** Absolute path on the machine doing the reading. */
  absolutePath: string;
  /** Path relative to the source root, POSIX-style, for display and attribution. */
  path: string;
  text: string;
  modifiedAt: string;
  bytes: number;
}

export interface RefusedFile {
  path: string;
  reason: string;
}

export interface CollectResult {
  files: SourceFile[];
  refused: RefusedFile[];
  /** Newest modification time seen, as a fallback revision stamp. */
  newestModifiedAt: string | null;
}

export interface CollectOptions {
  /** Extensions to accept. Defaults to DOCUMENT_EXTENSIONS. */
  extensions?: readonly string[];
  /** Refuse to walk more than this many files, so a wrong path fails fast. */
  maxFiles?: number;
  /** Roots the location must sit inside. Empty means no confinement check. */
  allowedRoots?: readonly string[];
}

/**
 * Whether `candidate` is inside `root`, after both are fully resolved.
 *
 * Resolution is what makes this meaningful: `docs/../../../etc` and a symlink
 * pointing outside both become their real destinations first, so the check is
 * about where a path actually leads rather than how it is spelled.
 */
export function isInside(root: string, candidate: string): boolean {
  const from = resolve(root);
  const to = resolve(candidate);
  if (from === to) return true;
  const rel = relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !resolve(from, rel).startsWith('..') && !rel.startsWith(`..${sep}`);
}

/** Why this file may not be read, or null if it may. */
export function refusalReason(name: string, extensions: readonly string[]): string | null {
  if (REFUSED_NAMES.some((re) => re.test(name))) {
    return 'looks like it holds credentials';
  }
  const ext = extname(name).toLowerCase();
  if (!extensions.includes(ext)) {
    return ext ? `${ext} is not a document type` : 'has no file extension';
  }
  return null;
}

/**
 * Every readable document under a directory, and everything refused on the way.
 *
 * Both halves are returned because the refusals are the interesting half. An
 * owner who points at the wrong folder learns it from seeing that 300 files
 * were skipped, not from an empty success.
 */
export async function collectDocuments(root: string, options: CollectOptions = {}): Promise<CollectResult> {
  const extensions = options.extensions ?? DOCUMENT_EXTENSIONS;
  const maxFiles = options.maxFiles ?? 2_000;
  const allowedRoots = options.allowedRoots ?? [];

  const absoluteRoot = resolve(root);
  if (allowedRoots.length > 0 && !allowedRoots.some((allowed) => isInside(allowed, absoluteRoot))) {
    throw new Error(
      `${absoluteRoot} is outside every folder this installation is allowed to read. ` +
        'Set AI17Z_KNOWLEDGE_ROOTS to permit it.',
    );
  }

  const files: SourceFile[] = [];
  const refused: RefusedFile[] = [];
  let newest: number = 0;

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= maxFiles) return;

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(directory, entry.name);
      const shown = relative(absoluteRoot, full).split(sep).join('/');

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
        continue;
      }

      // A symlink is followed only if it lands back inside the root. Otherwise
      // a link named `notes.md` is a way to read anything on the machine.
      if (entry.isSymbolicLink()) {
        const target = await stat(full).catch(() => null);
        if (!target?.isFile() || !isInside(absoluteRoot, await resolveReal(full))) {
          refused.push({ path: shown, reason: 'a link pointing outside the source folder' });
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }

      const reason = refusalReason(entry.name, extensions);
      if (reason) {
        // Only worth reporting for things that look like documents somebody
        // expected to be read. Nobody needs to be told about a .png.
        if (!/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|zip|gz|lock|map)$/i.test(entry.name)) {
          refused.push({ path: shown, reason });
        }
        continue;
      }

      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.size > MAX_FILE_BYTES) {
        refused.push({ path: shown, reason: `larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB` });
        continue;
      }

      const text = await readFile(full, 'utf8').catch(() => null);
      if (text === null) {
        refused.push({ path: shown, reason: 'could not be read as text' });
        continue;
      }
      if (!text.trim()) continue;

      newest = Math.max(newest, info.mtimeMs);
      files.push({
        absolutePath: full,
        path: shown,
        text,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        bytes: info.size,
      });
    }
  };

  await walk(absoluteRoot);
  // Codepoint order, not localeCompare: the collation the latter uses varies by
  // machine, so the same folder would index in a different order on somebody
  // else's computer, and a diff of what was indexed would be noise.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    files,
    refused,
    newestModifiedAt: newest ? new Date(newest).toISOString() : null,
  };
}

async function resolveReal(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(path).catch(() => path);
}

/**
 * Text that should not become knowledge even though its file was allowed.
 *
 * The include-list keeps `.env` out; this is for the secret written inside a
 * document, which is common in a setup guide somebody filled in with their real
 * values rather than placeholders. Refusing the chunk and saying so beats
 * indexing it, because a knowledge chunk is something the agent will repeat.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:AI17Z|XBAM)_MASTER_KEY\s*[=:]\s*\S{16,}/i, 'a master key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'an API key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9/+_-]{16,}/i, 'a credential'],
];

/** What secret this text appears to contain, or null if none. */
export function looksLikeSecret(text: string): string | null {
  for (const [shape, what] of SECRET_SHAPES) {
    if (shape.test(text)) return what;
  }
  return null;
}

/** A short, readable stamp for a folder with no git revision. */
export function revisionFromModified(newestModifiedAt: string | null): string | null {
  if (!newestModifiedAt) return null;
  return `modified ${newestModifiedAt.slice(0, 10)}`;
}

export { basename };
