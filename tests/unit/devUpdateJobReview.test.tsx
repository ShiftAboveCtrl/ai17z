import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const parts = ['The first published section.', 'The second section explains recovery.', 'The final section names the verified result.'];
vi.mock('@app/lib/hooks', () => ({
  usePolling: () => {},
  useResource: () => ({ data: {
    job: { id: 'job', agentId: 'agent', status: 'WAITING_FOR_APPROVAL', validatedOutput: 'The first published section.', resolvedContext: null, createdAt: new Date().toISOString() },
    event: null, trace: [], modelCalls: [], retrievals: [], actions: [], approval: null, attempts: [], diagnostics: [],
    threadParts: ['The first published section.', 'The second section explains recovery.', 'The final section names the verified result.'],
  }, reload: () => {} }),
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ jobId: 'job' }), Link: ({ children }: { children: ReactNode }) => h('a', null, children) }));
vi.mock('@app/components/ReplyInspector', () => ({ ReplyInspector: () => null }));
vi.mock('@app/components/ConversationView', () => ({ ConversationView: () => null }));
vi.mock('@app/components/motion', () => ({ FadeIn: ({ children }: { children: ReactNode }) => children }));
import { JobPage } from '../../apps/web/src/routes/JobPage';

it('shows every thread part beside the ordinary owner approval controls', () => {
  const html = renderToStaticMarkup(h(JobPage));
  for (const part of parts) expect(html).toContain(part);
  expect(html).toContain('Part 3 of 3');
  expect(html).toContain('Approve');
  expect(html).not.toContain('<textarea');
});
