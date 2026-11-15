import { describe, expect, it } from 'vitest';
import { COMMANDS, helpText, parseCommand, radarText, standingText } from '@xbam/runtime';

/**
 * The two read verbs added for the phone: what the radar is watching, and
 * where an agent stands in a league or paper season.
 */
describe('radar and standing are commands', () => {
  it('are in the closed list as reads, so they are never audited', () => {
    for (const name of ['radar', 'standing']) {
      const spec = COMMANDS.find((command) => command.name === name);
      expect(spec, name).toBeDefined();
      expect(spec!.acts).toBe(false);
      expect(spec!.args).toBeNull();
      expect(helpText()).toContain(`/${name}`);
      expect(parseCommand(`/${name}`)).toEqual({ name, argument: '' });
    }
  });

  it('leaves every command that changes something exactly as it was', () => {
    const acting = COMMANDS.filter((command) => command.acts).map((command) => command.name).sort();
    expect(acting).toEqual(['approve', 'decline', 'mute', 'pause', 'resume', 'unmute', 'watch']);
  });
});

describe('radarText', () => {
  it('says so when nothing is set up', () => {
    expect(radarText([])).toMatch(/no radar sources/i);
    expect(radarText([{ agent: 'A', sources: [] }])).toMatch(/no radar sources/i);
  });

  it('counts what is watched and names the most recent find', () => {
    const text = radarText([
      {
        agent: 'Ada',
        sources: [
          { label: 'Mentions', enabled: true, status: 'HEALTHY', lastResultAt: '2026-11-14T10:00:00Z' },
          { label: 'Search <ai>', enabled: true, status: 'FAILING', lastResultAt: '2026-11-14T12:00:00Z' },
          { label: 'Old', enabled: false, status: 'DISABLED', lastResultAt: '2026-11-15T00:00:00Z' },
        ],
      },
    ]);
    expect(text).toContain('watching 2 of 3');
    expect(text).toContain('1 not answering well');
    // The disabled source is newer but is not being watched.
    expect(text).toContain('Search &lt;ai&gt;');
    expect(text).not.toContain('Old at');
    expect(text).not.toContain('<ai>');
  });

  it('says when nothing was found', () => {
    const text = radarText([
      { agent: 'Ada', sources: [{ label: 'Mentions', enabled: true, status: 'HEALTHY', lastResultAt: null }] },
    ]);
    expect(text).toContain('Nothing found yet.');
  });
});

describe('standingText', () => {
  it('says there is none in a sentence', () => {
    expect(standingText([{ agent: 'Ada', entry: null }])).toMatch(/no standing/i);
    expect(standingText([])).toMatch(/no standing/i);
  });

  it('shows the entry and its fills, skipping agents without one', () => {
    const text = standingText([
      { agent: 'Ada', entry: { alias: 'ada_1', seasonSlug: 'season-3', status: 'ACTIVE', endsAt: '2026-12-01', accepted: 4, pending: 1 } },
      { agent: 'Bo', entry: null },
    ]);
    expect(text).toContain('Ada');
    expect(text).toContain('season-3');
    expect(text).toContain('4 accepted, 1 pending');
    expect(text).not.toContain('Bo');
  });
});
