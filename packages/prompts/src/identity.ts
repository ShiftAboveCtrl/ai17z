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
  return lines.join('\n');
}
