import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markProfilesExitedCleanly } from '@xbam/browser';

async function profile(contents: Record<string, unknown> | string | null, name = 'Default'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai17z-chrome-'));
  await mkdir(join(root, name), { recursive: true });
  if (contents !== null) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
    await writeFile(join(root, name, 'Preferences'), text, 'utf8');
  }
  return root;
}

const read = async (root: string, name = 'Default') =>
  JSON.parse(await readFile(join(root, name, 'Preferences'), 'utf8')) as Record<string, any>;

/**
 * Chrome decides on startup whether the last session ended badly, and if it
 * thinks so it restores the previous tabs. This runtime identifies its four
 * tabs by window.name, so restored tabs arrive untagged: the roles are gone,
 * the adopter finds tabs it never opened, and the agent stops working while the
 * browser looks perfectly healthy. Nobody is sitting there to dismiss a bubble.
 *
 * The command-line flags hide the bubble. Only this stops the restore.
 */
describe('marking a Chrome profile as having exited cleanly', () => {
  it('sets both keys Chrome reads', async () => {
    const root = await profile({ profile: { exit_type: 'Crashed', exited_cleanly: false } });
    const result = await markProfilesExitedCleanly(root);

    expect(result.marked).toEqual(['Default']);
    const prefs = await read(root);
    expect(prefs.profile.exit_type).toBe('none');
    expect(prefs.profile.exited_cleanly).toBe(true);
  });

  it('keeps everything else in the file, which is where the signed-in session lives', async () => {
    const root = await profile({
      profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person 1' },
      account_info: [{ email: 'someone@example.com' }],
      extensions: { settings: { abc: { state: 1 } } },
    });
    await markProfilesExitedCleanly(root);

    const prefs = await read(root);
    expect(prefs.account_info).toEqual([{ email: 'someone@example.com' }]);
    expect(prefs.extensions.settings.abc.state).toBe(1);
    expect(prefs.profile.name).toBe('Person 1');
  });

  it('refuses to rewrite a Preferences file it could not parse', async () => {
    // Suppressing a dialog is not worth costing somebody their signed-in
    // session. A corrupt profile has to be signed in again, and sign-in is
    // always the user's job.
    const broken = '{"profile": {"exit_type": "Crash';
    const root = await profile(broken);

    const result = await markProfilesExitedCleanly(root);
    expect(result.marked).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/not valid JSON/);
    expect(await readFile(join(root, 'Default', 'Preferences'), 'utf8')).toBe(broken);
  });

  it('leaves a profile Chrome has never opened alone', async () => {
    const root = await profile(null);
    const result = await markProfilesExitedCleanly(root);
    expect(result.marked).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no Preferences/);
  });

  it('handles a profile with no profile section at all', async () => {
    const root = await profile({ account_info: [] });
    await markProfilesExitedCleanly(root);
    const prefs = await read(root);
    expect(prefs.profile.exit_type).toBe('none');
    expect(prefs.account_info).toEqual([]);
  });

  it('marks every profile in the directory, not only Default', async () => {
    const root = await profile({ profile: { exit_type: 'Crashed' } });
    await mkdir(join(root, 'Profile 1'), { recursive: true });
    await writeFile(join(root, 'Profile 1', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed' } }));
    // Not a profile directory, and must not be treated as one.
    await mkdir(join(root, 'ShaderCache'), { recursive: true });

    const result = await markProfilesExitedCleanly(root);
    expect(result.marked.sort()).toEqual(['Default', 'Profile 1']);
  });

  it('says so rather than rewriting when it is already clean', async () => {
    const root = await profile({ profile: { exit_type: 'none', exited_cleanly: true } });
    const result = await markProfilesExitedCleanly(root);
    expect(result.marked).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/already/);
  });

  it('does not throw when the directory does not exist', async () => {
    // A browser that starts with a restore bubble is worse than one that does
    // not. It is not a reason to refuse to start at all.
    await expect(markProfilesExitedCleanly(join(tmpdir(), 'ai17z-nope-' + Date.now()))).resolves.toEqual({
      marked: [],
      skipped: [],
    });
  });

  it('leaves no temporary file behind', async () => {
    const { readdir } = await import('node:fs/promises');
    const root = await profile({ profile: { exit_type: 'Crashed' } });
    await markProfilesExitedCleanly(root);
    const entries = await readdir(join(root, 'Default'));
    expect(entries).toEqual(['Preferences']);
  });
});
