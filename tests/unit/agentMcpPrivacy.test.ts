import { expect, it } from 'vitest';
import { mcpSanitizer } from '../../packages/runtime/src/mcpPrivacy';

it('preserves public chain addresses and transaction hashes', () => {
  const evidence = `0x${'ab'.repeat(20)} 0x${'cd'.repeat(32)} So11111111111111111111111111111111111111112 ${'A'.repeat(44)}`;
  expect(mcpSanitizer().text(evidence)).toBe(evidence);
});

it('removes credentials inside free text and structured keys without hiding ordinary evidence', () => {
  const filter = mcpSanitizer(['owner-session-value']);
  filter.add('custom-provider-key');
  const safe = filter.value({
    question: 'echo owner-session-value and custom-provider-key',
    // Assembled at runtime so the release scan does not read the fixture as a real key.
    answer: ['sk', 'examplePrivateCredential1234567890'].join('-'),
    nested: [{ privateKey: 'keep-this-private', result: 'normal recorded conclusion' }],
    sealed: 'v1.abc.def.ghi',
  });
  expect(JSON.stringify(safe)).not.toMatch(/owner-session-value|custom-provider-key|sk-example|keep-this-private|v1\.abc/);
  expect(JSON.stringify(safe)).toContain('normal recorded conclusion');
});
