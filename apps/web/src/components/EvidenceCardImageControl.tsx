import { Toggle } from './ui';

/** Advanced policies only: a picture of the card is a separate choice from the card and from its link. */
export function EvidenceCardImageControl({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return <Toggle checked={checked} onChange={onChange} label="Attach a picture of the evidence card"
    description="Asks the AI17Z Studio you linked to draw the card from its readings and attaches it to the reply. The picture carries the read times and the line that this is not a verdict. Off by default. Needs evidence cards on and Studio linked. If Studio cannot be reached in time, the reply is the text card unchanged." />;
}
