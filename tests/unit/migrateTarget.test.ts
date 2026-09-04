import { describe, expect, it } from 'vitest';
import { describeTarget } from '@xbam/database';

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
