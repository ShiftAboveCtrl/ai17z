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
import { describeEmojiPolicy } from './emojiRule';

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
  /** What the job is going to do. A post is written differently from a reply. */
  actionType?: 'REPLY' | 'POST' | string;
  /**
   * What this answer rests on, worked out from what was actually gathered.
   *
   * Only one thing is done with it here, and it is the thing that matters: when
   * nothing was found, the model is told so. A model with no evidence writes
   * exactly as confidently as one with plenty, and that is the sentence that
   * gets somebody a wrong answer stated as fact.
   */
  evidence?: { evidence: string; reason: string; shouldAdmitUncertainty: boolean };
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
  const lines = memories.map((m) => {
    // A document is rendered whole, and attributed.
    //
    // Every other scope stores a one-line summary and a longer body, so the
    // summary is the right thing to show. A knowledge chunk's summary is its
    // heading, and showing that alone put "Installing > Windows" into the
    // prompt with none of the instructions under it -- the document was
    // retrieved, cited, and empty.
    if (m.scope === 'KNOWLEDGE') {
      const where = [m.origin?.sourceName, m.origin?.path].filter(Boolean).join(', ');
      const version = m.origin?.revision ? ` at ${m.origin.revision}` : '';
      const attribution = where ? ` (${where}${version})` : '';
      return `[DOCUMENT${attribution}] ${m.content.trim()}`;
    }
    return `[${m.scope}] ${m.summary?.trim() || m.content.trim()}`;
  });
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
 * A sentence about how well-founded this answer is, when it is not.
 *
 * Deliberately says nothing when there is evidence: a note on every message
 * would be read past by the model within a few layers, and the one case worth
 * spending that on is the one where there is nothing behind the answer at all.
 */
function renderEvidenceNote(evidence: AssembleInput['evidence']): string {
  if (!evidence?.shouldAdmitUncertainty) return '';
  return [
    'EVIDENCE',
    evidence.reason,
    'Say plainly that you do not know, or that you could not check. Do not fill the gap with something that sounds right.',
    '',
  ].join('\n');
}

/**
 * What was looked up, framed as evidence rather than as knowledge.
 *
 * The distinction matters: an agent that launders a search result into its own
 * voice will state a wrong one exactly as confidently as a right one. So each
 * finding keeps the name of where it came from, and the block ends by saying
 * this was looked up rather than known.
 */
function renderResearchBlock(research: unknown): string {
  const result = research as
    | { findings?: { source: string; title: string; summary: string; url: string | null }[]; failed?: { query: string; reason: string }[] }
    | undefined;
  if (!result) return '';
  const findings = result.findings ?? [];
  const failed = result.failed ?? [];
  if (findings.length === 0 && failed.length === 0) return '';

  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(`${finding.source} - ${finding.title}`);
    if (finding.summary) lines.push(`  ${finding.summary.replace(/\s+/g, ' ').slice(0, 500)}`);
    if (finding.url) lines.push(`  ${finding.url}`);
  }
  if (failed.length > 0) {
    lines.push(`Could not check: ${failed.map((f) => f.query.slice(0, 60)).join('; ')}.`);
    lines.push('Say you do not know rather than guessing at those.');
  }
  lines.push('');
  lines.push(
    'This was looked up a moment ago and is not something you already knew. Use it where it answers the question, ' +
      'attribute a number if the number matters, and never present any of it as your own knowledge.',
  );
  return lines.join('\n');
}

/**
 * What the post being replied to is carrying, stated plainly.
 *
 * Nothing here has been read by a vision model — these are attachments the
 * adapter saw on the parent post. Saying so is the point: a short mention under
 * a chart is a question about the chart, and the model should know it is
 * answering without having seen it rather than inventing what it showed.
 */
/**
 * What the post above carries, when nobody has looked at it.
 *
 * Only reached when the attachments were not analysed -- once they have been,
 * `renderMedia` describes them properly and saying "you have not seen the
 * attachments" underneath would contradict the descriptions directly above it.
 */
function renderParentAttachments(inventory: MediaInventory | undefined, alreadyDescribed: boolean): string {
  if (!inventory || alreadyDescribed) return '';
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
  const emoji = describeEmojiPolicy(policy.output.emoji);
  if (emoji) rules.push(emoji);
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
  // Attached by the research step when the answer depends on something a
  // training set cannot hold.
  const research = (context.meta as { research?: { rendered?: string } } | undefined)?.research;

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
    mediaBlock: renderMedia(mediaContext?.items ?? [], mediaContext?.onParentPost ?? false),
    quotedBlock: renderQuoted(mediaContext?.quoted ?? null),
    linkBlock: renderLinks(mediaContext?.links ?? []),
    mediaGap: mediaContext?.hasUnderstandingGap ? mediaContext.gapDetail ?? '' : '',
    threadState: renderThreadState(threadState),
    threadTranscript: renderTranscript(context.thread, persona.displayName),
    parentText: context.parentText ?? '',
    parentAttachments: renderParentAttachments(parentInventory, mediaContext?.onParentPost ?? false),
    researchBlock: renderResearchBlock(research),
    evidenceNote: renderEvidenceNote(input.evidence),
    authorHandle: context.targetAuthorHandle ? `@${context.targetAuthorHandle.replace(/^@/, '')}` : 'someone',
    incomingText: context.incomingText,
    toolsBlock: bulletList(input.toolDescriptions),
    outputRules: renderOutputRules(persona, policy),
    // The TASK layer reads this. A post has no incoming message to answer, and
    // telling a model to "reply" to its own brief produces something that reads
    // like half a conversation.
    //
    // The reply case names the person and says they are being spoken to,
    // because "reply to the incoming message" left that implicit and the model
    // drifted into the third person: paid a compliment, the agent answered
    // "they keep things sharp", reviewing itself as a bystander.
    taskInstruction:
      input.actionType === 'POST'
        ? `Write one ${input.channelName} post, as ${persona.displayName}. Nobody asked you anything; this is something you wanted to say.`
        : `Write one ${input.channelName} reply, as ${persona.displayName}, to ${
            context.targetAuthorHandle ? `@${context.targetAuthorHandle.replace(/^@/, '')}` : 'the person'
          }. They are speaking to you. Answer them — address them, not a third party, and never describe yourself from the outside.`,
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
