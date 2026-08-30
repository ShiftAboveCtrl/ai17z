import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CharacterAnswers, EasySetup, PersonaDraft } from '@xbam/shared/contracts';
import { BadRequestError, ForbiddenError, NotFoundError, errorMessage } from '@xbam/shared';
import { agents as agentsRepo, ops, personaSources, type UserRow } from '@xbam/database';
import { generate } from '@xbam/models';
import {
  answersToCharacter,
  answersToProhibited,
  characterTemplate,
  describePrompt,
  parseCharacterJson,
  parseFilledTemplate,
  scoreCharacter,
  toPersona,
} from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Three ways to build a character, all landing in the same place.
 *
 * Describe it in a sentence and let the agent's own model do the work; hand a
 * template to another assistant and bring the answer back; or point it at a
 * public account and learn from what that account actually posts.
 *
 * They differ only in where the answers come from. Every route returns the same
 * `CharacterAnswers` with a completeness score, nothing is written until
 * somebody has seen it, and `apply` is the one place that saves.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

export async function characterRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The brief somebody hands to another assistant.
   *
   * Served as Markdown rather than a PDF: it survives being pasted into a chat
   * window, which is what people actually do with it, and every assistant reads
   * it. Browsers save it with the filename in the header, so "download the
   * template, attach it to ChatGPT" works exactly as expected.
   */
  app.get('/api/character-template', async (_request, reply) => {
    reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', 'attachment; filename="ai17z-character-brief.md"')
      .send(characterTemplate());
  });

  /** The questions themselves, for a UI that wants to render them. */
  app.get(
    '/api/character-questions',
    handler(async (request) => {
      await requireUser(request);
      const { CHARACTER_QUESTIONS } = await import('@xbam/shared/contracts');
      return { questions: CHARACTER_QUESTIONS };
    }),
  );

  /**
   * Describe the character in your own words; the agent's model fills it in.
   *
   * Uses the model already configured on the agent, so nobody is asked for a
   * second key, and the call is recorded like any other with purpose
   * `CHARACTER` — a model call somebody paid for should be visible.
   */
  app.post(
    '/api/agents/:id/character/describe',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({ description: z.string().trim().min(20).max(20_000) }),
        request,
      );

      let raw: string;
      try {
        const result = await generate({
          agentId: agent.id,
          jobId: null,
          purpose: 'CHARACTER',
          messages: [{ role: 'user', content: describePrompt(body.description) }],
          maxCalls: 2,
        });
        raw = result.text;
      } catch (error) {
        throw new BadRequestError(
          `The model could not be reached: ${errorMessage(error)}. Connect a model on this agent first.`,
        );
      }

      const parsed = parseCharacterJson(raw);
      if (!parsed.ok) {
        throw new BadRequestError(
          `${parsed.detail} Try describing the character again, or fill in the template by hand.`,
        );
      }
      return { answers: parsed.answers, completeness: scoreCharacter(parsed.answers), source: 'DESCRIBED' };
    }),
  );

  /**
   * A filled-in template coming back.
   *
   * Takes text, whatever it was before: a pasted Markdown file, the JSON block
   * on its own, or the text extracted from a PDF by the browser. Finding the
   * object is the same job in all three cases, so there is one route.
   */
  app.post(
    '/api/agents/:id/character/from-template',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ text: z.string().min(2).max(2_000_000) }), request);

      const parsed = parseFilledTemplate(body.text);
      if (!parsed.ok) {
        throw new BadRequestError(
          `${parsed.detail} The template ends with a JSON block — paste the whole file, or just that block.`,
        );
      }
      return { answers: parsed.answers, completeness: scoreCharacter(parsed.answers), source: 'TEMPLATE' };
    }),
  );

  /**
   * Learn a voice from a public account.
   *
   * Starts the same corpus sync the advanced persona screens use, so the
   * provenance rules hold: raw posts never enter a prompt, only derived traits
   * do, and each trait cites the posts it came from. Returns immediately —
   * fetching a few thousand posts is far too long for a request — and the UI
   * follows the source status.
   */
  app.post(
    '/api/agents/:id/character/learn',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          handle: z.string().trim().min(1).max(120),
          limit: z.number().int().min(50).max(5_000).default(600),
        }),
        request,
      );
      const handle = body.handle.replace(/^@+/, '');

      const source = await personaSources.upsertSource({
        agentId: agent.id,
        kind: 'x_public',
        handle,
        label: `Learned from @${handle}`,
        config: { includeReplies: true, includeQuotes: true },
      });

      const { syncPersonaSource } = await import('@xbam/persona');
      // Deliberately not awaited: the request returns and the UI polls.
      void syncPersonaSource({ sourceId: source.id, limit: body.limit, incremental: false }).catch(() => undefined);

      await ops.audit({
        actorUserId: user.id,
        action: 'character.learn.started',
        entityType: 'agent',
        entityId: agent.id,
        data: { handle, limit: body.limit },
      });
      return { source };
    }),
  );

  /**
   * What was learned, as character answers.
   *
   * Derived traits become the fields somebody can read and edit before
   * anything is saved. A voice learned from an account is a draft, not a fact
   * about the agent.
   */
  app.get(
    '/api/agents/:id/character/learned',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const [sources, traits] = await Promise.all([
        personaSources.listSources(agent.id),
        personaSources.listTraits(agent.id),
      ]);
      const learning = sources.find((s) => s.kind === 'x_public') ?? null;

      if (traits.length === 0) {
        return {
          source: learning,
          ready: false,
          answers: null,
          completeness: null,
          detail: learning
            ? `Still reading @${learning.handle ?? 'that account'}. This takes a minute or two.`
            : 'Nothing has been learned yet.',
        };
      }

      const byKind = (kind: string) => traits.filter((t) => t.kind === kind).map((t) => t.content);
      const answers = CharacterAnswers.parse({
        name: agent.name,
        description: '',
        // Derived traits are statements about how somebody writes, which is
        // exactly what these two fields want.
        personality: byKind('style').slice(0, 6).join('\n'),
        tone: byKind('style').slice(0, 2).join(' '),
        caresAbout: byKind('topic').slice(0, 12),
        speaksLike: byKind('style').slice(0, 8).join('\n'),
        examples: byKind('example').slice(0, 12),
        opinions: byKind('belief').slice(0, 8),
        avoids: [],
        audience: '',
      });

      return {
        source: learning,
        ready: true,
        answers,
        completeness: scoreCharacter(answers),
        // What it looked at, so nobody has to take the result on trust.
        evidence: {
          traits: traits.length,
          examples: byKind('example').length,
          topics: byKind('topic').length,
          beliefs: byKind('belief').length,
        },
      };
    }),
  );

  /**
   * Saves answers as a persona version.
   *
   * The one place any of this is written. Everything before it is a preview,
   * because a character built by a model from a paragraph is a draft until
   * somebody has read it.
   */
  app.post(
    '/api/agents/:id/character/apply',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          answers: CharacterAnswers,
          source: z.enum(['TYPED', 'DESCRIBED', 'TEMPLATE', 'LEARNED']).default('TYPED'),
        }),
        request,
      );

      const existing = await agentsRepo.getActivePersona(agent.id);
      const character = answersToCharacter(body.answers);
      const persona = PersonaDraft.parse({
        // Only the character half matters here; the reply and posting settings
        // are supplied so the projection has a whole answer sheet, and are not
        // saved by this route.
        ...toPersona(EasySetup.parse({ character }), existing ?? undefined),
        // Things the character would never say become the prohibited list, which
        // the validator enforces rather than the prompt merely requesting.
        prohibitedBehaviors: [
          ...answersToProhibited(body.answers),
          ...(existing?.prohibitedBehaviors ?? []),
        ].slice(0, 100),
        changeNote: `Character from ${body.source.toLowerCase()}`,
      });

      const version = await agentsRepo.savePersonaVersion(agent.id, persona, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'character.applied',
        entityType: 'agent',
        entityId: agent.id,
        data: { source: body.source, version: version.version, score: scoreCharacter(body.answers).score },
      });
      return { version: version.version, completeness: scoreCharacter(body.answers) };
    }),
  );

  /** Scores a set of answers without saving. Used live as somebody types. */
  app.post(
    '/api/character/score',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(z.object({ answers: CharacterAnswers }), request);
      return scoreCharacter(body.answers);
    }),
  );
}
