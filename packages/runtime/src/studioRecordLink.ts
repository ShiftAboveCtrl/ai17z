import { PipelineError } from '@xbam/shared';
import type { PolicyConfig } from '@xbam/shared/contracts';
import { PAPER_IDEA_SOURCE } from './studioPaperVoice';
import { publicHomeState } from './studioPublicHome';
import { linkedCheckOrigin } from './studioCheckLink';

/**
 * The link a paper record post ends with: the agent's published public page on
 * the Studio this installation is linked to, which carries its simulated paper
 * record.
 *
 * This is the sibling of `studioCheckLink.ts` and keeps its rules:
 *
 * - The runtime builds the link and appends it to the finished text. A model
 *   never writes it, and any link in a paper record post that is not exactly
 *   this one is held for the owner.
 * - The origin is the linked Studio's and nothing else. An installation that is
 *   not linked, or only has a development origin, produces no link.
 * - It exists only for a confirmed, current publication whose manifest carried
 *   a paper snapshot. An unpublished, stale or paper-less page would be a dead
 *   or empty link on a public post, so the post goes out without one and keeps
 *   its inline summary.
 * - Off unless `policy.studio.linkPaperRecord` is on, a separate opt-in from
 *   posting the record at all.
 */

export const RECORD_LINK_PREFIX = 'Paper record: ';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_IN_TEXT = /\bhttps?:\/\/\S+/gi;
const DATE_WORDS =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/** Pure: the public page for one slug on one origin, or null when either is not exactly that. */
export function recordLinkUrl(origin: string, slug: string): string | null {
  if (!SLUG.test(slug)) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.origin !== origin || (base.protocol !== 'https:' && base.protocol !== 'http:')) return null;
  const url = new URL(`/a/${slug}`, base);
  return url.origin === origin ? url.toString() : null;
}

/** The link for this agent's published page, or null. Never throws. */
export async function studioRecordLink(agentId: string): Promise<string | null> {
  try {
    const state = await publicHomeState(agentId);
    const confirmed = state.confirmed;
    if (!state.url || state.stale || !confirmed?.published || confirmed.paper !== true) return null;
    const origin = await linkedCheckOrigin();
    if (!origin || origin !== confirmed.origin) return null;
    const link = recordLinkUrl(origin, confirmed.slug);
    return link && link === state.url ? link : null;
  } catch {
    return null;
  }
}

/** Problems with the links in a finished record post, as sentences. `link` is what the runtime proved, or null. */
export function checkRecordLinkText(text: string, link: string | null): string[] {
  const urls = text.match(URL_IN_TEXT) ?? [];
  if (urls.length === 0) return [];
  if (!link) return ['It contains a link, and no link to the paper record was proven for it.'];
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  const wrote = urls.filter((url) => url !== link).length;
  if (wrote > 0 || urls.length !== 1 || last !== `${RECORD_LINK_PREFIX}${link}`) {
    return ['It contains a link the runtime did not build, or the paper record link is not the one closing line.'];
  }
  return [];
}

export interface RecordLinkInput {
  agentId: string;
  raw: unknown;
  text: string;
  policy: PolicyConfig;
  maxCharacters?: number;
}

const isRecordPost = (raw: unknown) => ((raw ?? {}) as { ideaSource?: unknown }).ideaSource === PAPER_IDEA_SOURCE;

/**
 * The text a paper record post is sent as: the validated text, closed with the
 * proven link when the owner asked for one and one exists. Anything else is the
 * text unchanged. A link already in the model's text is held, whether or not
 * this feature is on, because the only link that passes is the one built here.
 *
 * Runs at send, after the voice rewrite, so the last thing that writes text is
 * the last thing that checks it.
 */
export async function paperRecordSendText(input: RecordLinkInput): Promise<string> {
  if (!isRecordPost(input.raw)) return input.text;
  const wanted = input.policy.studio.postPaperRecord && input.policy.studio.linkPaperRecord && !input.policy.output.forbidLinks;
  let text = input.text;
  let link: string | null = null;
  // Without the window dates in the text the link would stand alone, so it is left off.
  if (wanted && DATE_WORDS.test(text) && !(text.match(URL_IN_TEXT)?.length)) {
    const proven = await studioRecordLink(input.agentId);
    if (proven) {
      const closing = `\n${RECORD_LINK_PREFIX}${proven}`;
      const limit = input.maxCharacters ?? input.policy.output.maxCharacters;
      // A link that does not fit is left off rather than cutting the summary.
      if (text.length + closing.length <= limit) {
        text += closing;
        link = proven;
      }
    }
  }
  const problems = checkRecordLinkText(text, link);
  if (problems.length > 0) {
    throw PipelineError.review('paper_record_link', `This post about the paper record needs the owner: ${problems.join(' ')}`);
  }
  return text;
}
