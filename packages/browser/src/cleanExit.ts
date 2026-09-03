/**
 * Telling Chrome its last exit was clean, before it is started again.
 *
 * The flags that hide the restore bubble hide the *bubble*. They do not stop
 * Chrome deciding the previous session ended badly, and that decision is what
 * restores the previous set of tabs. The runtime identifies its four tabs by
 * `window.name`, so restored tabs arrive untagged: the roles are gone, the
 * adopter finds tabs it never opened, and the agent stops working while the
 * browser looks perfectly healthy.
 *
 * Chrome records the verdict in the profile's own Preferences file, as
 * `exit_type` and `exited_cleanly`. Setting them before launch is the supported
 * way to say the last run finished properly.
 *
 * Two rules, because this file also holds the signed-in session:
 *
 * 1. Never write a file that could not be parsed. A profile with a corrupt
 *    Preferences file is a profile that has to be signed in again, and
 *    suppressing a dialog is not worth costing somebody their session.
 * 2. Write through a temporary file and rename. A half-written Preferences is
 *    the exact corruption in (1), caused by the fix for it.
 *
 * Only safe while Chrome is not running against the profile: it rewrites this
 * file on exit and would overwrite anything set underneath it.
 */
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@xbam/shared';

const log = createLogger('browser-profile');

export interface CleanExitResult {
  /** Profile directories whose Preferences now say the last exit was clean. */
  marked: string[];
  /** Directories left alone, and why. */
  skipped: { profile: string; reason: string }[];
}

/**
 * A Chrome user-data directory holds one Preferences file per profile, in
 * `Default` and in any `Profile N`. Reading the directory rather than assuming
 * `Default` keeps this working for a profile the runtime did not create.
 */
async function profileDirectories(userDataDir: string): Promise<string[]> {
  const entries = await readdir(userDataDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
    .map((e) => e.name);
}

/** Whether this object is a plain JSON object we can safely edit. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mark every profile in a user-data directory as having exited cleanly.
 *
 * Returns what it did rather than throwing: a browser that starts with a
 * restore bubble is worse than one that does not, but it is not a reason to
 * refuse to start at all.
 */
export async function markProfilesExitedCleanly(userDataDir: string): Promise<CleanExitResult> {
  const result: CleanExitResult = { marked: [], skipped: [] };

  for (const profile of await profileDirectories(userDataDir)) {
    const path = join(userDataDir, profile, 'Preferences');

    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
      // A profile Chrome has never opened has no Preferences yet, and has
      // nothing to restore either.
      result.skipped.push({ profile, reason: 'no Preferences file yet' });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      result.skipped.push({ profile, reason: 'Preferences is not valid JSON' });
      log.warn('leaving a profile alone rather than rewriting it', { profile });
      continue;
    }
    if (!isRecord(parsed)) {
      result.skipped.push({ profile, reason: 'Preferences is not an object' });
      continue;
    }

    const settings = isRecord(parsed.profile) ? parsed.profile : {};
    if (settings.exit_type === 'none' && settings.exited_cleanly === true) {
      result.skipped.push({ profile, reason: 'already marked clean' });
      continue;
    }

    // "none" rather than "Normal": Chrome writes "Normal" itself on a tidy
    // exit, and "none" additionally means there is no session to offer.
    parsed.profile = { ...settings, exit_type: 'none', exited_cleanly: true };

    const temporary = `${path}.ai17z-tmp`;
    try {
      await writeFile(temporary, JSON.stringify(parsed), 'utf8');
      await rename(temporary, path);
      result.marked.push(profile);
    } catch (error) {
      result.skipped.push({ profile, reason: 'could not be written' });
      log.warn('could not mark a profile as cleanly exited', {
        profile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.marked.length > 0) {
    log.info('profiles marked as cleanly exited', { profiles: result.marked });
  }
  return result;
}
