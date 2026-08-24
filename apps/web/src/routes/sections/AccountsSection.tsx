import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AccountRow, AgentAccountRow } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner, StatusDot } from '@app/components/ui';
import { SessionPanel } from '@app/components/SessionPanel';
import { IndexedRow, Section } from './Section';

export function AccountsSection({
  index,
  agentId,
  accounts,
  onChanged,
}: {
  index: number;
  agentId: string;
  accounts: AgentAccountRow[];
  onChanged: () => void;
}) {
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<'mock' | 'x'>('mock');
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);

  const all = useResource<{ items: AccountRow[] }>('/api/accounts');

  const attach = async () => {
    setConnecting(true);
    setError(null);
    try {
      const existing = all.data?.items.find(
        (a) => a.channel === channel && a.handle.toLowerCase() === handle.trim().toLowerCase(),
      );
      const account =
        existing ?? (await post<{ id: string }>('/api/accounts', { channel, handle: handle.trim(), displayName: handle.trim() }));
      await post(`/api/agents/${agentId}/accounts`, {
        accountId: account.id,
        triggerEventTypes: ['MENTION'],
        actionType: 'REPLY',
      });
      setAdding(false);
      setHandle('');
      all.reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The account could not be connected.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Section
      id="accounts"
      index={index}
      eyebrow="Accounts"
      heading="Where it speaks."
      lede="Accounts are separate from agents, so an account can move between agents and one agent can drive several."
    >
      {accounts.length === 0 ? (
        <EmptyState
          title="No accounts connected."
          detail="Attach a mock account to exercise the pipeline locally, or an X account to act for real."
          action={
            <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
              Connect an account
            </button>
          }
        />
      ) : (
        <div className="border-b border-ink-line">
          {accounts.map((account, i) => (
            <IndexedRow
              key={account.accountId}
              index={i + 1}
              label={account.channel}
              title={`@${account.handle}`}
              meta={`Replies to ${account.triggerEventTypes.join(', ').toLowerCase()}`}
              status={<StatusDot state={toneFor(account.status)} label={humanStatus(account.status)} />}
              onClick={() => setOpenAccountId(account.accountId)}
            />
          ))}
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
          Connect another account
        </button>
        <Link to="/settings" className="btn-quiet">
          Manage all accounts
        </Link>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Connect an account">
        <div className="space-y-5">
          <Field label="Channel">
            <div className="grid grid-cols-2 gap-2">
              {(['mock', 'x'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setChannel(option)}
                  className={`rounded-lg border px-3.5 py-3 text-sm transition-colors ${channel === option ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                >
                  {option === 'mock' ? 'Mock (local)' : 'X'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Handle" htmlFor="newHandle" hint={channel === 'x' ? 'The X username, without the @.' : 'Any label.'}>
            <input id="newHandle" className="field" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={channel === 'x' ? 'your_handle' : 'local'} />
          </Field>
          {error && <p className="text-sm text-signal-fail">{error}</p>}
          <button type="button" className="btn-primary w-full" onClick={() => void attach()} disabled={connecting || !handle.trim()}>
            {connecting && <Spinner />}
            Connect
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(openAccountId)} onClose={() => setOpenAccountId(null)} title="Session" wide>
        {openAccountId && <SessionPanel accountId={openAccountId} onChanged={onChanged} />}
      </Modal>
    </Section>
  );
}
