import { beforeEach, describe, expect, it } from 'vitest';
import { registerWebReadCapability } from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';

/**
 * web.read_page: one public page as evidence. What is pinned here is the
 * boundary, not the web: it is a read offered to a model, it refuses any
 * address on this machine or a private network before connecting, and it
 * always says its text is somebody else's.
 */
beforeEach(() => {
  resetCapabilitiesForTest();
  registerWebReadCapability();
});

const run = async (url: string) => {
  const capability = getCapability('web.read_page')!;
  return capability.run(capability.input.parse({ url }) as never, {
    agentId: 'a',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
    signal: new AbortController().signal,
  }) as Promise<{ ok: boolean; refusal: string | null; untrusted: boolean; text: string }>;
};

describe('reading a web page', () => {
  it('is a read, offered to a model', () => {
    const c = getCapability('web.read_page')!;
    expect(c.effect).toBe('READ');
    expect(c.modelCallable).toBe(true);
  });

  it.each(['http://127.0.0.1/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/'])(
    'refuses %s before connecting, and still says its text is untrusted',
    async (url) => {
      const answer = await run(url);
      expect(answer.ok).toBe(false);
      expect(answer.text).toBe('');
      expect(answer.untrusted).toBe(true);
      expect(answer.refusal).toBeTruthy();
    },
  );

  it('refuses something that is not a web address before reading anything', () => {
    expect(() => getCapability('web.read_page')!.input.parse({ url: 'file:///etc/passwd' })).toThrow();
  });
});
