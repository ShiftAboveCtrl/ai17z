import { useState } from 'react';
import { ApiError, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Loading, Toggle } from './ui';

export interface FarcasterPostingStatus {
  enabled: boolean;
  available: boolean;
  reason: string | null;
}

/**
 * The owner's switch for casting the agent's own posts to Farcaster, and the
 * plain statement of whether a cast could go out right now.
 *
 * A switch that is on while the account cannot cast says so and says why. An
 * owner who turned this on and sees nothing on Farcaster should never have to
 * guess whether the agent chose silence or the signer lapsed.
 */
export function FarcasterPostingView({ status, busy, error, onChange }: {
  status: FarcasterPostingStatus;
  busy?: boolean;
  error?: string | null;
  onChange(value: boolean): void;
}) {
  return (
    <div className="space-y-2">
      <Toggle
        checked={status.enabled}
        disabled={busy}
        onChange={onChange}
        label="Cast the agent's own posts to Farcaster"
        description="Off by default. When on, each post the agent decides to make also becomes a cast from this account, checked against the same publication rules on the cast's own text. Replies are not copied. A Farcaster problem never holds up the post on X."
      />
      {status.enabled && status.available && (
        <p className="text-[13px] text-bone-dim">Ready: this account can cast now.</p>
      )}
      {!status.available && (
        <p role="status" className="text-[13px] text-signal-wait">
          {status.enabled ? 'Unavailable, so nothing is being cast: ' : 'Not ready to cast yet: '}
          {status.reason ?? 'This account cannot cast right now.'}
        </p>
      )}
      {error && <p role="alert" className="text-[13px] text-signal-wait">{error}</p>}
    </div>
  );
}

export function FarcasterPostingPanel({ accountId }: { accountId: string }) {
  const status = useResource<FarcasterPostingStatus>(`/api/accounts/${accountId}/farcaster/posting`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status.loading && !status.data) return <Loading label="Checking Farcaster posting" />;
  if (!status.data) return <p className="text-[13px] text-bone-dim">{status.error ?? 'Farcaster posting could not be read.'}</p>;
  const change = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/accounts/${accountId}/farcaster/posting`, { enabled });
      status.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The setting could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return <FarcasterPostingView status={status.data} busy={busy} error={error} onChange={change} />;
}
