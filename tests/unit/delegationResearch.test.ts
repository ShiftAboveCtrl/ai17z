import { afterEach, expect, it, vi } from 'vitest';
import { xAdapter } from '../../packages/channels/src/x';
import * as page from '../../packages/channels/src/x/page';
import * as web from '../../packages/channels/src/x/websearch';
import type { ChannelContext } from '@xbam/channels';

vi.mock('../../packages/channels/src/x/websearch', () => ({ webSearch: vi.fn(), readPage: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('closes only the leased research page when a pending search is aborted', async () => {
  const controller = new AbortController();
  let rejectSearch: ((error: Error) => void) | undefined;
  const close = vi.fn(async () => { rejectSearch!(new Error('Research page closed.')); });
  const leasedPage = { close };
  vi.spyOn(page, 'withSession').mockImplementation(async (_ctx, _role, fn) => fn({ page: leasedPage } as never));
  vi.mocked(web.webSearch).mockImplementation(() => new Promise((_resolve, reject) => { rejectSearch = reject; }));
  const pending = xAdapter.lookUp!({} as ChannelContext, { query: 'today', kind: 'search', signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow(/closed|abort/i);
  controller.abort();
  expect(close).toHaveBeenCalledOnce();
  await rejected;
});
