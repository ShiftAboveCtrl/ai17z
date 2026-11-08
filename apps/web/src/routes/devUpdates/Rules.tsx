import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch } from '@app/lib/api';
import { ChoiceGroup, ChoiceOption, Field, Modal, SavedTick, Toggle } from '@app/components/ui';
import {
  DAILY_CAP_CHOICES,
  SPACING_CHOICES,
  publishingState,
  spacingWords,
  type AgentPublishing,
  type DevUpdateProject,
} from '@app/lib/devUpdates';
import { ProblemList, problemOf } from './parts';

type Patch = Partial<Pick<DevUpdateProject, 'mode' | 'enabled' | 'dailyCap' | 'minSpacingMinutes' | 'rehearse'>>;

/**
 * How a project's updates reach the account.
 *
 * Each control saves on its own and says what it does in one sentence. The two
 * that let something reach the public without another look, auto mode and
 * rehearsal off, ask first, naming the account it will appear on.
 */
export function Rules({
  project,
  handle,
  agentPublishing,
  onChanged,
}: {
  project: DevUpdateProject;
  handle: string | null;
  /** The agent's own switches, or null while they are being read. */
  agentPublishing: AgentPublishing | null;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<Patch | null>(null);
  const where = handle ? `@${handle}` : 'the account';
  // What would still hold publishing once this project's own switch is off.
  // The confirmation names it, because "publish for real" over an agent that
  // dry runs everything is a promise the dispatcher will not keep.
  const afterRehearsalOff = publishingState({ ...project, rehearse: false }, agentPublishing);
  const agentHolds = afterRehearsalOff.heldBy === 'AGENT_DRY_RUN' || afterRehearsalOff.heldBy === 'AGENT_AUTOMATION';
  const policiesLink = (
    <Link to={`/agents/${project.agentId}#policies`} className="text-bone underline decoration-bone-dim underline-offset-4 hover:decoration-bone">
      Open the agent's policies
    </Link>
  );

  const save = async (change: Patch) => {
    setConfirm(null);
    setSaving(true);
    setSaved(false);
    setProblem(null);
    try {
      await patch(`/api/dev-updates/projects/${project.id}`, change);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
      onChanged();
    } catch (error) {
      setProblem(problemOf(error, 'That change could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const spacingOptions = SPACING_CHOICES.includes(project.minSpacingMinutes as (typeof SPACING_CHOICES)[number])
    ? [...SPACING_CHOICES]
    : [...SPACING_CHOICES, project.minSpacingMinutes].sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <section className="panel relative space-y-3 p-4 sm:p-5">
        {/* In the corner rather than on a row of its own, which left an empty band above the first panel. */}
        <div className="absolute right-4 top-4 flex items-center gap-3 sm:right-5 sm:top-5" aria-live="polite">
          {saving && <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">saving</span>}
          <SavedTick visible={saved} />
        </div>
        <Field label="Who decides">
          <ChoiceGroup label="Who decides" className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['DRAFT', 'Ask me first', 'Every update waits here until you approve it.'],
                ['AUTO', 'Post on its own', 'Updates that pass every check are approved without asking, still within the limits below.'],
              ] as const
            ).map(([mode, title, line]) => (
              <ChoiceOption
                key={mode}
                selected={project.mode === mode}
                disabled={saving}
                onSelect={() => {
                  if (project.mode === mode) return;
                  if (mode === 'AUTO') setConfirm({ mode });
                  else void save({ mode });
                }}
                className={`min-h-[44px] rounded-lg border px-3.5 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone-dim disabled:opacity-40 ${
                  project.mode === mode
                    ? 'border-signal-calm/60 bg-signal-calm/[0.07]'
                    : 'border-ink-line hover:border-bone-faint'
                }`}
              >
                <span className="block text-sm text-bone">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-bone-dim">{line}</span>
              </ChoiceOption>
            ))}
          </ChoiceGroup>
        </Field>
      </section>

      <section className="panel divide-y divide-ink-line px-3 sm:px-4">
        <div className="py-2">
          <Toggle
            checked={project.rehearse}
            disabled={saving}
            label="Rehearse instead of posting"
            description={
              project.rehearse || !agentHolds
                ? `Approved updates go through every check and stop before ${where}. Nothing is published while this is on.`
                : `Off for this project, but still held by the agent: ${afterRehearsalOff.sentence}`
            }
            onChange={(value) => (value ? void save({ rehearse: true }) : setConfirm({ rehearse: false }))}
          />
        </div>
        <div className="py-2">
          <Toggle
            checked={!project.enabled}
            disabled={saving}
            label="Pause this project"
            description="Nothing new is handed to the agent until you resume. Updates still arrive and wait for you."
            onChange={(paused) => void save({ enabled: !paused })}
          />
        </div>
      </section>

      <section className="panel grid gap-6 p-4 sm:grid-cols-2 sm:p-5">
        <Field label="Daily ceiling" hint="At most this many updates are handed to the agent in any 24 hours.">
          <select
            className="field"
            value={project.dailyCap}
            disabled={saving}
            onChange={(e) => void save({ dailyCap: Number(e.target.value) })}
          >
            {DAILY_CAP_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 a day' : `${n} a day`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Spacing" hint="Updates go out at least this far apart, so a busy day does not land all at once.">
          <select
            className="field"
            value={project.minSpacingMinutes}
            disabled={saving}
            onChange={(e) => void save({ minSpacingMinutes: Number(e.target.value) })}
          >
            {spacingOptions.map((m) => (
              <option key={m} value={m}>
                {spacingWords(m)} apart
              </option>
            ))}
          </select>
        </Field>
      </section>

      <ProblemList lines={problem} />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.mode === 'AUTO' ? 'Let updates post without asking?' : agentHolds ? 'Stop rehearsing this project?' : 'Publish for real?'}
      >
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-bone-dim">
            {confirm?.mode === 'AUTO'
              ? `Updates that pass every safety check will be approved without you, and ${
                  publishingState(project, agentPublishing).heldBy === null ? `posted on ${where}` : 'rehearsed or held as they are now'
                } within the ceiling and spacing. Anything the agent's own rules flag still waits for you.`
              : agentHolds
                ? `This project will stop rehearsing, but nothing reaches ${where} yet. ${afterRehearsalOff.sentence}`
                : agentPublishing === null
                  ? `This project will stop rehearsing. The agent's own settings have not been read yet, so whether ${where} sees the posts depends on them too.`
                  : `Approved updates will be published on ${where}, where anyone can see them. ${
                      project.mode === 'AUTO' ? 'This project posts on its own, so that includes updates you have not read.' : 'Only updates you approve are posted.'
                    }`}
          </p>
          {confirm?.mode !== 'AUTO' && agentHolds && <p className="text-sm">{policiesLink}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => setConfirm(null)}>
              Not yet
            </button>
            <button type="button" className="btn-primary" onClick={() => confirm && void save(confirm)}>
              {confirm?.mode === 'AUTO' ? 'Post on its own' : agentHolds ? 'Turn project rehearsal off' : 'Publish for real'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
