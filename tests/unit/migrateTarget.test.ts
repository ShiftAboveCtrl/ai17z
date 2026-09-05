import { describe, expect, it } from 'vitest';
import { describeTarget, explainFailure } from '@xbam/database';

/**
 * A database command has to say which database.
 *
 * A development checkout whose DATABASE_URL still pointed at a running
 * installation applied three unreleased migrations to it, and the whole output
 * was "Applied 3 migration(s)". Nothing named the target, so there was nothing
 * to notice until afterwards.
 */
describe('naming the database a command is about to write to', () => {
  it('says host, port and database', () => {
    expect(describeTarget('postgres://xbam:xbam@localhost:55460/xbam')).toBe('localhost:55460/xbam');
  });

  it('never includes the credentials, because this is printed and logged', () => {
    const described = describeTarget('postgres://someone:hunter2@db.internal:5432/live');
    expect(described).not.toContain('hunter2');
    expect(described).not.toContain('someone');
    expect(described).toBe('db.internal:5432/live');
  });

  it('fills in the default port rather than leaving it blank', () => {
    expect(describeTarget('postgres://u:p@host/db')).toBe('host:5432/db');
  });

  it('distinguishes two installations that differ only by port', () => {
    // The actual mistake: 55432 is a live installation, 55460 is disposable.
    expect(describeTarget('postgres://xbam:xbam@localhost:55432/xbam')).not.toBe(
      describeTarget('postgres://xbam:xbam@localhost:55460/xbam'),
    );
  });

  it('says so when there is nothing to describe', () => {
    expect(describeTarget('')).toBe('no DATABASE_URL set');
    expect(describeTarget('not a url')).toBe('an unreadable DATABASE_URL');
  });
});

/**
 * The migration that failed and said nothing.
 *
 * `npm run migrate` against a database that was not running exited 1 with an
 * empty stderr, under a launcher that had just printed "Migrations failed. The
 * database is unchanged; the output above says why." Above it: one blank line.
 *
 * The cause is that Node's connect tries every address a name resolves to --
 * ::1 and 127.0.0.1 for `localhost` -- and reports the result as an
 * `AggregateError` whose own `message` is empty. Both refusals are on `.errors`.
 */
describe('saying why a migration failed', () => {
  const refused = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });

  it('finds the refusals inside an AggregateError with no message of its own', () => {
    const error = new AggregateError([refused('::1:55432'), refused('127.0.0.1:55432')]);
    expect(error.message, 'the case this exists for has changed').toBe('');
    const said = explainFailure(error, 'localhost:55432/xbam');
    expect(said).not.toBe('');
    expect(said).toContain('localhost:55432/xbam');
  });

  it('turns a refused connection into something to do about it', () => {
    const said = explainFailure(new AggregateError([refused('::1:55432')]), 'localhost:55432/xbam');
    expect(said).toContain('npm run db:up');
    // The other half of the same failure: the ports disagreeing in .env.
    expect(said).toContain('POSTGRES_PORT');
  });

  it('follows a cause as well as a list', () => {
    const outer = Object.assign(new Error(''), { cause: refused('127.0.0.1:5432') });
    expect(explainFailure(outer, 'here')).toContain('npm run db:up');
  });

  it('names a host that does not resolve as that, not as a refusal', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND db.internal'), { code: 'ENOTFOUND' });
    expect(explainFailure(error, 'db.internal:5432/live')).toContain('does not resolve');
  });

  it('passes an ordinary message through unchanged', () => {
    expect(explainFailure(new Error('relation "agents" already exists'), 'x')).toBe(
      'relation "agents" already exists',
    );
  });

  it('still says something when handed a thing that is not an error at all', () => {
    expect(explainFailure('a string', 'x')).toBe('a string');
    expect(explainFailure(undefined, 'x')).toBe('undefined');
  });

  it('never repeats one message per address tried', () => {
    // Two addresses refused the same way is one thing to tell somebody.
    const said = explainFailure(new AggregateError([refused('::1:5432'), refused('::1:5432')]), 'x');
    expect(said.match(/nothing is listening/g)).toHaveLength(1);
  });
});
