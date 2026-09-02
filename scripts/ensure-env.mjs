/**
 * Makes sure there is a .env with a master key in it, and says nothing when
 * there already is.
 *
 * Generating a key was a step in the documentation:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   # paste that into AI17Z_MASTER_KEY in .env
 *
 * A copy-paste step that is required for the software to work at all is a step
 * people get wrong, and the failure arrives much later and somewhere else: the
 * app starts, the database migrates, everything looks fine, and then adding a
 * provider key fails with "AI17Z_MASTER_KEY is not set". Nothing about that
 * message points back at a paste that did not happen.
 *
 * So it happens here instead, automatically, before anything that needs it.
 *
 * Two things it will not do. It never overwrites an existing .env, because that
 * file holds the key every stored credential is encrypted with and replacing it
 * makes them all unreadable. And it never writes a key into a file that already
 * has a non-empty one, for the same reason.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

const KEY = 'AI17Z_MASTER_KEY';
const freshKey = () => randomBytes(32).toString('base64');

/** The value of a key in a .env, or null when it is absent or empty. */
function valueOf(contents, key) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      return value === '' ? null : value;
    }
  }
  return null;
}

function setValue(contents, key, value) {
  const lines = contents.split(/\r?\n/);
  let written = false;
  const out = lines.map((line) => {
    // A commented-out key counts: it is the placeholder people are meant to fill.
    if (new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(line)) {
      written = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!written) out.push(`${key}=${value}`);
  return out.join('\n');
}

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error('  .env.example is missing, so .env cannot be created. This checkout looks incomplete.');
    process.exit(1);
  }
  const created = setValue(readFileSync(examplePath, 'utf8'), KEY, freshKey());
  writeFileSync(envPath, created, 'utf8');
  console.log('  Created .env with a master key generated for this installation.');
  console.log('  Back it up: losing it makes every stored provider credential unreadable.');
  process.exit(0);
}

const current = readFileSync(envPath, 'utf8');
if (valueOf(current, KEY) || valueOf(current, 'XBAM_MASTER_KEY')) {
  // Already set, under either brand. Nothing to do and nothing to say.
  process.exit(0);
}

writeFileSync(envPath, setValue(current, KEY, freshKey()), 'utf8');
console.log('  .env had no master key, so one was generated for this installation.');
console.log('  Back it up: losing it makes every stored provider credential unreadable.');
