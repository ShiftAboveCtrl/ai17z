import { expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { FarcasterPostingView } from '../../apps/web/src/components/FarcasterPostingPanel';
import { metersItsOwnReads, spendsReadBudget } from '../../packages/runtime/src/capacity';
import { FARCASTER_CAST_BYTES, mirrorOf, publicationScope } from '../../packages/runtime/src/crossPost';

const text = (node: ReturnType<ReturnType<typeof create>['toJSON']>) => JSON.stringify(node);

it('shows posting as off by default and returns the explicit new choice', () => {
  let value = false;
  const view = (enabled: boolean) => <FarcasterPostingView status={{ enabled, available: true, reason: null }} onChange={(v) => { value = v; }} />;
  const render = create(view(false));
  const control = render.root.findByProps({ role: 'switch' });
  expect(control.props['aria-checked']).toBe(false);
  expect(text(render.toJSON())).toContain('Off by default');
  act(() => control.props.onClick());
  expect(value).toBe(true);
});

it('says an opted-in account that cannot cast is unavailable, and why, instead of looking ready', () => {
  const render = create(<FarcasterPostingView status={{ enabled: true, available: false, reason: 'No authorized Farcaster app signer is linked.' }} onChange={() => undefined} />);
  const json = text(render.toJSON());
  expect(json).toContain('Unavailable, so nothing is being cast');
  expect(json).toContain('No authorized Farcaster app signer is linked.');
  expect(json).not.toContain('Ready: this account can cast now.');
});

it('says a ready account is ready', () => {
  const render = create(<FarcasterPostingView status={{ enabled: true, available: true, reason: null }} onChange={() => undefined} />);
  expect(text(render.toJSON())).toContain('Ready: this account can cast now.');
});

it('spends Farcaster reads from the one budget without charging them a second time', () => {
  expect(spendsReadBudget('farcaster')).toBe(true);
  expect(metersItsOwnReads('farcaster')).toBe(true);
  // X and Bluesky are charged by their callers, as before.
  expect(metersItsOwnReads('x')).toBe(false);
  expect(metersItsOwnReads('bluesky')).toBe(false);
  expect(spendsReadBudget('mock')).toBe(false);
});

it('reads the copy marker only from a well-formed payload and falls back to the job account otherwise', () => {
  expect(mirrorOf(null)).toBeNull();
  expect(mirrorOf({ mirrorOf: 'x' })).toBeNull();
  expect(mirrorOf({ mirrorOf: { accountId: 7 } })).toBeNull();
  expect(publicationScope({}, 'job-account')).toEqual({ accountId: 'job-account', postingAccountId: 'job-account' });
  expect(publicationScope({ mirrorOf: { accountId: 'origin', jobId: null } }, 'cast-account'))
    .toEqual({ accountId: 'origin', postingAccountId: 'cast-account' });
  expect(FARCASTER_CAST_BYTES).toBe(320);
});
