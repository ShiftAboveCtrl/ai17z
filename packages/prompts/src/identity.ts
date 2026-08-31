import type { IdentityKind, IdentityPolicy } from '@xbam/shared/contracts';

/**
 * Turns the identity kind into a sentence the model can act on. XBAM refuses to
 * make impersonation the default: every kind except REAL_PERSON_AUTHORIZED says
 * explicitly that the agent is not the person it sounds like.
 */
export function describeIdentity(kind: IdentityKind, displayName: string, policy: IdentityPolicy): string {
  const entity = policy.representedEntity.trim();
  switch (kind) {
    case 'FICTIONAL':
      return `${displayName} is a fictional character. You are not a real person and must not claim to be one.`;
    case 'INSPIRED_BY':
      return entity
        ? `Your voice is inspired by ${entity}. You are not ${entity}, you do not speak for them, and you must not claim to be them.`
        : 'Your voice is inspired by a public figure, but you are not that person and must not claim to be them.';
    case 'BRAND':
      return entity
        ? `You post as the official voice of ${entity}. Speak for the organisation, never as an individual.`
        : 'You post as an official brand account. Speak for the organisation, never as an individual.';
    case 'REAL_PERSON_AUTHORIZED':
      return entity
        ? `You are an authorised account operating on behalf of ${entity}.`
        : 'You are an authorised account operating on behalf of a named individual.';
    case 'DISCLOSED_AI':
      return 'You are an AI agent and you are open about it.';
    default:
      return '';
  }
}

/** The disclosure sentence appended to the safety layer. */
export function describeDisclosure(policy: IdentityPolicy): string {
  const statement = policy.disclosureStatement.trim() || 'I am an AI agent.';
  const lines: string[] = [];
  if (policy.disclosure === 'ALWAYS') {
    lines.push(`DISCLOSURE\nMake your nature clear in every message: "${statement}"`);
  } else if (policy.disclosure === 'ON_REQUEST') {
    lines.push(`DISCLOSURE\nIf anyone asks whether you are an AI, a bot, or automated, answer honestly: "${statement}"`);
  }
  if (!policy.mayDenyBeingAI) {
    // The platform default. Only an explicit, versioned policy change removes it.
    lines.push('Never assert that you are a human being.');
  }
  // Not a policy field, and there is no setting that removes it. Which model
  // or provider runs an agent is the operator's business; an agent that
  // volunteers it gives away a commercial detail and an attack surface in one
  // sentence.
  lines.push(NEVER_NAME_THE_MODEL);
  lines.push(NOT_SOMEBODY_ELSES_MONEY);
  return lines.join('\n');
}


/**
 * The one identity rule an operator cannot switch off.
 *
 * Enforced twice: stated here so the model does not do it, and checked in the
 * validator so an output that does it anyway goes to a person rather than to
 * X. The permitted answer is deliberately short - "an AI17Z agent" - because
 * any longer answer invites the follow-up question.
 */
export const NEVER_NAME_THE_MODEL =
  'Never say which AI model, company, or service runs you, and never name one when talking about yourself. ' +
  'If anyone asks what you are built on, who made you, what model you use, or who powers you, ' +
  'say only that you are an AI17Z agent, and move on. Do not hint at it and do not deny knowing it.';

/**
 * Talk about the asset, never about their money.
 *
 * Found by running a scenario at it: told "I have 40k in savings, should I put
 * it all into ETH", the agent replied "I wouldn't put all 40k into ETH; keep
 * most in cash". Sensible, kind, and an autonomous account publicly directing
 * an identified stranger's savings -- which is a liability for whoever owns the
 * account, however good the advice happens to be.
 *
 * Deliberately narrow. An agent whose whole subject is markets has to be able
 * to say what a token is, what it costs, and whether a launch looks like a
 * scam. What it stops doing is telling a particular person what to do with a
 * particular sum.
 */
export const NOT_SOMEBODY_ELSES_MONEY =
  'You may discuss assets, prices, mechanics, and risks in general, and you may say when something looks like a scam. ' +
  'But if someone asks what to do with their own money, holdings, or savings, do not tell them: ' +
  'say plainly that it is not something you will advise on, and leave the decision with them. ' +
  'Do not soften this into a recommendation and do not answer it as a hypothetical.';
