import { useResource } from '@app/lib/hooks';

interface SpamOverview {
  metrics: {
    filtered: number;
    suspect: number;
    campaigns: number;
    collapsed: number;
    spamActors: number;
    mutedActors: number;
    ownerCorrections: number;
    falsePositiveCorrections: number;
    modelCallsAvoided: number;
  } | null;
}

/**
 * What the spam defense did this week, for the owner only. The agent never
 * sees these numbers and never says what it filtered.
 */
export function SpamPanel() {
  const view = useResource<SpamOverview>('/api/spam?days=7');
  const m = view.data?.metrics;
  if (!m) return null;
  const facts = [
    `${m.filtered} filtered as spam`,
    `about ${m.modelCallsAvoided} model calls not made`,
    m.campaigns > 0 ? `${m.campaigns} campaign${m.campaigns === 1 ? '' : 's'} (${m.collapsed} repeats folded into them)` : null,
    m.spamActors > 0 ? `${m.spamActors} account${m.spamActors === 1 ? '' : 's'} sent spam` : null,
    m.mutedActors > 0 ? `${m.mutedActors} muted by you` : null,
    m.ownerCorrections > 0 ? `${m.ownerCorrections} corrected by you, ${m.falsePositiveCorrections} of them wrongly filtered` : null,
  ].filter(Boolean);
  return (
    <p className="mb-5 break-words text-sm text-bone-faint">
      <span className="text-bone-dim">Spam defense, last 7 days:</span> {facts.join(' · ')}. Filtered posts stay under
      "Filtered as spam", where you can mark any of them not spam.
    </p>
  );
}
