import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providers as providersRepo } from '@xbam/database';
import { X_SEARCH_SOURCE, canSearchServerSide, searchWithProvider } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

interface ReplyOptions {
  text?: string;
  citations?: string[];
  xSearch?: number;
  webSearch?: number;
  status?: number;
  errorMessage?: string;
}

/** The last request body xAI was sent, so a test can assert on the shape. */
let lastBody: Record<string, unknown> | null = null;
const realFetch = globalThis.fetch;

function stubXai(options: ReplyOptions = {}) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    lastBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (options.status && options.status >= 400) {
      return new Response(JSON.stringify({ error: { message: 'upstream said no' } }), {
        status: options.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const usage: Record<string, number> = {};
    if (options.xSearch) usage.SERVER_SIDE_TOOL_X_SEARCH = options.xSearch;
    if (options.webSearch) usage.SERVER_SIDE_TOOL_WEB_SEARCH = options.webSearch;

    return new Response(
      JSON.stringify({
        id: 'resp_test',
        citations: options.citations ?? [],
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: options.text ?? 'An answer.', annotations: [] }],
          },
        ],
        server_side_tool_usage: usage,
        ...(options.errorMessage ? { error: { message: options.errorMessage } } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

async function anXaiCredential(): Promise<string> {
  const fixture = await createFixture();
  const credential = await providersRepo.createProvider({
    ownerId: fixture.ownerId,
    provider: 'xai',
    label: `xAI ${uniqueSuffix()}`,
    apiKey: `xai-key-${uniqueSuffix()}`,
    availableModels: ['grok-4'],
    defaultModel: 'grok-4',
  });
  return credential.id;
}

beforeEach(() => {
  lastBody = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('which providers can do this at all', () => {
  it('says yes for xAI', async () => {
    expect(await canSearchServerSide(await anXaiCredential())).toBe(true);
  });

  it('says no for a provider that cannot, rather than degrading', async () => {
    // The alternative -- asking an ordinary model to "search X" -- gets a
    // confident answer and no search. There is no useful fallback here.
    const fixture = await createFixture();
    const openai = await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-test',
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });
    expect(await canSearchServerSide(openai.id)).toBe(false);
  });

  it('says no for a credential that is gone', async () => {
    expect(await canSearchServerSide('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('a search that ran', () => {
  it('returns findings attributed to X search', async () => {
    stubXai({
      text: 'People reported it on Tuesday.',
      citations: ['https://x.com/a/status/1'],
      xSearch: 2,
    });

    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'what are people saying?',
      tools: { xSearch: {} },
    });

    expect(result.usage.xSearch).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.source).toBe(X_SEARCH_SOURCE);
    expect(result.findings[0]!.url).toBe('https://x.com/a/status/1');
    expect(result.failed).toEqual([]);
    expect(result.note).toContain('2 X searches');
  });

  it('sends the question as the input and lets the model choose the query', async () => {
    stubXai({ xSearch: 1, citations: ['https://x.com/a/status/1'] });
    await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'what is this about?',
      tools: { xSearch: { allowHandles: ['ai17zos'] } },
    });

    expect(lastBody).toMatchObject({
      model: 'grok-4',
      input: [{ role: 'user', content: 'what is this about?' }],
      tools: [{ type: 'x_search', allowed_x_handles: ['ai17zos'] }],
    });
    // There is no query parameter. The model derives what to search for, and
    // sending one would be inventing a field the API does not have.
    expect(JSON.stringify(lastBody)).not.toContain('"query"');
  });

  it('never puts the API key anywhere but the header', async () => {
    stubXai({ xSearch: 1, citations: ['https://x.com/a/status/1'] });
    const credentialId = await anXaiCredential();
    await searchWithProvider({ credentialId, model: 'grok-4', question: 'q', tools: { xSearch: {} } });
    expect(JSON.stringify(lastBody)).not.toMatch(/xai-key-/);
  });
});

/**
 * The property the whole feature rests on.
 *
 * A model asked to search X will write "posts on X suggest..." whether or not
 * it searched. Its prose is not evidence that a search happened; the provider's
 * own billing counter is.
 */
describe('an answer that only sounds like research', () => {
  it('produces no findings when nothing was actually searched', async () => {
    stubXai({
      // Exactly what an unrun search looks like: fluent, plausible, sourceless.
      text: 'Posts on X suggest the launch went well and was widely praised.',
      xSearch: 0,
      webSearch: 0,
    });

    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'how did the launch go?',
      tools: { xSearch: {} },
    });

    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual({ xSearch: 0, webSearch: 0 });
  });

  it('records it as a gap, so the model is told it could not check', async () => {
    stubXai({ text: 'Posts on X suggest it went well.', xSearch: 0 });
    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'how did it go?',
      tools: { xSearch: {} },
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/without running a search/i);
  });

  it('does not let the confident text leak through in any field', async () => {
    const invented = 'Posts on X suggest the launch went well and was widely praised.';
    stubXai({ text: invented, xSearch: 0 });
    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'how did it go?',
      tools: { xSearch: {} },
    });
    expect(JSON.stringify(result)).not.toContain('widely praised');
  });
});

describe('when it could not run', () => {
  it('reports a provider that cannot search, rather than answering anyway', async () => {
    const fixture = await createFixture();
    const openai = await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-test',
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });

    const result = await searchWithProvider({
      credentialId: openai.id,
      model: 'gpt-4o',
      question: 'q',
      tools: { xSearch: {} },
    });

    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/cannot search on its own side/i);
  });

  it('reports an upstream failure as a gap', async () => {
    stubXai({ status: 500 });
    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'q',
      tools: { xSearch: {} },
    });
    expect(result.findings).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it('refuses to call with no tools selected', async () => {
    // A call with no tools is an ordinary generation wearing this function's
    // name, and would report "nothing found" as though a search had run.
    stubXai({ xSearch: 1 });
    const result = await searchWithProvider({
      credentialId: await anXaiCredential(),
      model: 'grok-4',
      question: 'q',
      tools: {},
    });
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/no server-side search tools/i);
  });

  it('says a missing credential is missing', async () => {
    const result = await searchWithProvider({
      credentialId: '00000000-0000-4000-8000-000000000000',
      model: 'grok-4',
      question: 'q',
      tools: { xSearch: {} },
    });
    expect(result.failed[0]!.reason).toMatch(/no longer exists/i);
  });
});
