import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read-only reader for the AI4CZ directory.
 *
 * Nothing here writes, opens for write, or copies files. The legacy project is
 * evidence: every access is a read, and the SQLite handle is opened read-only.
 */
export class LegacyReader {
  constructor(private readonly root: string) {
    if (!existsSync(root)) throw new Error(`Legacy directory not found: ${root}`);
  }

  private path(relative: string): string {
    return resolve(this.root, relative);
  }

  has(relative: string): boolean {
    return existsSync(this.path(relative));
  }

  private readJson<T>(relative: string, fallback: T): T {
    const file = this.path(relative);
    if (!existsSync(file)) return fallback;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /** 48 hand-curated voice lines. */
  styleLines(): string[] {
    const direct = this.readJson<{ cz_speaking?: string[] }>('src/cz_speaking.json', {});
    const root = this.readJson<{ cz_speaking?: string[] }>('cz_speaking.json', {});
    const lines = direct.cz_speaking ?? root.cz_speaking ?? [];
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  /** 80 real posts scraped from the account the persona is modelled on. */
  scrapedPosts(): Array<{ id: string; text: string; parentText: string | null }> {
    const rows = this.readJson<Array<{ id?: string; text?: string; parentText?: string | null }>>(
      'cz_binance_tweets_scraped.json',
      [],
    );
    return rows
      .filter((r) => typeof r.text === 'string' && r.text.trim().length > 0)
      .map((r) => ({ id: String(r.id ?? ''), text: r.text!.trim(), parentText: r.parentText ?? null }));
  }

  /**
   * The biography, extracted from the character source.
   *
   * It lives as quoted sentences inside one template literal, so the quoted
   * spans are pulled out rather than trying to evaluate the module.
   */
  biography(): string {
    const file = this.path('src/character.ts');
    if (!existsSync(file)) return '';
    const source = readFileSync(file, 'utf8');
    const block = source.match(/bio:\s*\[([\s\S]*?)\n\],/);
    if (!block?.[1]) return '';
    const sentences = [...block[1].matchAll(/"([^"]{40,})"/g)].map((m) => m[1]!.trim());
    return sentences.join('\n\n');
  }

  /** The Chinese persona statement from `character.system`. */
  systemStatement(): string {
    const file = this.path('src/character.ts');
    if (!existsSync(file)) return '';
    const source = readFileSync(file, 'utf8');
    const block = source.match(/system:\s*`([\s\S]*?)`/);
    return block?.[1]?.trim() ?? '';
  }

  postedSignatures(): string[] {
    const rows = this.readJson<string[]>('posted_index.json', []);
    return rows.filter((s) => typeof s === 'string' && s.includes('|'));
  }

  seenMentions(): string[] {
    return this.readJson<string[]>('seen_mentions.json', []).filter((s) => typeof s === 'string' && s.length > 0);
  }

  inboxItems(): Array<{
    id: string;
    tweetUrl: string;
    replyToId: string | null;
    authorUsername: string;
    mentionText: string;
    parentText: string | null;
    createdAt: string | null;
  }> {
    const rows = this.readJson<Array<Record<string, unknown>>>('mentions_inbox.json', []);
    return rows
      .filter((r) => typeof r.tweetUrl === 'string')
      .map((r) => ({
        id: String(r.id ?? ''),
        tweetUrl: String(r.tweetUrl),
        replyToId: typeof r.replyToId === 'string' ? r.replyToId : null,
        authorUsername: String(r.authorUsername ?? '').replace(/^@/, ''),
        mentionText: String(r.mentionText ?? ''),
        parentText: typeof r.parentText === 'string' ? r.parentText : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
      }));
  }
}

export interface LegacyMemoryRow {
  id: string;
  role: string | null;
  channel: string | null;
  username: string | null;
  tweetId: string | null;
  inReplyToId: string | null;
  content: string | null;
  createdAt: number | null;
}

/** Opens the legacy SQLite database read-only and returns its memory rows. */
export async function readLegacyMemory(root: string): Promise<LegacyMemoryRow[]> {
  const file = resolve(root, '.eliza/elizadb.sqlite');
  if (!existsSync(file)) return [];
  // node:sqlite has no bundled types in this Node release, hence the cast.
  const sqlite = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare(sql: string): { all(): unknown[] };
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT id, role, channel, username, tweetId, inReplyToId, content, createdAt FROM memory')
      .all() as LegacyMemoryRow[];
  } finally {
    db.close();
  }
}

/**
 * Locations that hold live credentials or session material.
 *
 * These are reported so they can be rotated and removed. Their contents are
 * never read, never printed, and never imported.
 */
const CREDENTIAL_LOCATIONS = [
  '.env',
  '.env.scraper',
  'cookies.json',
  'twitter-session.json',
  'auth.js',
  'getToken.js',
  'x-session-data',
  'scripts/twikit_mentions/.env',
  'scripts/twikit_mentions/cookies.json',
];

export interface CredentialFinding {
  path: string;
  kind: 'file' | 'directory';
  bytes: number;
}

export function findCredentialLocations(root: string): CredentialFinding[] {
  const found: CredentialFinding[] = [];
  for (const relative of CREDENTIAL_LOCATIONS) {
    const file = resolve(root, relative);
    if (!existsSync(file)) continue;
    const info = statSync(file);
    found.push({ path: relative, kind: info.isDirectory() ? 'directory' : 'file', bytes: info.isDirectory() ? 0 : info.size });
  }
  return found;
}
