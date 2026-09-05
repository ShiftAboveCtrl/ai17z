/**
 * Resets the owner password, from this machine.
 *
 * AI17Z has no servers, no email and no account with anybody, so the usual
 * "forgot password, check your inbox" does not exist and should not be
 * invented: a local-first application that emails a reset link has quietly
 * become a hosted one.
 *
 * What replaces it is this. Recovery requires access to the machine AI17Z runs
 * on, which is the same thing that already grants access to the database, the
 * browser profiles and the environment file. Anybody who can run this could
 * already read everything it protects, so it adds no exposure -- and there is
 * deliberately **no HTTP route** that does the same thing, because that would.
 *
 * What it touches:
 *
 *   users.password_hash   replaced
 *   sessions              all of this owner's ended
 *
 * What it does not touch, because forgetting a password is not a reason to lose
 * any of it: the master key, sealed provider credentials, connected accounts,
 * browser sessions, agents, memories, relationships, knowledge.
 *
 *   npm run owner:password
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadEnv } from '@xbam/shared';
import { closePool, ops, users } from '@xbam/database';

loadEnv();

/** The rule the bootstrap form applies, so the two cannot disagree. */
const MINIMUM_LENGTH = 8;

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    // Echo nothing. A password typed into a terminal in front of somebody, or
    // into a session being recorded, should not be left on the screen.
    const asAny = rl as unknown as { _writeToOutput?: (text: string) => void; output?: NodeJS.WritableStream };
    let first = true;
    asAny._writeToOutput = (text: string) => {
      if (first) {
        asAny.output?.write(question);
        first = false;
      }
      // Swallow everything else, including the characters being typed.
      if (text.includes('\n')) asAny.output?.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const everybody = await users.listUsers();
  if (everybody.length === 0) fail('This installation has no owner yet. Open AI17Z and create one.');

  console.log('');
  console.log('  Reset the AI17Z owner password');
  console.log('  ------------------------------');
  console.log('');
  console.log('  This changes the password and signs out every open session.');
  console.log('  It does not touch your agents, memories, knowledge, connected');
  console.log('  accounts, saved browser sessions or provider credentials.');
  console.log('');

  let owner = everybody[0]!;
  if (everybody.length > 1) {
    // More than one is not the shape AI17Z expects, but guessing which to
    // change would be worse than asking.
    console.log('  This installation has more than one account:');
    everybody.forEach((user, index) => console.log(`    ${index + 1}. ${user.email}`));
    const choice = Number(await ask('\n  Which one? '));
    const picked = everybody[choice - 1];
    if (!picked) fail('That was not one of the choices. Nothing was changed.');
    owner = picked;
  }

  console.log(`  Account: ${owner.email}`);
  console.log('');

  const confirmed = (await ask('  Type RESET to continue: ')).trim();
  if (confirmed !== 'RESET') fail('Nothing was changed.');

  const password = await ask('  New password: ', true);
  if (password.length < MINIMUM_LENGTH) {
    fail(`A password needs at least ${MINIMUM_LENGTH} characters. Nothing was changed.`);
  }

  const again = await ask('  New password again: ', true);
  if (password !== again) fail('Those did not match. Nothing was changed.');

  const { sessionsEnded } = await users.resetPassword(owner.id, password);

  // Recorded, because a password change is a security event and the audit trail
  // is where somebody looks when they are asking whether it was them.
  await ops.audit({
    actorUserId: owner.id,
    action: 'owner.password.reset',
    entityType: 'user',
    entityId: owner.id,
    // Never the password, never the hash. What happened, not what it was.
    data: { via: 'host-local cli', sessionsEnded },
  });

  console.log('');
  console.log(`  Password changed for ${owner.email}.`);
  console.log(
    `  ${sessionsEnded === 1 ? '1 session was' : `${sessionsEnded} sessions were`} signed out, including any still open in a browser.`,
  );
  console.log('');
  console.log('  Sign in again with the new password.');
  console.log('');
}

try {
  await main();
} finally {
  await closePool();
}
