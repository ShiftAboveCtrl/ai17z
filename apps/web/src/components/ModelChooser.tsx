import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Field, Spinner } from '@app/components/ui';

/**
 * Choosing a model, in one place.
 *
 * There were three: a select with a free-text escape on the agent page, and a
 * `<input list=...>` datalist in each of the two setup wizards. The agent page's
 * own comment explains why the datalist is wrong -- nothing is visible until
 * you click a control most people never find, it offers no way to see what
 * exists, and it never says whether what you typed is real -- and the two
 * wizards, which are where somebody chooses a model for the first time, were
 * the two using it.
 *
 * Getting this wrong fails every generation with a message from the provider,
 * so it is a list where a list exists and a box where one does not.
 */
export function ModelChooser({
  id,
  label,
  hint,
  models,
  value,
  onChange,
  providerName,
  placeholder,
  onFetch,
  fetching = false,
  note,
}: {
  id: string;
  label: string;
  /** Replaces the derived hint entirely, for a field that needs its own line. */
  hint?: string;
  /** What the provider offers. Empty means nobody has asked it yet, or it has none. */
  models: string[];
  value: string;
  onChange: (model: string) => void;
  /** Named in the hint, so "12 offered by" says by whom. */
  providerName?: string;
  placeholder?: string;
  /** Fetches the list from the provider. Omitted where there is nothing to ask. */
  onFetch?: () => void;
  fetching?: boolean;
  /** The result of the last fetch, in the caller's own words. */
  note?: string | null;
}) {
  const [freeText, setFreeText] = useState(models.length === 0);

  /*
    The list arriving or going away decides the control; a person's own toggle
    decides it in between.

    A list going away -- a different provider, none of whose models are known --
    has to put the box back, or the field becomes a select with nothing in it
    and no way to name anything. A list arriving is the answer to "what does
    this provider offer", and is usually the result of somebody having just
    pressed Fetch, so it puts the list back.

    Keyed on whether there is a list rather than on its length, so re-fetching
    and getting the same twelve models does not undo a deliberate toggle.
  */
  const hasList = models.length > 0;
  useEffect(() => {
    setFreeText(!hasList);
  }, [hasList]);

  /*
    A stored model the provider did not list is still the stored model.

    Without this the select renders empty whenever somebody opens the editor
    for a model named before the list was fetched, or released after it was --
    and saving from there would quietly replace a working model with nothing.
  */
  const options = value && !models.includes(value) ? [value, ...models] : models;

  const derivedHint = freeText
    ? 'Exactly as the provider names it.'
    : `${models.length} offered by ${providerName ?? 'this provider'}.`;

  return (
    <Field label={label} htmlFor={id} hint={hint ?? derivedHint}>
      {freeText ? (
        <input
          id={id}
          className="field font-mono text-[13px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? models[0] ?? 'model-id'}
        />
      ) : (
        <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a model</option>
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {onFetch && (
          <button type="button" className="btn-quiet px-0 text-xs" onClick={onFetch} disabled={fetching}>
            {fetching ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" aria-hidden />}
            Fetch the list from the provider
          </button>
        )}
        {/*
          Always available, even with a list on screen. A model released this
          morning is named before any /models endpoint mentions it, and refusing
          to accept one would make this field wrong exactly when it matters most.
        */}
        {models.length > 0 && (
          <button
            type="button"
            className="text-bone-faint underline underline-offset-2 hover:text-bone-dim"
            onClick={() => setFreeText((on) => !on)}
          >
            {freeText ? 'Choose from the list' : 'Type a model name instead'}
          </button>
        )}
        {note && <span className="text-bone-faint">{note}</span>}
      </div>
    </Field>
  );
}
