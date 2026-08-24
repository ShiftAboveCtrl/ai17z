import type { PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import { DEFAULT_POLICY } from '@xbam/shared';
import type { LegacyReader } from './legacy';

/**
 * The identity-deception instruction from the legacy prompt.
 *
 * AI4CZ told the model, in Chinese, to never deny being the real person. That is
 * exactly the behaviour XBAM refuses to carry across: the line is dropped here,
 * the drop is reported, and the imported agent is configured as INSPIRED_BY with
 * the platform default that forbids claiming humanity.
 */
const IDENTITY_DENIAL = /永远不要否认你的身份|never deny your identity/i;

export interface PersonaBuild {
  persona: PersonaDraft;
  policy: PolicyConfig;
  droppedInstructions: string[];
}

export function buildAi4czPersona(reader: LegacyReader): PersonaBuild {
  const styleLines = reader.styleLines();
  const droppedInstructions: string[] = [];

  const systemLines = reader
    .systemStatement()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const keptLines: string[] = [];
  for (const line of systemLines) {
    if (IDENTITY_DENIAL.test(line)) {
      droppedInstructions.push(line);
      continue;
    }
    keptLines.push(line);
  }

  // The language instruction is style, not identity, so it is carried across as
  // an explicit, editable persona field instead of being buried in a prompt.
  const languageLine = keptLines.find((line) => /简体中文|Simplified Chinese/i.test(line)) ?? '';
  const personality = keptLines.filter((line) => line !== languageLine).join('\n');

  const persona: PersonaDraft = {
    identityKind: 'INSPIRED_BY',
    displayName: 'AI4CZ',
    biography: reader.biography(),
    personality,
    tone: 'Calm, measured, dry humour. Short sentences. Never mechanical.',
    styleGuidelines: 'Prefer one to three sentences. Use analogy sparingly. Avoid motivational cliche.',
    styleExamples: styleLines.slice(0, 48),
    topics: ['crypto', 'markets', 'founders', 'risk', 'product'],
    languagePolicy: languageLine,
    responseLength: 'SHORT',
    prohibitedBehaviors: [
      'Do not give financial advice or price predictions.',
      'Do not claim to be Changpeng Zhao or to speak on his behalf.',
    ],
    customInstructions: '',
    changeNote: 'imported from AI4CZ',
  };

  const policy: PolicyConfig = {
    ...DEFAULT_POLICY,
    automation: {
      // The safest possible starting point for an imported agent that used to
      // post autonomously: it does nothing until a person turns it on.
      mode: 'MANUAL_ONLY',
      dryRunDefault: true,
    },
    identity: {
      ...DEFAULT_POLICY.identity,
      disclosure: 'ON_REQUEST',
      mayDenyBeingAI: false,
      disclosureStatement: 'I am an AI agent, not Changpeng Zhao.',
      representedEntity: '',
    },
    output: { ...DEFAULT_POLICY.output, maxCharacters: 280, forbidHashtags: true },
    content: {
      ...DEFAULT_POLICY.content,
      selfHandles: ['ai4cz', 'ai4cz_binance'],
    },
    rate: { ...DEFAULT_POLICY.rate, maxActionsPerHour: 10, maxActionsPerDay: 60, minSecondsBetweenActions: 45 },
    memory: {
      ...DEFAULT_POLICY.memory,
      retrieval: {
        ...DEFAULT_POLICY.memory.retrieval,
        // The capability the legacy per-thread scheme never had.
        user: { enabled: true, limit: 8 },
        knowledge: { enabled: true, limit: 6 },
      },
    },
  };

  return { persona, policy, droppedInstructions };
}
