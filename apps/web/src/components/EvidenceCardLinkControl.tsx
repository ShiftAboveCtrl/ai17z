import { Toggle } from './ui';

/** The second, separate owner choice: a check page link at the end of an evidence card. */
export function EvidenceCardLinkControl({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return <Toggle checked={checked} onChange={onChange} label="End evidence cards with a link to the full check"
    description="Adds one link to this token's check page on the AI17Z Studio you linked, only when the token was read. Off by default. Needs evidence cards on and Studio linked, and is left off if the card would no longer fit the output length policy." />;
}
