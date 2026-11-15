import { Toggle } from './ui';

export function EvidenceFollowUpControl({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return <Toggle checked={checked} onChange={onChange} label="Reply in the thread when a confirmed watch on an evidence card crosses"
    description="Only for a risk watch you confirmed yourself on a card this agent published. The reply states what was read before, at the card and now, each with its source and time, and nothing about what to do. Off by default. Needs evidence cards on and the Studio risk bridge enabled, at most three a day, and nothing is sent if Studio cannot be reached." />;
}
