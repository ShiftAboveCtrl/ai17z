/**
 * Trying an agent out without anybody seeing it.
 *
 * Experimenting with a voice is the thing owners most want to do and are most
 * afraid of, because every other way of finding out what an agent sounds like
 * involves it saying something in public. This runs the real path -- the same
 * persona, the same prompt assembly, the same provider, the same validator, the
 * same voice compiler -- and stops before anything leaves the machine.
 *
 * The safety is structural rather than a flag. There is no job here and no
 * action row, and every remote call in this system is made by an action
 * belonging to a job. A dry-run flag can be got wrong -- it was once, in the
 * scenario harness, and an autonomous agent replied to a stranger. Nothing here
 * can be got wrong in that direction, because the code that reaches X is not
 * on this path at all.
 */
import type { ModelRole, PersonaVersion, PolicyConfig } from '@xbam/shared/contracts';
import { PipelineError, createLogger } from '@xbam/shared';
import { agents as agentsRepo, prompts as promptsRepo } from '@xbam/database';
import { assemblePrompt } from '@xbam/prompts';
import { generate } from '@xbam/models';
import { checkBudget } from './policyGate';
import { validateOutput } from './validator';
import { compileForJob } from './voice';

const log = createLogger('playground');

export interface PlaygroundRequest {
  agentId: string;
  /** What somebody would have said to the agent. */
  message: string;
  /** Who said it, when that matters to how the agent answers. */
  fromHandle?: string | null;
  /**
   * A persona to try instead of the active one.
   *
   * The point of the whole screen: comparing an edit against what is live
   * without saving the edit first.
   */
  persona?: Partial<PersonaVersion> | null;
  /** A single model role to use, for comparing one against another. */
  role?: ModelRole;
}

export interface PlaygroundResult {
  input: string;
  /** Exactly what the model returned, before anything of ours touched it. */
  raw: string;
  /** What would actually have been sent. */
  final: string;
  provider: string;
  model: string;
  role: string;
  latencyMs: number;
  /** What the validator and the voice compiler changed, and why. */
  applied: string[];
  /** Present when the validator refused it outright. */
  refused: string | null;
}

/**
 * Runs one message through the agent, and returns without sending anything.
 *
 * `jobId: null` throughout, which is not incidental: the voice compiler, the
 * model gateway and the validator all take a job id and all accept null, and
 * passing null is what keeps this off every path that records an intention to
 * act.
 */
export async function tryMessage(request: PlaygroundRequest): Promise<PlaygroundResult> {
  const agent = await agentsRepo.getAgent(request.agentId);
  if (!agent) throw new Error('That agent no longer exists.');

  const active = await agentsRepo.getActivePersona(agent.id);
  if (!active) throw new Error('This agent has no persona to try.');
  const policyRow = await agentsRepo.getActivePolicy(agent.id);
  if (!policyRow) throw new Error('This agent has no policy, so there is nothing to check the answer against.');
  const policy = policyRow.config as PolicyConfig;

  // The draft wins field by field, so an owner can change one line and see what
  // that line does rather than having to supply a whole persona.
  const persona: PersonaVersion = { ...active, ...(request.persona ?? {}) };

  const template = await promptsRepo.getActiveTemplate('reply.default');
  if (!template) throw new Error('The prompt template is missing.');

  const context = {
    targetRef: null,
    targetUrl: null,
    targetAuthorHandle: request.fromHandle ?? 'someone',
    conversationRef: null,
    incomingText: request.message,
    parentText: null,
    thread: [],
    conversation: null,
    meta: {},
  };

  const prompt = assemblePrompt({
    layers: template.layers,
    templateKey: template.templateKey,
    templateVersion: template.version,
    persona,
    policy,
    context: context as never,
    // No retrieval: a playground answer that depends on which memories happened
    // to score highest is not a fair comparison between two personas, which is
    // what this screen is for.
    memories: [],
    channelName: 'X',
    toolDescriptions: [],
    memoryCharBudget: policy.memory.retrieval.totalCharBudget,
    actionType: 'REPLY',
  });

  // The playground spends real money at a real provider, so it is subject to the
  // same budget as everything else. Skipping it here would make "try it a few
  // times" the one way to walk past a limit somebody set deliberately.
  const budget = await checkBudget(agent.id, policy);
  if (!budget.allow) throw PipelineError.permanent(budget.reason ?? 'budget', budget.message ?? 'Over budget.');

  const generated = await generate({
    agentId: agent.id,
    jobId: null,
    purpose: 'PLAYGROUND',
    messages: prompt.messages,
    promptLayers: prompt.layers,
    promptText: prompt.promptText,
    maxCalls: 1,
    ...(request.role ? { role: request.role } : {}),
  });

  // The same two passes a real reply goes through, in the same order.
  const compiled = await compileForJob({
    agentId: agent.id,
    jobId: null,
    draft: generated.text,
    policy,
    recipientHandle: request.fromHandle ?? null,
    // The expensive rewrite is allowed here: seeing what the voice compiler
    // actually does is most of the reason to open this screen.
    allowModelCall: true,
    maxCalls: 1,
  });

  const validated = validateOutput(compiled.text, policy, request.fromHandle ?? null, [
    persona.biography,
    persona.customInstructions,
  ].join('\n'));

  log.info('playground run', { agentId: agent.id, provider: generated.provider, model: generated.model });

  return {
    input: request.message,
    raw: generated.text,
    // The validator repairs what it can and reports what it could not, so its
    // output is the final text either way.
    final: validated.output,
    provider: generated.provider,
    model: generated.model,
    role: generated.role,
    latencyMs: generated.latencyMs,
    applied: [...compiled.applied, ...validated.violations.map((v) => v.rule)],
    refused: validated.ok
      ? null
      : validated.violations.map((v) => v.message).join(' ') || 'The validator refused this answer.',
  };
}

export interface ComparisonEntry {
  role: string;
  /** Present when this one worked. */
  result: PlaygroundResult | null;
  /** Present when it did not, in words. */
  failed: string | null;
}

/**
 * The same message through several models, side by side.
 *
 * This is the demonstration of the idea the whole product rests on: the model
 * is where the intelligence comes from, and AI17Z is what makes the answer
 * sound like the same agent whichever model wrote it. Showing the raw answer
 * beside the final one, for two providers at once, is the only way to see that
 * rather than be told it.
 *
 * Every provider is run independently and a failure is recorded rather than
 * thrown. One provider being out of credit must not blank a comparison that
 * three others answered -- that would make the feature useless exactly when it
 * is most informative.
 */
export async function compareModels(input: {
  agentId: string;
  message: string;
  fromHandle?: string | null;
  roles: ModelRole[];
}): Promise<ComparisonEntry[]> {
  const runs = await Promise.all(
    input.roles.map(async (role): Promise<ComparisonEntry> => {
      try {
        return {
          role,
          result: await tryMessage({
            agentId: input.agentId,
            message: input.message,
            fromHandle: input.fromHandle ?? null,
            role,
          }),
          failed: null,
        };
      } catch (error) {
        return { role, result: null, failed: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return runs;
}
