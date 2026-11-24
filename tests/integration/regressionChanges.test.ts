import { expect, it } from 'vitest';
import { agents, providers, regression, query, withTransaction } from '@xbam/database';
import { PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import { requestChange } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

it('records persona and policy writes regardless of their caller', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const persona = (await agents.getActivePersona(f.agentId))!;
  await agents.savePersonaVersion(f.agentId, PersonaDraft.parse({ ...persona, tone: 'Dry' }), f.ownerId);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'PERSONA' });
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const policy = (await agents.getActivePolicy(f.agentId))!;
  await agents.savePolicyVersion(f.agentId, PolicyConfig.parse({ ...policy.config, tools: { ...policy.config.tools, allowed: ['web.search'] } }), 'Allow a tool', f.ownerId);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'POLICY' });
});

it('records owner chat persona and policy edits', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const origin = { conversationId: null, messageId: null, text: 'Change my tone' };
  await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'persona.tone', value: { tone: 'Dry' }, origin });
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'PERSONA' });
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.emoji', value: { use: 'NONE' }, origin });
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'POLICY' });
});

it('waits for an explicit persona save before offering an automatic run', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const persona = (await agents.getActivePersona(f.agentId))!;
  const draft = PersonaDraft.parse({ ...persona, tone: 'Still typing' });
  await agents.savePersonaVersion(f.agentId, draft, f.ownerId, { autosave: true });
  expect(await regression.changeNotice(f.agentId)).toBeNull();
  await agents.savePersonaVersion(f.agentId, draft, f.ownerId);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'PERSONA' });
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  await agents.savePersonaVersion(f.agentId, draft, f.ownerId);
  expect(await regression.changeNotice(f.agentId)).toBeNull();
});

it('records model writes and removals without a route hook', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  await providers.setModelConfig({ agentId: f.agentId, role: 'fallback_1', providerCredentialId: f.providerId, model: 'mock-echo', parameters: {} });
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'MODEL' });
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  await providers.deleteModelConfig(f.agentId, 'fallback_1');
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'MODEL' });
});


it('keeps a later write pending when its transaction started before the run', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let continueSave!: () => void;
  const resume = new Promise<void>(resolve => { continueSave = resolve; });
  const save = withTransaction(async tx => {
    await tx.query('SELECT 1');
    began();
    await resume;
    await regression.noteChange(f.agentId, 'PERSONA', tx);
  });
  await started;
  const run = await regression.createRun({ agentId: f.agentId, trigger: 'MANUAL' });
  continueSave();
  await save;
  await regression.acknowledgeChange(f.agentId, run.createdAt);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true });
});
