import { Toggle } from './ui';

/** One owner setting, shared by Easy Mode and the full policy editor. */
export function EvidenceCardControl({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return <Toggle checked={checked} onChange={onChange} label="Reply with token evidence cards"
    description="Answer direct check requests with sourced token readings, without a verdict. Off by default. The complete card must fit the output length policy." />;
}
