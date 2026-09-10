import { useResource } from '@app/lib/hooks';
import { EmptyState, Spinner } from '@app/components/ui';
import { Card, Gaps, NoAccount, Panel, Warnings } from './shared';

/**
 * Tickers and addresses being posted, and nothing else.
 *
 * This screen states no price, no liquidity, no volume and no opinion about
 * whether anything is worth buying, and that is not an omission to be filled in
 * later. `docs/ENGINEERING.md` forbids inventing a contract address or a
 * financially actionable fact for a reason that is not squeamishness: somebody
 * acts on a wrong address and their money is gone.
 *
 * So every address here is shown with the posts it appeared in and the accounts
 * that posted it, and the only judgement is arithmetic -- several different
 * addresses for one ticker means at most one of them is right, and this cannot
 * say which.
 */

interface ClaimedAddress {
  value: string;
  chain: string;
  seenIn: string[];
  claimedBy: string[];
}

interface Launch {
  ticker: string;
  mentions: number;
  authors: number;
  firstSeenAt?: string;
  addresses: ClaimedAddress[];
  warnings: string[];
  gaps: string[];
}

export function LaunchView({ agentId }: { agentId: string }) {
  const view = useResource<{ ok?: boolean; launches: Launch[]; gaps: string[] }>(
    `/api/agents/${agentId}/growth/launches`,
  );
  const launches = view.data?.launches ?? [];

  return (
    <Panel
      title="What is being launched"
      lede="Only what was literally posted. No price, no liquidity, no volume, and no view on whether any of it is real."
    >
      {view.loading && <Spinner />}

      {!view.loading && view.data?.ok === false && (
        <NoAccount agentId={agentId} what="This agent is not reading anything, so it has seen no tickers." />
      )}

      {!view.loading && view.data?.ok !== false && launches.length === 0 && (
        <EmptyState
          title="No tickers doing the rounds"
          detail="A ticker appears here once more than one account has posted it. One account talking about a coin is one account talking about a coin."
        />
      )}

      <div className="space-y-3">
        {launches.map((launch) => (
          <Card
            key={launch.ticker}
            title={launch.ticker}
            score={`${launch.authors} account${launch.authors === 1 ? '' : 's'}`}
            meta={`Seen in ${launch.mentions} post${launch.mentions === 1 ? '' : 's'}.`}
          >
            {launch.addresses.length > 0 && (
              <ul className="space-y-2">
                {launch.addresses.map((address) => (
                  <li key={address.value} className="rounded-lg border border-ink-line px-3.5 py-2.5">
                    {/* Selectable and complete. A truncated address that somebody
                        copies from a screenshot is worse than no address. */}
                    <p className="break-all font-mono text-[12px] text-bone-dim">{address.value}</p>
                    <p className="mt-1 text-[11px] text-bone-faint">
                      {address.chain} · posted by {address.claimedBy.map((h) => `@${h}`).join(', ')} in{' '}
                      {address.seenIn.length} post{address.seenIn.length === 1 ? '' : 's'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Warnings items={launch.warnings} />
            <Gaps items={launch.gaps} label="What this does not tell you" />
          </Card>
        ))}
      </div>

      <Gaps items={view.data?.gaps ?? []} label="Left out" />
    </Panel>
  );
}
