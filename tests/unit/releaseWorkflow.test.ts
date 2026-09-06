import { existsSync, readFileSync } from 'node:fs';
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

/**
 * The release notes are the changelog the application shows.
 *
 * `UpdatePanel` renders the release body, so whatever this step writes is what
 * somebody reads when deciding whether to take an update. It described what
 * AI17Z is and how to install it -- true, and no help at all to somebody
 * already running it who wants to know what is different.
 *
 * The trap underneath is that a shallow checkout makes this fail silently: one
 * commit, no tags, and `git log previous..this` is empty rather than wrong.
 */
describe('the release notes say what changed', () => {
  it('lists the commits since the previous tag', () => {
    expect(workflow).toContain('What changed since');
    expect(workflow).toMatch(/git log --no-merges --format='- %s' "\$PREV\.\.\$TAG"/);
  });

  it('finds the previous tag rather than being told one', () => {
    // `git describe --tags --abbrev=0 <tag>^` is the previous tag reachable
    // from this one, which stays right when a release is skipped or deleted.
    expect(workflow).toContain('git describe --tags --abbrev=0 "$TAG^"');
  });

  it('checks out the history the changelog needs', () => {
    // Three checkouts, and only the publishing one needs history. Without
    // fetch-depth 0 there is one commit and no tags, so the changelog would be
    // empty and nothing would say so.
    expect(workflow).toContain('fetch-depth: 0');
    const publish = workflow.slice(workflow.indexOf('publish the release'));
    const checkout = publish.indexOf('actions/checkout@v4');
    expect(checkout, 'the publish job no longer checks out').toBeGreaterThan(-1);
    expect(publish.slice(checkout, checkout + 400)).toContain('fetch-depth: 0');
  });

  it('says nothing rather than something wrong when there is no tag', () => {
    // A workflow_dispatch build has no tag to compare against, and a changelog
    // invented from whatever HEAD happens to be would be worse than none.
    expect(workflow).toContain('git rev-parse -q --verify "refs/tags/$TAG"');
  });
});

/**
 * The installer's own look, and the one page that could not have it.
 *
 * Stock Inno ships a blue-green gradient with a hand holding a box. It is the
 * first thing anybody sees of AI17Z, so the wizard is painted in the product's
 * own palette by walking the controls Inno has already built -- rather than by
 * shipping a skinning DLL, which is a supply-chain cost nobody should pay for a
 * colour scheme.
 *
 * Everything here was compiled and photographed before it was believed. Two
 * things were only found that way: `TNewNotebook` has no `Color` in Pascal
 * Script and naming it aborts the whole compile, and the licence page cannot be
 * themed at all.
 */
describe('the installer looks like the product', () => {
  const iss = readFileSync(resolve(root, 'packaging/windows/ai17z.iss'), 'utf8');

  it('ships its own artwork rather than Inno default', () => {
    expect(iss).toContain('WizardImageFile=wizard-panel.bmp');
    expect(iss).toContain('WizardSmallImageFile=wizard-small.bmp');
    expect(iss).toContain('SetupIconFile=ai17z.ico');
  });

  it('has that artwork committed, since the compiler reads it at build time', () => {
    for (const art of ['wizard-panel.bmp', 'wizard-small.bmp', 'ai17z.ico']) {
      expect(existsSync(resolve(root, 'packaging/windows', art)), `${art} is missing`).toBe(true);
    }
  });

  it('can regenerate the artwork rather than only owning the binaries', () => {
    expect(existsSync(resolve(root, 'packaging/windows/make-wizard-art.py'))).toBe(true);
    expect(existsSync(resolve(root, 'packaging/windows/make-icon.py'))).toBe(true);
  });

  it('leaves the wizard itself to Windows', () => {
    // The artwork is the product's; the form is not. Repainting the wizard in
    // the product's dark palette was tried and taken out again: a
    // TRichEditViewer keeps its own character colours, a themed radio draws
    // its caption in the theme colour whatever it is told, and a themed button
    // loses the focus ring somebody tabbing through the wizard needs. What
    // arrived was an installer with unreadable controls, which is a worse
    // first impression than a plain one.
    expect(iss).not.toContain('procedure PaintWizard');
    expect(iss).not.toContain('CurPageChanged_Paint');
    expect(iss).not.toMatch(/^\s*WizardForm\.[A-Za-z]+\.Color\s*:=/m);
  });

  it('never names a control Pascal Script cannot colour', () => {
    // `WizardForm.InnerNotebook.Color` compiles to "Unknown identifier 'COLOR'"
    // and aborts the entire build -- a one-line error at the end of an
    // eight-minute compile.
    expect(iss).not.toMatch(/InnerNotebook\.Color/);
    expect(iss).not.toMatch(/OuterNotebook\.Color/);
  });

  it('shows the licence, on a page Windows can draw', () => {
    // MIT requires the licence to be included. It is also the one page that
    // could not survive theming, so it is the canary: if it is commented out
    // again, the palette came back with it.
    expect(iss).toMatch(/^LicenseFile=/m);
    expect(existsSync(resolve(root, 'LICENSE')), 'the licence itself must still ship').toBe(true);
    expect(readFileSync(resolve(root, 'tools/package-windows.mts'), 'utf8')).toContain("'LICENSE'");
  });
});

/**
 * The release name, which the installer derives a second time.
 *
 * `releaseName()` in packages/shared/src/version.ts is what AI17Z shows on its
 * own version screen. The Windows uninstall list is written by the installer
 * and cannot call it, so ai17z.iss reimplements the same grammar in ISPP. Two
 * implementations is one more than the rule allows, and this is the price of
 * it: the words have to be checked against each other, because the failure is
 * silent -- Add/Remove Programs saying one thing and the app saying another
 * looks like two builds installed at once.
 */
describe('what a release is called, in both places that say it', () => {
  const iss = readFileSync(resolve(root, 'packaging/windows/ai17z.iss'), 'utf8');
  const version = readFileSync(resolve(root, 'packages/shared/src/version.ts'), 'utf8');

  it('uses the derived name for what a person reads, and the number for what Windows parses', () => {
    expect(iss).toMatch(/^AppVerName=\{#ReleaseName\}/m);
    expect(iss).toMatch(/^UninstallDisplayName=\{#ReleaseName\}/m);
    // VersionInfoVersion must stay four numbers or Inno refuses the script.
    expect(iss).toMatch(/^VersionInfoVersion=\{#NumericVersion\}/m);
    // And the download filename stays the version, because it is a URL: a name
    // with a space and a bracket in it is not.
    expect(iss).toMatch(/^OutputBaseFilename=AI17Z-Setup-\{#AppVersion\}/m);
  });

  it('spells the channels the same way on both sides', () => {
    for (const [identifier, word] of [
      ['alpha', 'Alpha'],
      ['beta', 'Beta'],
      ['rc', 'Release Candidate'],
      ['preview', 'Preview'],
    ] as const) {
      expect(version, `${identifier} is missing from releaseName()`).toContain(`${identifier}: '${word}'`);
      expect(iss, `${identifier} is missing from the installer`).toContain(`== "${identifier}" ? "${word}"`);
    }
  });

  it('drops the iteration for the first of a cycle on both sides', () => {
    // "AI17Z Beta 1.0.0 (1)" in one place and "AI17Z Beta 1.0.0" in the other
    // is exactly the disagreement that reads as two builds.
    expect(version).toContain("iteration > 1 ? ` (${iteration})` : ''");
    expect(iss).toContain('(PreCount != "" && PreCount != "1")');
  });
});

/**
 * The releases page has to agree with the application.
 *
 * The workflow fires on every `v*` tag, builds its own installer and publishes
 * with softprops/action-gh-release -- which *updates* a release that already
 * exists. So whatever it passes as `name` is the last word, and it was
 * composing one of its own: `AI17Z 1.0.0-beta.2`, while the installer wrote
 * "AI17Z Beta 1.0.0 (2)" into Add/Remove Programs and the version screen said
 * the same. Three places, two answers, and the one people see first was the
 * odd one out.
 *
 * The packager already derives the name from releaseName() and prints it. The
 * workflow reads that rather than composing a fourth version of the grammar.
 */
describe('the release workflow publishes under the derived name', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');

  it('carries the name out of the build job', () => {
    expect(workflow).toContain('release-name: ${{ steps.stage.outputs.release-name }}');
  });

  it('reads it from the packager rather than composing it again', () => {
    expect(workflow).toContain("Select-String -Pattern '^AI17Z_RELEASE_NAME=(.+)$'");
    // And refuses rather than quietly falling back, because a silent fallback
    // is how it went unnoticed the first time.
    expect(workflow).toContain('The packager did not print AI17Z_RELEASE_NAME.');
  });

  it('uses it when publishing', () => {
    expect(workflow).toContain("name: ${{ needs.build.outputs.release-name || format('AI17Z {0}', needs.build.outputs.version) }}");
  });

  it('lets written notes win over the generated list of commit subjects', () => {
    // `- web: a hook below an early return` is a true summary of a release
    // nobody could open, and no use at all to somebody deciding whether to
    // download it.
    expect(workflow).toContain('NOTES="docs/release-notes/$VERSION.md"');
    expect(workflow).toContain('if [ -f "$NOTES" ]; then');
    // Appended, never discarded: the commit list is still the honest record.
    expect(workflow).toMatch(/cat "\$NOTES"; echo; echo '---'/);
  });

  it('has the notes for the version this repository is on', () => {
    const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
    const notes = resolve(root, `docs/release-notes/${version}.md`);
    expect(existsSync(notes), `docs/release-notes/${version}.md is missing`).toBe(true);
    expect(readFileSync(notes, 'utf8').trim().length).toBeGreaterThan(200);
  });
});
