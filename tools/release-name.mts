/**
 * What a release is called, for the shell scripts that publish one.
 *
 *   npx tsx tools/release-name.mts <version> [page|short|title]
 *
 * `page` (the default) shortens betas to `Beta 0.89` and keeps RC and stable
 * titles unchanged. `short` always omits the product; `title` is the name
 * the application and the Windows uninstall list show,
 * `AI17Z Beta 0.89`. Both come from releaseName() in
 * packages/shared/src/version.ts, which is the one implementation of the
 * grammar: a publish script that composed its own would be a third copy, and
 * the GitHub mirror script once was one, titling beta.87 `beta-v9.7` while the
 * application called it something else.
 */
import { releaseName } from '@xbam/shared';

const [version, form = 'page'] = process.argv.slice(2);
if (!version || !/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  process.stderr.write('usage: release-name.mts <version> [page|short|title]\n');
  process.exit(2);
}
if (form !== 'page' && form !== 'short' && form !== 'title') {
  process.stderr.write(`release-name.mts: the form is page, short or title, not ${form}\n`);
  process.exit(2);
}
const named = releaseName(version);
const title = form === 'short' || (form === 'page' && named.channel === 'Beta') ? named.short : named.title;
process.stdout.write(`${title}\n`);
