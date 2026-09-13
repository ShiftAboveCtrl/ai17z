import { z } from 'zod';
import { INSTALL_METHODS, PLATFORMS, ARCHITECTURES, PLATFORM_OF_METHOD } from './releaseManifest';
import type { Architecture, InstallMethod, Platform } from './releaseManifest';

/**
 * What an installation records about itself, and how old records are read.
 *
 * `INSTALL_INFO.json` has existed since the Windows installer needed to know
 * which of two routes had put a program directory somewhere. Schema 1 was the
 * Inno installer's, schema 2 added the fields the terminal route needed, and
 * schema 3 is this: enough for one updater to serve three platforms without
 * platform details leaking into application state.
 *
 * Two rules hold across all of them, and both are the lesson of a real defect:
 *
 * **A record says how a copy was installed. It never says where one is.** The
 * directory a run is standing in decides that. Beta 1.0.0 (14) believed a name
 * over a location and wrote one installation's files into another's folder.
 *
 * **An older record is read forward, never rejected.** Nobody reinstalls
 * because a schema number moved. `upgradeInstallRecord` takes 1 or 2 and fills
 * in what 3 wants from the directory it was found in, which is the only
 * trustworthy source for a path anyway.
 */

export const INSTALL_LAYOUT_SCHEMA = 3;

export const installRecordSchema = z.object({
  schema: z.number().int().positive(),
  platform: z.enum(PLATFORMS),
  arch: z.enum(ARCHITECTURES),
  installMethod: z.enum(INSTALL_METHODS),
  /** What this installation is called. One name settles every derived path. */
  instance: z.string().min(1),
  appVersion: z.string().min(1),
  /** The directory replaced on every update. Nothing of the owner's lives here. */
  appRoot: z.string().min(1),
  /** The directory never replaced: .env, the master key, storage, the database pointer. */
  dataRoot: z.string().min(1),
  /** The private Node the package carries, or null where the platform has none yet. */
  runtimeRoot: z.string().nullable(),
  /** Where the signed-in browser session lives. Under dataRoot, never under appRoot. */
  browserProfileRoot: z.string().nullable(),
  release: z.string().min(1).optional(),
  installedAt: z.string().min(1).optional(),
  updateCommand: z.string().optional(),
  /** Whether AI17Z installed a dependency or merely found it. */
  dependencies: z.record(z.string(), z.unknown()).optional(),
});
export type InstallRecord = z.infer<typeof installRecordSchema>;

/** Everything needed to read an old record forward without guessing. */
export interface LayoutContext {
  /** The directory the record was actually found in. Outranks anything it claims. */
  foundInAppRoot: string;
  platform: Platform;
  arch: Architecture;
  /** From `data-location.txt` beside the program, which predates every schema. */
  dataRootHint?: string | null;
  /** `BUILD_INFO.json`'s version, for records too old to carry one. */
  versionHint?: string | null;
}

/** Trailing separators and slash direction, so two spellings of one path compare equal. */
export function normalisePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\');
}

/** Whether two paths name the same directory, ignoring spelling and case. */
export function samePath(left: string, right: string): boolean {
  return normalisePath(left).toLowerCase() === normalisePath(right).toLowerCase();
}

export interface TrustVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Whether a record describes the installation it was found in.
 *
 * The path is compared and the *name* deliberately is not. Somebody who chose
 * their own directory has a folder called whatever they called it, and an
 * earlier version of this guard assumed the folder leaf was the instance name
 * -- which would have refused to update every installation with a custom
 * program directory, including the ones the verification harness makes.
 */
export function trustInstallRecord(record: Partial<InstallRecord> | null, foundInAppRoot: string): TrustVerdict {
  if (!record) return { ok: true, reason: 'no metadata' };
  const claimed = record.appRoot ?? (record as { programDir?: string }).programDir ?? '';
  if (!claimed) return { ok: true, reason: 'no directory claimed' };
  if (!samePath(claimed, foundInAppRoot)) {
    return {
      ok: false,
      reason: `its INSTALL_INFO.json describes ${claimed}, but it was read from ${foundInAppRoot}`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Reads any supported record forward to the current schema.
 *
 * Returns null only when there is nothing to read at all -- a record from
 * before the file existed -- which callers already treat as "assume the oldest
 * route", because that is what actually made those installations.
 */
export function upgradeInstallRecord(raw: unknown, context: LayoutContext): InstallRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const schema = Number(record.schema ?? 0);

  // Already current, and valid. Anything malformed falls through to be rebuilt
  // from the directory rather than refused: a record nobody can parse is a
  // reason to distrust the record, not to strand the installation.
  if (schema >= INSTALL_LAYOUT_SCHEMA) {
    const parsed = installRecordSchema.safeParse(record);
    if (parsed.success) return parsed.data;
  }

  const legacyMethod = String(record.channel ?? record.installMethod ?? '').toUpperCase();
  const method: InstallMethod = (INSTALL_METHODS as readonly string[]).includes(legacyMethod)
    ? (legacyMethod as InstallMethod)
    : // No marker at all means the Windows installer made it: that is what made
      // every copy from before the marker existed, and guessing a third answer
      // is how one of them stops being able to update.
      context.platform === 'windows'
        ? 'INSTALLER'
        : context.platform === 'macos'
          ? 'MACOS_PKG'
          : 'UBUNTU_DEB';

  const appRoot = context.foundInAppRoot;
  const dataRoot =
    (typeof record.dataDir === 'string' && record.dataDir) ||
    (typeof record.dataRoot === 'string' && record.dataRoot) ||
    context.dataRootHint ||
    '';
  if (!dataRoot) return null;

  const instance =
    (typeof record.instance === 'string' && record.instance) ||
    appRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ||
    'AI17Z';

  return {
    schema: INSTALL_LAYOUT_SCHEMA,
    platform: context.platform,
    arch: context.arch,
    installMethod: method,
    instance,
    appVersion:
      (typeof record.version === 'string' && record.version) ||
      (typeof record.appVersion === 'string' && record.appVersion) ||
      context.versionHint ||
      '0.0.0',
    appRoot,
    dataRoot,
    // Older layouts had no private runtime; null is the honest answer and the
    // caller falls back to whatever Node it was started with, exactly as before.
    runtimeRoot: typeof record.runtimeRoot === 'string' ? record.runtimeRoot : null,
    browserProfileRoot:
      typeof record.browserProfileRoot === 'string' ? record.browserProfileRoot : null,
    release: typeof record.release === 'string' ? record.release : undefined,
    installedAt: typeof record.installedAt === 'string' ? record.installedAt : undefined,
    updateCommand: typeof record.updateCommand === 'string' ? record.updateCommand : undefined,
    dependencies:
      record.dependencies && typeof record.dependencies === 'object'
        ? (record.dependencies as Record<string, unknown>)
        : undefined,
  };
}

/** Whether a record and the platform it was found on can both be true. */
export function recordMatchesPlatform(record: InstallRecord): boolean {
  const expected = PLATFORM_OF_METHOD[record.installMethod];
  return expected === null || expected === record.platform;
}
