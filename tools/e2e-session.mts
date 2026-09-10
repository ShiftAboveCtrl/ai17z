/**
 * Mints a session for the owner of this installation and prints the token.
 *
 * The end-to-end suite signs in through the real form, which needs the owner's
 * password. On a fresh database that is the fixed development password and no
 * secret at all; on an installation somebody actually uses it is their own, and
 * the way to run the suite against it should not be "put your password in an
 * environment variable so a test runner can type it into a form".
 *
 * So this asks the database for a session the same way `POST /api/auth/login`
 * does once it has already checked the password, and prints the token. It reads
 * no password and can create no owner: an installation with nobody in it has
 * nothing here to mint.
 *
 *   AI17Z_E2E_TOKEN=$(npm run --silent session:e2e) npx playwright test
 */
import { users } from '@xbam/database';

const owners = await users.listUsers();
const owner = owners[0];
if (!owner) {
  console.error('This installation has no owner yet. Create one first; this cannot.');
  process.exit(1);
}

// Short-lived on purpose. This is a token for one test run, not a way to stay
// signed in, and it is printed to a terminal where it will sit in scrollback.
const session = await users.createSession(owner.id, 1, 'ai17z-e2e');
process.stdout.write(session.token);
