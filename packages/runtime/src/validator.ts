import type { PolicyConfig } from '@xbam/shared/contracts';
import { applyEmojiPolicy } from './emoji';

export type Severity = 'REPAIRED' | 'REVIEW' | 'REJECT';

export interface Violation {
  rule: string;
  severity: Severity;
  message: string;
}

export interface ValidationResult {
  /** True when the (possibly repaired) output may proceed to the action gate. */
  ok: boolean;
  output: string;
  violations: Violation[];
}

/**
 * Names an agent must never say about what is running it.
 *
 * Not a policy field. There is no setting for this and no code path around it:
 * which model or provider is behind an agent is the operator's business, not
 * the public's, and an agent that volunteers it leaks a commercial detail and
 * an attack surface in the same sentence. Asked any of these questions, the
 * agent may say it is an AI17Z agent and nothing further.
 *
 * Matched on word boundaries so ordinary words are safe: an agent discussing
 * the Claude Monet exhibition, a llama, or a gemini birthday is not disclosing
 * anything. What is caught is the name used as the thing behind the agent.
 */
const PROVIDER_NAMES = [
  'openai',
  'chatgpt',
  'gpt-3',
  'gpt-4',
  'gpt-5',
  'anthropic',
  'openrouter',
  'deepseek',
  'ollama',
  'mistral',
  'llama 3',
  'llama-3',
  'grok',
  'copilot',
  'perplexity',
  'huggingface',
  'hugging face',
];

/** How the disclosure usually comes out, whatever the model is called. */
const MODEL_DISCLOSURE = [
  /\bi(?:'m| am) (?:powered|run|running|built|based|hosted) (?:by|on|upon)\b/i,
  /\b(?:powered|built|trained|developed|created|made) by (?:openai|anthropic|google|meta|deepseek|mistral|x\.ai|xai)\b/i,
  /\bmy (?:underlying )?(?:model|llm|provider|api) is\b/i,
  /\bi(?:'m| am) (?:a |an )?(?:large )?language model\b/i,
  /\bi(?:'m| am) (?:chatgpt|claude|gemini|grok|llama|deepseek|copilot)\b/i,
  /\bi (?:use|run on|am running on) (?:the )?[a-z0-9.\- ]{0,20}(?:api|model)\b/i,
  /\bmy (?:creator|maker|developer)s? (?:is|are|was|were)\b/i,
];

/** Phrases that would make the agent claim to be human. */
const HUMAN_CLAIM = [
  /\bi(?:'m| am) (?:a )?(?:real )?human\b/i,
  /\bi(?:'m| am) not (?:a |an )?(?:ai|bot|robot|machine|language model)\b/i,
  /\bi(?:'m| am) (?:a )?real person\b/i,
];

/**
 * Whether the sentence is about the agent itself.
 *
 * A provider's name is only a disclosure when the agent is talking about what
 * it is. Mentioning that OpenAI shipped something, or that a company uses
 * Anthropic, is ordinary conversation and must stay sayable.
 */
const SELF_REFERENTIAL =
  /\b(?:i|i'm|i am|me|my|myself)\b[^.!?]{0,60}\b(?:model|llm|ai|assistant|bot|agent|built|powered|running|based|made|trained|behind|uses?|using)\b|\b(?:model|llm|provider|api)\b[^.!?]{0,30}\b(?:i|i'm|i am|me|my)\b/i;

/**
 * Whether a provider name appears as a word, not inside another one.
 *
 * Built from a literal rather than a pattern because every entry is plain
 * text, and a regex assembled from a list is a regex nobody can read.
 */
function namesProvider(text: string, name: string): boolean {
  const at = text.toLowerCase().indexOf(name);
  if (at === -1) return false;
  const before = at === 0 ? " " : text[at - 1]!;
  const after = at + name.length >= text.length ? " " : text[at + name.length]!;
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length > 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Trims to the last sentence, then word, boundary that fits under `limit`. */
function trimToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  // A complete sentence reads better than a longer fragment, so it wins even
  // when it gives up some of the allowance.
  if (sentenceEnd > limit * 0.4) return window.slice(0, sentenceEnd + 1).trim();
  const wordEnd = window.lastIndexOf(' ');
  return (wordEnd > limit * 0.4 ? window.slice(0, wordEnd) : window).trim();
}

/**
 * Validates generated output against the agent policy.
 *
 * Repairs are deterministic and always recorded, never silent: the trace shows
 * both what the model produced and what was actually sent. Anything that cannot
 * be repaired is escalated rather than quietly dropped, which is the failure
 * mode the legacy system had when an empty completion silently discarded a mention.
 */
export function validateOutput(raw: string, policy: PolicyConfig): ValidationResult {
  const violations: Violation[] = [];
  let output = raw.replace(/\r\n/g, '\n').trim();

  if (policy.output.stripSurroundingQuotes) {
    const stripped = stripWrappingQuotes(output);
    if (stripped !== output) {
      violations.push({ rule: 'wrapping_quotes', severity: 'REPAIRED', message: 'Removed wrapping quotation marks.' });
      output = stripped;
    }
  }

  // Models sometimes prefix a label despite being told not to.
  const labelled = output.replace(/^(?:reply|response|answer|output)\s*[:\-]\s*/i, '').trim();
  if (labelled !== output) {
    violations.push({ rule: 'label_prefix', severity: 'REPAIRED', message: 'Removed a leading label.' });
    output = labelled;
  }

  if (!output) {
    violations.push({ rule: 'empty_output', severity: 'REJECT', message: 'The model produced no usable text.' });
    return { ok: false, output: '', violations };
  }

  if (policy.output.forbidHashtags && /(^|\s)#\p{L}[\p{L}\p{N}_]*/u.test(output)) {
    const cleaned = output.replace(/(^|\s)#(\p{L}[\p{L}\p{N}_]*)/gu, '$1$2').replace(/\s{2,}/g, ' ').trim();
    violations.push({ rule: 'hashtags', severity: 'REPAIRED', message: 'Removed hashtag markers.' });
    output = cleaned;
  }

  if (policy.output.forbidLinks && /https?:\/\/\S+/i.test(output)) {
    violations.push({ rule: 'links', severity: 'REVIEW', message: 'Output contains a link, which this policy forbids.' });
  }

  if (policy.output.forbidMentionsOfOthers && /(^|\s)@[A-Za-z0-9_]{2,}/.test(output)) {
    violations.push({ rule: 'mentions', severity: 'REVIEW', message: 'Output mentions another account.' });
  }

  // Emoji before length: taking them out changes the character count, and
  // trimming a message that was only over the limit because of decoration would
  // cut a word for no reason.
  const emoji = applyEmojiPolicy(output, policy.output.emoji);
  if (emoji.removed > 0) {
    output = emoji.text;
    violations.push({ rule: 'emoji', severity: 'REPAIRED', message: emoji.reason ?? 'Removed emoji.' });
  }

  if (output.length > policy.output.maxCharacters) {
    const trimmed = trimToLimit(output, policy.output.maxCharacters);
    if (trimmed.length >= policy.output.minCharacters && trimmed.length > 0) {
      violations.push({
        rule: 'max_length',
        severity: 'REPAIRED',
        message: `Trimmed from ${output.length} to ${trimmed.length} characters to fit the ${policy.output.maxCharacters} limit.`,
      });
      output = trimmed;
    } else {
      violations.push({
        rule: 'max_length',
        severity: 'REVIEW',
        message: `Output is ${output.length} characters and cannot be trimmed to ${policy.output.maxCharacters} without losing all of it.`,
      });
    }
  }

  if (output.length < policy.output.minCharacters) {
    violations.push({
      rule: 'min_length',
      severity: 'REVIEW',
      message: `Output is ${output.length} characters, below the ${policy.output.minCharacters} minimum.`,
    });
  }

  const haystack = output.toLowerCase();
  for (const phrase of policy.output.bannedPhrases) {
    const needle = phrase.trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      violations.push({ rule: 'banned_phrase', severity: 'REJECT', message: `Output contains a banned phrase: "${phrase}".` });
    }
  }
  for (const topic of policy.content.blockedTopics) {
    const needle = topic.trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      violations.push({ rule: 'blocked_topic', severity: 'REVIEW', message: `Output touches a blocked topic: "${topic}".` });
    }
  }

  // Never negotiable, and checked before anything a policy could relax.
  const disclosure = MODEL_DISCLOSURE.find((re) => re.test(output));
  const namedProvider = PROVIDER_NAMES.find((name) => namesProvider(output, name));
  if (disclosure || (namedProvider && SELF_REFERENTIAL.test(output))) {
    violations.push({
      rule: 'model_disclosure',
      severity: 'REVIEW',
      message: namedProvider
        ? `Output names "${namedProvider}" while talking about itself. An agent may say it is an AI17Z agent and nothing about what runs it.`
        : 'Output describes what is running the agent. It may say it is an AI17Z agent and nothing further.',
    });
  }

  if (!policy.identity.mayDenyBeingAI && HUMAN_CLAIM.some((re) => re.test(output))) {
    violations.push({
      rule: 'identity_claim',
      severity: 'REJECT',
      message: 'Output claims to be human, which this agent identity policy forbids.',
    });
  }

  if (policy.identity.disclosure === 'ALWAYS') {
    const statement = policy.identity.disclosureStatement.toLowerCase();
    const keyword = statement.match(/\b(ai|bot|agent|automated)\b/)?.[1] ?? 'ai';
    if (!haystack.includes(keyword)) {
      violations.push({
        rule: 'disclosure_missing',
        severity: 'REVIEW',
        message: 'Policy requires disclosure in every message, but the output does not mention it.',
      });
    }
  }

  const blocking = violations.some((v) => v.severity !== 'REPAIRED');
  return { ok: !blocking, output, violations };
}
