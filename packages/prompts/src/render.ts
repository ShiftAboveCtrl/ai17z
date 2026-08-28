import type { RelationshipContext, SocialMediaContext, StanceContext } from '@xbam/shared/contracts';
/** Named so a literal newline never has to survive a code generator again. */
const NL = '\n';

export type TemplateValues = Record<string, string | number | boolean | null | undefined>;

/**
 * Deliberately tiny template language. Enough to express the prompt layers as
 * editable data, small enough that its behaviour is obvious:
 *
 *   {{name}}            substitute (missing or null renders as empty)
 *   {{#name}}...{{/name}}   include block when the value is non-empty
 *   {{^name}}...{{/name}}   include block when the value is empty
 *
 * No loops, no partials, no arbitrary expressions: prompt templates are content,
 * not code, and a template must never be able to do something surprising.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const isEmpty = (key: string): boolean => {
    const value = values[key];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'number') return false;
    return false;
  };

  const withSections = template.replace(
    /\{\{([#^])([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_match, kind: string, key: string, body: string) => {
      const empty = isEmpty(key);
      const include = kind === '#' ? !empty : empty;
      return include ? body : '';
    },
  );

  return withSections.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Collapses the blank lines that dropped sections leave behind. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function bulletList(items: readonly string[], bullet = '- '): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `${bullet}${item}`)
    .join('\n');
}

export function numberedList(items: readonly string[]): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
}

/**
 * Describes what was attached to a post.
 *
 * Each item is numbered and named by kind, because "the second image" is a
 * thing people say and a thing a model needs to be able to resolve. An item
 * that could not be read says so rather than being omitted: silence would let
 * the model assume there was nothing there.
 */
export function renderMedia(items: SocialMediaContext['items']): string {
  if (items.length === 0) return '';
  const lines: string[] = [];

  for (const item of items) {
    const label = `${item.kind === 'gif' ? 'GIF' : item.kind}${items.length > 1 ? ` ${item.position + 1}` : ''}`;
    if (item.status === 'analyzed' && item.description) {
      lines.push(`- ${label}: ${item.description}`);
      // Text read out of a picture is the least reliable part of this, so it is
      // labelled as read rather than presented as fact.
      if (item.extractedText) lines.push(`  Text visible in it: "${item.extractedText}"`);
    } else if (item.altText) {
      lines.push(`- ${label}: described by its author as "${item.altText}" (not otherwise examined)`);
    } else {
      lines.push(`- ${label}: present but not examined.`);
    }
  }
  return lines.join('\n');
}

/** The post being quoted, which often carries the substance of the reply. */
export function renderQuoted(quoted: SocialMediaContext['quoted']): string {
  if (!quoted) return '';
  const who = quoted.authorHandle ? `@${quoted.authorHandle}` : 'someone';
  const media = quoted.mediaSummary ? `\n(${quoted.mediaSummary})` : '';
  return `${who} wrote:\n${quoted.text}${media}`;
}

export function renderLinks(links: SocialMediaContext['links']): string {
  if (links.length === 0) return '';
  return links
    .map((link) => {
      if (link.resolution === 'fetched' && link.summary) return `- ${link.url}\n  ${link.summary}`;
      if (link.title) return `- ${link.url} — ${link.title}`;
      // A link nobody opened is still worth mentioning, so the model does not
      // pretend to know what is behind it.
      return `- ${link.url} (not opened)`;
    })
    .join('\n');
}

/**
 * Describes the relationship in plain sentences.
 *
 * The point is continuity, not analysis. Everything here is something the two
 * of them actually did together — nothing is inferred about the person beyond
 * the conversations they chose to have.
 */
export function renderRelationship(relationship: RelationshipContext | null | undefined): string {
  if (!relationship) return '';
  const lines: string[] = [];

  if (!relationship.known) {
    lines.push(`@${relationship.handle} has not spoken to you before.`);
  } else {
    const level = {
      NEW: 'You barely know them',
      KNOWN: 'You have spoken before',
      FAMILIAR: 'You know them',
      REGULAR: 'They are a regular',
    }[relationship.familiarity];
    lines.push(`@${relationship.handle}. ${level}. ${relationship.historyLine}`);
    if (relationship.topics.length > 0) lines.push(`You have discussed: ${relationship.topics.join(', ')}.`);
    if (relationship.summary) lines.push(relationship.summary);
    // The owner's own words outrank anything derived, so they go last and are
    // labelled as instruction rather than observation.
    if (relationship.ownerNote) lines.push(`Note from your owner: ${relationship.ownerNote}`);
  }

  if (relationship.disposition === 'CAUTIOUS') {
    lines.push('Be careful with this one. Stay measured whatever they say.');
  } else if (relationship.disposition === 'FRIENDLY') {
    lines.push('You get on well with them.');
  }

  return lines.join('\n');
}

export function renderCallback(relationship: RelationshipContext | null | undefined): string {
  if (!relationship?.callback) return '';
  return `${relationship.callback.label}: ${relationship.callback.detail}`;
}

/**
 * Positions the agent has already taken on what is being discussed.
 *
 * Confidence is rendered as a word rather than a number, because "0.74" invites
 * a model to reason about the number instead of the position.
 */
export function renderStances(stance: StanceContext | null | undefined): string {
  if (!stance || stance.relevant.length === 0) return '';
  return stance.relevant
    .map((entry) => {
      const firmness = entry.confidence >= 0.75 ? 'firmly' : entry.confidence >= 0.5 ? '' : 'tentatively';
      const held = `${firmness} ${entry.position.toLowerCase()}`.trim();
      return `- ${entry.subject}: you are ${held}. ${entry.summary}`;
    })
    .join(NL);
}

export function renderRevisions(stance: StanceContext | null | undefined): string {
  if (!stance || stance.revised.length === 0) return '';
  return stance.revised
    .map((entry) => `- ${entry.subject}: you moved from ${entry.from.toLowerCase()} to ${entry.to.toLowerCase()}.`)
    .join(NL);
}

/** Open promises to this person, so a reply can pick one up. */
export function renderCommitments(commitments: { promise: string }[] | undefined): string {
  if (!commitments || commitments.length === 0) return '';
  return commitments.map((c) => `- ${c.promise}`).join(NL);
}

/**
 * Where a conversation has got to.
 *
 * The unresolved question comes last because it is the part a reply has to
 * engage with, and burying it above the settled points makes it something the
 * model has to go looking for.
 */
export function renderThreadState(
  thread: { summary: string | null; mainTopic: string | null; openQuestion: string | null; resolvedPoints: string[]; turnCount: number } | null | undefined,
): string {
  if (!thread?.summary) return '';
  const lines = [thread.summary];
  if (thread.resolvedPoints.length > 0) {
    lines.push(`Already settled: ${thread.resolvedPoints.join('; ')}. Do not reargue these.`);
  }
  if (thread.openQuestion) lines.push(`Still unresolved: ${thread.openQuestion}`);
  return lines.join(NL);
}
