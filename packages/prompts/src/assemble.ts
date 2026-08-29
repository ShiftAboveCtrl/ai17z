import type { MediaInventory, RelationshipContext, SocialMediaContext, StanceContext } from '@xbam/shared/contracts';
import type {
  ChatMessage,
  ContextMessage,
  PersonaVersion,
  PolicyConfig,
  PromptLayer,
  ResolvedContext,
  RetrievedMemory,
} from '@xbam/shared/contracts';
import type { PromptLayerTemplate } from '@xbam/database';
import { truncateTail } from '@xbam/shared';
import {
  bulletList,
  renderCallback,
  renderLinks,
  renderMedia,
  renderQuoted,
  renderCommitments,
  renderRelationship,
  renderRevisions,
  renderStances,
  renderTemplate,
  renderThreadState,
  tidy,
} from './render';
import { describeDisclosure, describeIdentity } from './identity';

export interface AssembleInput {
  layers: PromptLayerTemplate[];
  templateKey: string;
  templateVersion: number;
  persona: PersonaVersion;
  policy: PolicyConfig;
  context: ResolvedContext;
  memories: RetrievedMemory[];
  channelName: string;
  toolDescriptions: string[];
  /** Max characters of rendered memory, from the memory policy. */
  memoryCharBudget: number;
}

export interface AssembledPrompt {
  layers: PromptLayer[];
  messages: ChatMessage[];
  /** Flattened text stored with the model call so a generation is reproducible. */
  promptText: string;
}

const LENGTH_HINTS: Record<PersonaVersion['responseLength'], string> = {
  TERSE: 'One short sentence at most.',
  SHORT: 'One or two sentences.',
  MEDIUM: 'Two to four sentences.',
  LONG: 'A full paragraph is fine.',
  ADAPTIVE: 'Match the length and depth of the incoming message.',
};

function renderMemories(memories: RetrievedMemory[], budget: number): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `[${m.scope}] ${m.summary?.trim() || m.content.trim()}`);
  // Keep the tail when trimming: recent, highest-ranked memory matters most.
  return truncateTail(lines.join('\n'), budget);
}

function renderTranscript(thread: ContextMessage[], agentName: string): string {
  return thread
    .map((m) => {
      const who = m.role === 'OUTBOUND' ? agentName : (m.authorHandle ?? 'them');
      return `${who}: ${m.text.replace(/\s+/g, ' ').trim()}`;
    })
    .filter((line) => line.length > 3)
    .join('\n');
}

/**
 * What the post being replied to is carrying, stated plainly.
 *
 * Nothing here has been read by a vision model — these are attachments the
 * adapter saw on the parent post. Saying so is the point: a short mention under
 * a chart is a question about the chart, and the model should know it is
 * answering without having seen it rather than inventing what it showed.
 */
function renderParentAttachments(inventory: MediaInventory | undefined): string {
  if (!inventory) return '';
  const parts: string[] = [];
  const images = inventory.media.filter((m) => m.kind === 'image').length;
  const videos = inventory.media.filter((m) => m.kind === 'video' || m.kind === 'gif').length;
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`);
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
  if (inventory.quoted) {
    const who = inventory.quoted.authorHandle ? `@${inventory.quoted.authorHandle}` : 'someone';
    parts.push(`a quoted post from ${who}: "${inventory.quoted.text.replace(/\s+/g, ' ').trim().slice(0, 240)}"`);
  }
  if (parts.length === 0) return '';
  return `That post also carries ${parts.join(' and ')}. You have not seen the attachments, so do not describe them.`;
}

function renderOutputRules(persona: PersonaVersion, policy: PolicyConfig): string {
  const rules: string[] = [`Stay under ${policy.output.maxCharacters} characters.`];
  if (policy.output.minCharacters > 1) rules.push(`Write at least ${policy.output.minCharacters} characters.`);
  rules.push(LENGTH_HINTS[persona.responseLength]);
  if (policy.output.forbidHashtags) rules.push('Do not use hashtags.');
  if (policy.output.forbidLinks) rules.push('Do not include links.');
  if (policy.output.forbidMentionsOfOthers) rules.push('Do not mention other accounts.');
  rules.push('No surrounding quotation marks, no preamble, no sign-off.');
  return bulletList(rules);
}

function sourceFor(key: string, input: AssembleInput): string {
  switch (key) {
    case 'IDENTITY':
    case 'PERSONA_FACTS':
    case 'STYLE':
      return `persona v${input.persona.version}`;
    case 'SAFETY_DISCLOSURE':
      return `policy identity rules, persona v${input.persona.version}`;
    case 'RETRIEVED_MEMORY':
      return `${input.memories.length} retrieved memories`;
    case 'IMMEDIATE_CONTEXT':
      return 'channel adapter context';
    case 'MEDIA_CONTEXT':
      return 'attached media, quoted posts and links';
    case 'RELATIONSHIP':
      return 'relationship memory';
    case 'BELIEFS':
      return 'stance ledger';
    case 'OUTPUT_CONTRACT':
      return 'policy output rules';
    default:
      return `${input.templateKey} v${input.templateVersion}`;
  }
}

/**
 * Renders the ten prompt layers into chat messages. Layers that render empty are
 * dropped rather than shipped as empty headings, and every surviving layer is
 * returned so the trace UI can show exactly what the model was told.
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const { persona, policy, context } = input;
  // Attached by the media stage. Absent for a text-only post, or for an agent
  // whose pipeline has no media node.
  const mediaContext = (context.meta as { mediaContext?: SocialMediaContext } | undefined)?.mediaContext;
  const relationship = (context.meta as { relationship?: RelationshipContext } | undefined)?.relationship;
  const stance = (context.meta as { stance?: StanceContext } | undefined)?.stance;
  const threadState = (context.meta as { thread?: Parameters<typeof renderThreadState>[0] } | undefined)?.thread;
  const openCommitments = (context.meta as { openCommitments?: { promise: string }[] } | undefined)?.openCommitments;
  // Attached by the X adapter when the mention leans on what its parent carries.
  const parentInventory = (context.meta as { parentInventory?: MediaInventory | null } | undefined)?.parentInventory ?? undefined;

  const values = {
    channelName: input.channelName,
    displayName: persona.displayName,
    identityDescription: describeIdentity(persona.identityKind, persona.displayName, policy.identity),
    biography: persona.biography,
    personality: persona.personality,
    topics: persona.topics.join(', '),
    tone: persona.tone,
    styleGuidelines: persona.styleGuidelines,
    languagePolicy: persona.languagePolicy,
    styleExamples: bulletList(persona.styleExamples.slice(0, 40)),
    disclosureRule: describeDisclosure(policy.identity),
    prohibitedBehaviors: bulletList(persona.prohibitedBehaviors),
    blockedTopics: bulletList(policy.content.blockedTopics),
    customInstructions: persona.customInstructions,
    memoryBlock: renderMemories(input.memories, input.memoryCharBudget),
    relationshipBlock: renderRelationship(relationship),
    stanceBlock: renderStances(stance),
    revisedBlock: renderRevisions(stance),
    commitmentBlock: renderCommitments(openCommitments),
    callbackBlock: renderCallback(relationship),
    mediaBlock: renderMedia(mediaContext?.items ?? []),
    quotedBlock: renderQuoted(mediaContext?.quoted ?? null),
    linkBlock: renderLinks(mediaContext?.links ?? []),
    mediaGap: mediaContext?.hasUnderstandingGap ? mediaContext.gapDetail ?? '' : '',
    threadState: renderThreadState(threadState),
    threadTranscript: renderTranscript(context.thread, persona.displayName),
    parentText: context.parentText ?? '',
    parentAttachments: renderParentAttachments(parentInventory),
    authorHandle: context.targetAuthorHandle ? `@${context.targetAuthorHandle.replace(/^@/, '')}` : 'someone',
    incomingText: context.incomingText,
    toolsBlock: bulletList(input.toolDescriptions),
    outputRules: renderOutputRules(persona, policy),
  };

  const layers: PromptLayer[] = [];
  for (const layer of input.layers) {
    const content = tidy(renderTemplate(layer.template, values));
    if (!content) continue;
    layers.push({
      key: layer.key,
      title: layer.title,
      role: layer.role,
      content,
      source: sourceFor(layer.key, input),
    });
  }

  const system = layers.filter((l) => l.role === 'system').map((l) => l.content).join('\n\n');
  const user = layers.filter((l) => l.role === 'user').map((l) => l.content).join('\n\n');

  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user || context.incomingText });

  return {
    layers,
    messages,
    promptText: messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n'),
  };
}
