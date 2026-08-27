#!/usr/bin/env node
/**
 * A stand-in for the twscrape CLI.
 *
 * The adapter's job is mostly interpreting what twscrape says, including the
 * cases where it says something misleading. Those are worth testing, and
 * testing them against the real tool would need real X credentials.
 *
 * FAKE_TWSCRAPE_MODE selects which twscrape this pretends to be.
 */
const mode = process.env.FAKE_TWSCRAPE_MODE ?? 'ok';
const [command, ...rest] = process.argv.slice(2);

const log = (line) => process.stderr.write(line + '\n');

if (mode === 'no_accounts') {
  log('2026-08-27 11:12:37 | WARNING | twscrape.accounts_pool:get_for_queue_or_wait:354 - No active accounts. Stopping...');
  if (command === 'version') process.stdout.write('0.17.0\n');
  else if (command === 'accounts') process.stdout.write('');
  else process.stdout.write('Not Found. See --raw for more details.\n');
  process.exit(command === 'version' ? 0 : 1);
}

if (command === 'version') {
  process.stdout.write('0.17.0\n');
  process.exit(0);
}

if (command === 'accounts') {
  process.stdout.write('username        logged_in  active  last_used\n');
  process.stdout.write('spare_reader    True       True    2026-08-27\n');
  process.exit(0);
}

if (command === 'user_by_login') {
  if (rest[0] === 'ghost') {
    process.stdout.write('');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 1234567890, id_str: '1234567890', username: rest[0] }) + '\n');
  process.exit(0);
}

if (command === 'user_tweets_and_replies' || command === 'user_tweets') {
  // The adapter must pass a numeric id here, never a handle.
  if (!/^\d+$/.test(rest[0] ?? '')) {
    log('expected a numeric user id, got ' + rest[0]);
    process.exit(1);
  }
  log('2026-08-27 11:13:01 | INFO | twscrape.api:gql - fetching');
  const rows = [
    { id_str: '1', rawContent: 'Builders keep building.', date: '2026-08-01T10:00:00Z', url: 'https://x.com/a/status/1' },
    { id_str: '2', rawContent: 'Replying to you here.', inReplyToTweetId: '99', date: '2026-08-02T10:00:00Z' },
    { id_str: '3', rawContent: 'Quoting this.', quotedTweet: { id_str: '50' }, date: '2026-08-03T10:00:00Z' },
    { id_str: '4', rawContent: '', date: '2026-08-04T10:00:00Z' },
  ];
  for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n');
  process.exit(0);
}

log('unknown command ' + command);
process.exit(2);
