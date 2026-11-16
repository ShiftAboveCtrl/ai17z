import { Toggle } from './ui';

/** Advanced policies only: a holder map is a separate choice from the card, its link and its picture. */
export function HolderMapControl({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return <Toggle checked={checked} onChange={onChange} label="Answer a holder map request on a Solana token check"
    description="When somebody asks for a holder map under a token check, reads the largest holder accounts and which of them were first funded from the same address, and replies with a picture drawn by the AI17Z Studio you linked plus a text version. It says what was read, when and from where, and that it is a reading, not proof of one owner. Reads the chain only, never X. Off by default. Needs evidence cards on. If Studio cannot be reached in time, the reply carries the text version." />;
}
