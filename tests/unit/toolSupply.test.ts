import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_SUPPLY, getToolDefinition, listToolDefinitions, suppliedFacts, toolSupply } from '@xbam/tools';

const root = resolve(__dirname, '../..');

/**
 * The defect these exist for.
 *
 * The prompt carried a block headed TOOLS AVAILABLE, listing every tool that
 * was switched on and permitted, and nothing in AI17Z could call one: there is
 * no tool-call loop, no parsing of a tool call out of an answer, no execution,
 * no result fed back. A model told it has a capability uses it -- it writes
 * "let me check" or answers as though it had checked -- and the reply goes out
 * sounding like it consulted something it never consulted.
 */
describe('the prompt no longer offers what nothing can do', () => {
  const templates = readFileSync(resolve(root, 'packages/prompts/src/defaultTemplates.ts'), 'utf8');
  // The generation step, which is where the prompt is assembled. `steps.ts`
  // is a barrel over five files now, so reading it finds only re-exports.
  const steps = readFileSync(resolve(root, 'packages/runtime/src/steps/generate.ts'), 'utf8');

  it('does not tell the model a tool is available to call', () => {
    // Only in the comments explaining why it is gone.
    expect(templates).not.toMatch(/template: `\{\{#toolsBlock\}\}TOOLS AVAILABLE/);
  });

  it('sends facts rather than a list of tool names', () => {
    expect(steps).toContain('suppliedFacts(');
    expect(steps).not.toMatch(/toolDescriptions: describeTools\(/);
  });
});

describe('what the runtime actually supplies', () => {
  it('states the date and time when the clock is on', () => {
    const facts = suppliedFacts({
      keys: ['time.now'],
      timezone: 'UTC',
      now: new Date('2026-03-04T09:30:00Z'),
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain('4 March 2026');
    // A sentence, because a model reads this and a name is not a fact.
    expect(facts[0]).toMatch(/^It is currently .+\.$/);
  });

  it('says the time in the agent working timezone rather than the server one', () => {
    const facts = suppliedFacts({
      keys: ['time.now'],
      timezone: 'Asia/Tokyo',
      now: new Date('2026-03-04T23:00:00Z'),
    });
    // 23:00 UTC is the next day in Tokyo, which is exactly the mistake an agent
    // with no clock makes when it says "yesterday".
    expect(facts[0]).toContain('5 March 2026');
  });

  it('falls open to UTC on an unusable timezone rather than losing the clock', () => {
    const facts = suppliedFacts({
      keys: ['time.now'],
      timezone: 'Not/AZone',
      now: new Date('2026-03-04T09:30:00Z'),
    });
    expect(facts[0]).toContain('4 March 2026');
  });

  it('says nothing at all when no tool contributes anything', () => {
    // An empty heading is worse than no heading.
    expect(suppliedFacts({ keys: ['http.fetch'], timezone: 'UTC' })).toEqual([]);
    expect(suppliedFacts({ keys: [], timezone: 'UTC' })).toEqual([]);
  });

  it('does not repeat what another layer already carries', () => {
    // Memories arrive in their own section. Listing them twice spends prompt on
    // saying the same thing.
    expect(suppliedFacts({ keys: ['memory.search', 'agent.diagnostics'], timezone: 'UTC' })).toEqual([]);
  });
});

describe('saying which tools have anything behind them', () => {
  it('names the one nothing calls, rather than letting it look ready', () => {
    expect(toolSupply('http.fetch').supply).toBe('NOTHING_CALLS_IT');
    expect(toolSupply('http.fetch').says).toContain('Nothing in AI17Z calls this');
  });

  it('treats an unknown tool as one nothing calls', () => {
    // The safe direction. A tool nobody has wired up must not default to
    // looking as though it works.
    expect(toolSupply('something.new').supply).toBe('NOTHING_CALLS_IT');
  });

  it('has an entry for every built-in tool', () => {
    // A tool added without a line here shows as "nothing calls it", which is
    // right, but the entry is where somebody says what it does instead.
    for (const key of ['time.now', 'memory.search', 'agent.diagnostics', 'http.fetch']) {
      expect(Object.keys(TOOL_SUPPLY)).toContain(key);
    }
  });

  it('explains each one in a sentence somebody could act on', () => {
    for (const [key, entry] of Object.entries(TOOL_SUPPLY)) {
      expect(entry.says.length, key).toBeGreaterThan(20);
      expect(entry.says.endsWith('.'), key).toBe(true);
    }
  });
});

/**
 * A tool nothing calls is not a capability, and a switch for one is a control
 * that does nothing.
 *
 * `http.fetch` was in the catalogue with a working, allowlist-gated
 * implementation and no caller anywhere: AI17Z has no tool-calling loop, and
 * looking things up is a pipeline step that drives the browser and the market
 * API itself. The screen labelled the row "nothing calls it", which is honest
 * and is still a switch, an allowlist and an editor for something that could
 * never run.
 */
describe('the catalogue offers only tools something can call', () => {
  it('does not offer http.fetch', () => {
    expect(listToolDefinitions().map((t) => t.key)).not.toContain('http.fetch');
    expect(getToolDefinition('http.fetch')).toBeNull();
  });

  it('keeps the implementation, unregistered and said so', () => {
    // Deleting it would lose the allowlist-gated fetcher a real tool loop
    // would need. What must not happen is it quietly reappearing in the list.
    const source = readFileSync(resolve(__dirname, '../../packages/tools/src/builtin/httpFetch.ts'), 'utf8');
    expect(source).toContain('Not in the catalogue, on purpose');
    const registry = readFileSync(resolve(__dirname, '../../packages/tools/src/registry.ts'), 'utf8');
    expect(registry).not.toContain('httpFetchTool as ToolDefinition');
  });

  it('still explains the key to a database that predates its removal', () => {
    // The row is gone from the catalogue; an installation upgraded from before
    // migration 0062 can still hold it, and should get the real sentence
    // rather than the vaguer fallback for an unknown key.
    expect(toolSupply('http.fetch').says).toContain('pipeline step');
  });
});
