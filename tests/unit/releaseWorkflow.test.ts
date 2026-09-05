import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
const iss = readFileSync(resolve(root, 'packaging/windows/ai17z.iss'), 'utf8');
const policy = readFileSync(resolve(root, 'docs/CODE_SIGNING_POLICY.md'), 'utf8');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

/**
 * The one property of the release pipeline that must never quietly regress.
 *
 * A workflow that expected a signature, did not get one, and published anyway
 * would be worse than one that never signed at all: it attaches the project's
 * name to an artifact nobody checked. The guard is three lines of shell, which
 * is exactly the kind of thing that gets refactored away by somebody tidying up.
 */
describe('the release refuses to publish unsigned when signing was required', () => {
  it('has a guard that reads both the requirement and the outcome', () => {
    expect(workflow).toContain('vars.SIGNING_REQUIRED');
    expect(workflow).toContain('needs.sign.result');
    expect(workflow).toMatch(/Refusing to publish an unsigned installer/);
  });

  it('fails rather than warns', () => {
    const guard = workflow.slice(workflow.indexOf('Refuse to publish unsigned'));
    expect(guard.slice(0, 900)).toContain('exit 1');
  });

  it('publishes whichever artifact matches the lane', () => {
    // Downloading the unsigned artifact while claiming to be signed is the same
    // failure wearing a different hat.
    expect(workflow).toMatch(/signed-installer.*unsigned-installer/s);
  });

  it('names each missing SignPath setting rather than failing vaguely', () => {
    // "Signing failed" is not something anybody can act on.
    for (const setting of [
      'SIGNPATH_API_TOKEN',
      'SIGNPATH_ORGANIZATION_ID',
      'SIGNPATH_PROJECT_SLUG',
      'SIGNPATH_SIGNING_POLICY_SLUG',
    ]) {
      expect(workflow, `${setting} is not checked for`).toContain(setting);
    }
  });

  it('never puts a SignPath credential in the file', () => {
    // Tokens come from secrets. A literal here would be committed history.
    const secretish = workflow.match(/api-token:\s*(.+)/);
    expect(secretish?.[1]).toContain('secrets.SIGNPATH_API_TOKEN');
    expect(workflow).not.toMatch(/api-token:\s*['"][A-Za-z0-9+/=]{16,}/);
  });
});

/**
 * SignPath does not take our word for it that a signature came back, and
 * neither should we. It signs what it is given; whether the file we are about
 * to publish is the right product, the right version and actually valid is a
 * separate question.
 */
describe('the signature is verified before anything is published', () => {
  it('checks the signature status on the returned file', () => {
    expect(workflow).toContain('Get-AuthenticodeSignature');
    expect(workflow).toMatch(/Signature is not valid/);
  });

  it('checks the product and version, not just that something was signed', () => {
    const verify = workflow.slice(workflow.indexOf('Verify the signature on what came back'));
    expect(verify).toContain('Signed the wrong product');
    expect(verify).toContain('Signed the wrong version');
  });

  it('uses signtool as a second opinion where the runner has it', () => {
    expect(workflow).toContain('signtool');
    expect(workflow).toContain('verify /pa');
  });
});

/**
 * SignPath requires signed binaries to carry product and version attributes,
 * and the build checks its own output before handing it over.
 */
describe('the installer carries the metadata SignPath requires', () => {
  it('sets product, version and publisher', () => {
    // Through the preprocessor macros, so the version comes from one place and
    // the compiler command line cannot disagree with the file.
    expect(iss).toMatch(/#define AppName "AI17Z"/);
    expect(iss).toMatch(/VersionInfoProductName=\{#AppName\}/);
  });

  it('is checked in CI rather than assumed', () => {
    expect(workflow).toContain('Check the metadata SignPath requires');
    expect(workflow).toContain('Wrong product name');
  });

  it('trims the version resource before comparing it', () => {
    // Windows pads version-resource strings: ProductName comes back as "AI17Z"
    // followed by 55 spaces, so an exact comparison fails on a file that is
    // perfectly correct. This failed the build after the compile had succeeded.
    const comparisons = workflow.match(/\$info\.ProductName[^\n]*/g) ?? [];
    expect(comparisons.length).toBeGreaterThan(0);
    for (const line of comparisons) {
      expect(line, 'an untrimmed ProductName comparison').not.toMatch(/\$info\.ProductName\s+-(ne|eq)\s/);
    }
    expect(workflow).toContain('.ProductName.Trim()');
    expect(workflow).toContain('.ProductVersion.Trim()');
  });
});

/**
 * The trap that cost a release.
 *
 * `VersionInfoVersion` is a Windows version resource and has to be numbers.
 * `v0.1.0` compiles; `v0.1.0-rc.1` makes Inno refuse the whole script, one
 * second into the step, at the end of an eight-minute build -- and every tag
 * worth making a release candidate of has a suffix. So the numeric part is
 * derived, and the string a person reads goes through the Text directives,
 * which take free text.
 */
describe('a prerelease tag still compiles', () => {
  it('derives a numeric version rather than using the tag', () => {
    expect(iss).toContain('#define NumericVersion');
    expect(iss).toMatch(/VersionInfoVersion=\{#NumericVersion\}/);
    expect(iss).toMatch(/VersionInfoProductVersion=\{#NumericVersion\}/);
  });

  it('never hands the raw tag to a numeric directive', () => {
    for (const directive of ['VersionInfoVersion', 'VersionInfoProductVersion']) {
      expect(iss, `${directive} would reject a prerelease tag`).not.toContain(`${directive}={#AppVersion}`);
    }
  });

  it('still shows the full version in the file properties', () => {
    // What the release workflow checks, and what somebody reading the
    // properties of a downloaded file needs to see.
    expect(iss).toMatch(/VersionInfoTextVersion=\{#AppVersion\}/);
    expect(iss).toMatch(/VersionInfoProductTextVersion=\{#AppVersion\}/);
  });

  it('cuts at the first dash, which is where a suffix starts', () => {
    // Mirrors the ISPP expression: everything before the first "-", or the
    // whole string when there is none. Pinned so a rewrite has to stay correct
    // for the shapes that actually get tagged.
    const numeric = (version: string) => (version.includes('-') ? version.slice(0, version.indexOf('-')) : version);
    expect(numeric('0.1.0-rc.1')).toBe('0.1.0');
    expect(numeric('1.2.3')).toBe('1.2.3');
    expect(numeric('2.0.0-beta.4')).toBe('2.0.0');
    expect(iss).toContain('Pos("-", AppVersion)');
  });
});

/**
 * The second half of the same failure.
 *
 * The build staged 359 source files and no dependencies, and the check in front
 * of it -- "at least 100 files" -- passed. An installer built from that
 * installs happily and then cannot start, and the first person to discover it
 * is whoever downloaded it.
 */
describe('the build refuses to ship an application with no dependencies', () => {
  const packager = readFileSync(resolve(root, 'tools/package-windows.mts'), 'utf8');

  it('names packages the host process actually loads', () => {
    for (const proof of ['fastify', 'pg']) {
      expect(packager, `${proof} is not proved present`).toContain(`node_modules/${proof}`);
    }
    expect(packager).toMatch(/would install and then fail to start|install and then fail to start/i);
  });

  it('checks the same thing in CI, where a person reads the failure', () => {
    expect(workflow).toContain('node_modules\\fastify');
    expect(workflow).toContain('has no dependencies');
  });

  it('does not rest on a file count', () => {
    // The sources alone clear any threshold worth setting.
    expect(workflow).not.toMatch(/\$count -lt 100/);
  });
});

/**
 * An uninstaller that can hang is worse than an untidy one: the person cannot
 * even retry. Both hangs found by running it are pinned here.
 */
describe('the uninstaller cannot hang', () => {
  it('runs its stop step non-interactively', () => {
    expect(iss).toContain('-NonInteractive');
  });

  it('uses the purpose-built stop rather than the interactive one', () => {
    // stop-ai17z.ps1 reads input in one branch and waits on Docker in others.
    // Checked on the line that actually runs something, because the comment
    // above it names the script it deliberately does not use.
    const runsSomething = iss
      .split(/\r?\n/)
      .filter((line) => line.includes('ExpandConstant') && line.includes('.ps1'))
      .join(' ');
    expect(runsSomething).toContain('Stop-ForUninstall.ps1');
    expect(runsSomething).not.toContain('stop-ai17z.ps1');
  });

  it('skips the data question entirely when nobody is there to answer it', () => {
    // /SUPPRESSMSGBOXES suppresses Setup's own dialogs, not one raised from
    // [Code], so a silent uninstall waited for ever without this.
    expect(iss).toContain('UninstallSilent()');
  });

  it('keeps the data when the question goes unanswered', () => {
    // The reversible choice is the right default.
    const silent = iss.slice(iss.indexOf('UninstallSilent()'));
    expect(silent.slice(0, 200)).toContain('Exit');
  });
});

describe('what SignPath will read', () => {
  it('carries the exact attribution their programme requires', () => {
    const required = 'Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)';
    const flatten = (text: string) => text.replace(/\s+/g, ' ');
    expect(flatten(policy)).toContain(flatten(required));
    expect(flatten(readme)).toContain(flatten(required));
  });

  it('has a "Code signing policy" heading on the download page', () => {
    // Their condition names the wording, not just the presence of a link.
    expect(readme).toMatch(/#+\s*Code signing policy/i);
  });

  it('names who may approve a signing request', () => {
    for (const role of ['Authors', 'Reviewers', 'Approvers']) {
      expect(policy, `${role} is not documented`).toContain(role);
    }
  });

  it('says signing requires a person', () => {
    expect(policy).toMatch(/approved \*\*manually\*\*|approved manually/i);
  });

  it('states the MFA requirement', () => {
    expect(policy).toMatch(/multi-factor/i);
  });
});

/**
 * The correction. Two documents said an EV certificate carries SmartScreen
 * reputation immediately; Microsoft removed that behaviour in 2024.
 */
describe('the SmartScreen documentation is not out of date', () => {
  // The published ones, plus whichever internal notes are present. The internal
  // docs are not in the repository -- they live in a gitignored directory -- so
  // they are checked when they exist and skipped when somebody is working from
  // a clean clone.
  const paths = [
    'docs/WINDOWS_TRUST.md',
    'docs/internal/CONTINUATION_STATE.md',
    'docs/internal/RELEASE_HANDOFF.md',
  ];
  const docs = paths
    .map((p) => {
      try {
        return readFileSync(resolve(root, p), 'utf8');
      } catch {
        return null;
      }
    })
    .filter((text): text is string => text !== null);

  it('never claims EV grants immediate reputation', () => {
    for (const doc of docs) {
      expect(doc).not.toMatch(/EV carries SmartScreen reputation immediately/i);
    }
  });

  it('keeps reputation and malware submission apart', () => {
    const trust = docs[0]!;
    expect(trust).toMatch(/no need \(or mechanism\)|there is no way to ask/i);
    expect(trust).toContain('wdsi/filesubmission');
    expect(trust).toMatch(/not\*{0,2}\s*a way to whitelist|It is \*\*not\*\* a way/i);
  });

  it('never instructs anybody to turn a protection off', () => {
    // The words appear in these documents on purpose: there is a list of things
    // AI17Z will never ask for, and naming them is the whole point of it. What
    // must not appear is an *instruction*, so this looks for the imperative
    // rather than for the vocabulary. The first version of this test failed on
    // the very sentence promising we would never say it.
    for (const doc of docs) {
      expect(doc).not.toMatch(
        /(?:you (?:must|should|need to|can)|please|first,?)\s+(?:temporarily\s+)?(?:disable|turn off)\s+(?:SmartScreen|Smart App Control|Defender|your antivirus)/i,
      );
    }
  });

  it('commits in writing to never asking for it', () => {
    expect(docs[0]).toMatch(/will not ask you to disable/i);
  });
});
