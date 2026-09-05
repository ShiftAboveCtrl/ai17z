import { describe, expect, it } from 'vitest';
import { buildTools, collectCitations, collectText, readUsage, stripInlineCitations } from '@xbam/models';
import { describeUsage, findingsFrom } from '@xbam/runtime';

/**
 * The request shapes, which are not symmetric.
 *
 * `x_search` takes its handle filters at the top level of the tool object;
 * `web_search` nests its domain filters under `filters`. Assuming they matched
 * would produce a request xAI accepts and quietly ignores the filters of --
 * which looks exactly like a working feature until somebody checks what was
 * searched.
 */
describe('building the tools array', () => {
  it('puts handles at the top level for x_search', () => {
    expect(buildTools({ xSearch: { allowHandles: ['ai17zos'] } })).toEqual([
      { type: 'x_search', allowed_x_handles: ['ai17zos'] },
    ]);
  });

  it('nests domains under filters for web_search', () => {
    expect(buildTools({ webSearch: { allowDomains: ['x.ai'] } })).toEqual([
      { type: 'web_search', filters: { allowed_domains: ['x.ai'] } },
    ]);
  });

  it('never sends an allow list and an exclude list together', () => {
    // xAI answers 400 to a request carrying both, for either tool.
    const [x] = buildTools({ xSearch: { allowHandles: ['a'], excludeHandles: ['b'] } });
    expect(x).toHaveProperty('allowed_x_handles');
    expect(x).not.toHaveProperty('excluded_x_handles');

    const [web] = buildTools({ webSearch: { allowDomains: ['a.test'], excludeDomains: ['b.test'] } });
    expect((web as { filters: Record<string, unknown> }).filters).toHaveProperty('allowed_domains');
    expect((web as { filters: Record<string, unknown> }).filters).not.toHaveProperty('excluded_domains');
  });

  it('uses the exclude list when there is no allow list', () => {
    expect(buildTools({ xSearch: { excludeHandles: ['spam'] } })[0]).toHaveProperty('excluded_x_handles', ['spam']);
  });

  it('respects the documented limits', () => {
    const handles = Array.from({ length: 30 }, (_, i) => `h${i}`);
    const domains = Array.from({ length: 9 }, (_, i) => `d${i}.test`);
    expect((buildTools({ xSearch: { allowHandles: handles } })[0] as { allowed_x_handles: string[] }).allowed_x_handles)
      .toHaveLength(20);
    const web = buildTools({ webSearch: { allowDomains: domains } })[0] as { filters: { allowed_domains: string[] } };
    expect(web.filters.allowed_domains).toHaveLength(5);
  });

  it('leaves the expensive options off unless they were asked for', () => {
    // Image and video understanding are billed extra and most questions are
    // about words.
    const [tool] = buildTools({ xSearch: {} });
    expect(tool).not.toHaveProperty('enable_image_understanding');
    expect(tool).not.toHaveProperty('enable_video_understanding');
    expect(buildTools({ xSearch: { images: true } })[0]).toHaveProperty('enable_image_understanding', true);
  });

  it('sends no filters block when nothing was filtered', () => {
    expect(buildTools({ webSearch: {} })).toEqual([{ type: 'web_search' }]);
  });
});

describe('reading the answer', () => {
  const reply = {
    id: 'resp_1',
    citations: ['https://x.com/someone/status/1', 'https://www.example.test/page'],
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'It shipped on Tuesday [[1]](https://x.com/someone/status/1) and was confirmed [[2]](https://www.example.test/page).',
            annotations: [
              { type: 'url_citation', url: 'https://x.com/someone/status/1', title: '1' },
              { type: 'url_citation', url: 'https://www.example.test/page', title: '2' },
            ],
          },
        ],
      },
    ],
    server_side_tool_usage: { SERVER_SIDE_TOOL_X_SEARCH: 2, SERVER_SIDE_TOOL_WEB_SEARCH: 1 },
  };

  it('takes the citation markers out of the prose', () => {
    // Left in, they reach the reply and get posted to X, where a footnote
    // marker means nothing to anybody.
    const text = collectText(reply);
    expect(text).not.toMatch(/\[\[\d+\]\]/);
    expect(text).not.toContain('https://');
    expect(text).toBe('It shipped on Tuesday and was confirmed.');
  });

  it('tidies the space the markers leave behind', () => {
    expect(stripInlineCitations('A claim [[1]](https://a.test) , and another .')).toBe('A claim, and another.');
  });

  it('collects sources from both places, without duplicating them', () => {
    const citations = collectCitations(reply);
    expect(citations.map((c) => c.url)).toEqual([
      'https://x.com/someone/status/1',
      'https://www.example.test/page',
    ]);
    expect(citations[1]!.domain).toBe('example.test');
  });

  it('reads the usage counters by their exact names', () => {
    expect(readUsage(reply)).toEqual({ xSearch: 2, webSearch: 1 });
  });

  it('reads a missing usage block as nothing having run', () => {
    // Fails closed. A renamed key upstream must read as "no search", never as
    // "a search we cannot count".
    expect(readUsage({})).toEqual({ xSearch: 0, webSearch: 0 });
    expect(readUsage({ server_side_tool_usage: { SOMETHING_ELSE: 4 } })).toEqual({ xSearch: 0, webSearch: 0 });
  });
});

/**
 * The promise the whole feature rests on: an agent never says it searched X
 * unless a search ran. A model will write "posts on X suggest..." either way,
 * so its prose is never the evidence.
 */
describe('turning a search into evidence', () => {
  const result = {
    text: 'Several people reported it on Tuesday.',
    citations: [
      { url: 'https://x.com/a/status/1', domain: 'x.com' },
      { url: 'https://x.com/b/status/2', domain: 'x.com' },
    ],
    usage: { xSearch: 1, webSearch: 0 },
    requestId: 'r1',
    promptTokens: 10,
    completionTokens: 20,
    raw: {},
  };

  it('keeps the source name and the moment it was read', () => {
    const findings = findingsFrom(result, 'what happened?', 'X search (xAI)', '2026-09-05T00:00:00.000Z');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      source: 'X search (xAI)',
      url: 'https://x.com/a/status/1',
      retrievedAt: '2026-09-05T00:00:00.000Z',
    });
  });

  it('titles a finding by its host, never by the citation number', () => {
    // xAI's annotation "title" is "1", "2" -- the footnote marker. Using it
    // would label every source with a digit.
    const findings = findingsFrom(result, 'q', 'X search (xAI)');
    expect(findings.map((f) => f.title)).toEqual(['x.com', 'x.com']);
  });

  it('says so when an answer arrived with no sources', () => {
    const uncited = findingsFrom({ ...result, citations: [] }, 'q', 'X search (xAI)');
    expect(uncited).toHaveLength(1);
    expect(uncited[0]!.source).toContain('uncited');
    expect(uncited[0]!.url).toBeNull();
  });

  it('produces nothing at all from an empty answer', () => {
    expect(findingsFrom({ ...result, text: '   ' }, 'q', 'X search (xAI)')).toEqual([]);
  });

  it('does not split the answer up to fake per-source attribution', () => {
    // The provider does not say which sentence came from which citation.
    // Giving each source a different slice would be inventing attribution.
    const findings = findingsFrom(result, 'q', 'X search (xAI)');
    expect(new Set(findings.map((f) => f.summary)).size).toBe(1);
  });

  it('caps how many sources reach a prompt', () => {
    const many = {
      ...result,
      citations: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/s/${i}`, domain: 'x.com' })),
    };
    expect(findingsFrom(many, 'q', 'X search (xAI)').length).toBeLessThanOrEqual(6);
  });
});

describe('what the trace says', () => {
  it('counts the searches rather than asserting one happened', () => {
    expect(describeUsage({ xSearch: 2, webSearch: 0 })).toBe("2 X searches ran on the provider's side.");
    expect(describeUsage({ xSearch: 1, webSearch: 1 })).toBe(
      "1 X search and 1 web search ran on the provider's side.",
    );
  });

  it('says plainly when nothing ran', () => {
    expect(describeUsage({ xSearch: 0, webSearch: 0 })).toBe('No search ran.');
  });
});
