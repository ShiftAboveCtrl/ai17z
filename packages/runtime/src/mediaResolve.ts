import type {
  MediaInventory,
  MediaPolicy,
  MediaUnderstanding,
  SocialMediaContext,
} from '@xbam/shared/contracts';
import { createLogger, errorMessage, textStandsAlone } from '@xbam/shared';
import { media as mediaRepo, providers as providersRepo } from '@xbam/database';
import { generate } from '@xbam/models';

const log = createLogger('media-resolve');

/**
 * Turning what is attached to a post into something a model can be told.
 *
 * The failure this replaces is an agent answering "what do you think?" without
 * ever seeing the chart the question was about. Two rules follow from that:
 * media that carries the substance must be understood before generating, and
 * media that could not be understood must be reported as a gap rather than
 * quietly left out. Pretending is worse than admitting.
 */

/**
 * Is there enough here to answer without looking at anything else?
 *
 * One implementation, in @xbam/shared, because the channel adapter asks the
 * same question when it decides whether to spend a DOM pass reading the
 * parent's attachments -- and when the two copies were separate they were both
 * a bare word count, which is how a thirteen-word question about a screenshot
 * was answered without anybody looking at the screenshot.
 */
export const textCarriesTheQuestion = textStandsAlone;

/**
 * Whether failing to read the media should stop a response.
 *
 * Deliberately conservative in one direction only: a short post with an image
 * is assumed to be about the image, because answering the wrong question
 * confidently is the outcome worth avoiding.
 */
export function mediaCarriesTheSubstance(text: string, inventory: MediaInventory): boolean {
  const hasVisual = inventory.media.some((m) => m.kind === 'image' || m.kind === 'video');
  if (!hasVisual && !inventory.quoted) return false;
  return !textCarriesTheQuestion(text);
}

const VISION_INSTRUCTION = [
  'Describe this image as context for replying to a social media post.',
  'State plainly what it shows. If it contains readable text, a chart, or numbers, report them.',
  'Two or three sentences. No preamble, no speculation about who posted it.',
].join(' ');

const GIF_INSTRUCTION =
  'This is a reaction GIF from a social media reply. In one short sentence, say what reaction it conveys. Do not describe it frame by frame.';

/** Whether this agent has a model that can actually read an image. */
export async function hasVisionModel(agentId: string): Promise<boolean> {
  const configs = await providersRepo.listModelConfigs(agentId);
  return configs.some((c) => c.role === 'vision');
}

/**
 * How large an image may be before it is not worth sending.
 *
 * Five megabytes is comfortably above anything X serves at `name=large` and
 * comfortably below the request limits providers publish. A photograph that
 * exceeds it is skipped with a reason rather than sent to be rejected.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Long enough for a slow CDN, short enough not to hold a reply hostage. */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetches the image and inlines it, rather than handing the provider a link.
 *
 * Sending a URL assumes the provider can fetch it, and for X media that
 * assumption is simply false. The first real attempt came back:
 *
 *   DeepSeek returned 400: .messages[0].image[0]: Failed to download image
 *   from https://pbs.twimg.com/media/HRJY_BmWUAAGIcZ?format=jpg&name=large
 *
 * The same URL fetched from here returns 81KB of JPEG on the first try with no
 * headers at all. Whatever pbs.twimg.com does to datacentre traffic, it is not
 * something to negotiate with from inside a reply: the bytes are three hundred
 * milliseconds away and we are the ones who found the URL.
 *
 * Falls back to the plain URL rather than failing. A provider that can fetch it
 * should be allowed to, and an agent that cannot see is a reported gap, never a
 * broken job.
 */
async function inlineImage(url: string): Promise<{ url: string; inlined: boolean; reason?: string }> {
  // Already a data URI, or something we should not be fetching.
  if (!/^https?:\/\//i.test(url)) return { url, inlined: false, reason: 'not an http url' };

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return { url, inlined: false, reason: `the image host answered ${response.status}` };

    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type.startsWith('image/')) return { url, inlined: false, reason: `the host served ${type || 'no content type'}` };

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { url, inlined: false, reason: 'the image was empty' };
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { url, inlined: false, reason: `the image is ${Math.round(bytes.byteLength / 1024)}KB, past the limit` };
    }

    return { url: `data:${type};base64,${bytes.toString('base64')}`, inlined: true };
  } catch (error) {
    return { url, inlined: false, reason: errorMessage(error) };
  }
}

/**
 * Looks at one media item with the configured vision model.
 *
 * Uses the `vision` role only. Falling back to the primary model would send an
 * image to something that cannot read it and get a confident description of
 * nothing, which is the worst available outcome.
 */
async function analyseOne(input: {
  agentId: string;
  jobId: string | null;
  kind: string;
  url: string;
  altText: string | null;
  maxCalls: number;
}): Promise<MediaUnderstanding> {
  try {
    const image = await inlineImage(input.url);
    if (!image.inlined) {
      log.debug('sending the image by url rather than inline', { url: input.url, reason: image.reason });
    }

    const result = await generate({
      agentId: input.agentId,
      jobId: input.jobId,
      purpose: 'media.describe',
      role: 'vision',
      maxCalls: input.maxCalls,
      messages: [
        {
          role: 'user',
          content: input.kind === 'gif' ? GIF_INSTRUCTION : VISION_INSTRUCTION,
          images: [{ url: image.url, label: input.altText }],
        },
      ],
    });

    const text = result.text.trim();
    // Anything that looks like it was read out of the image is worth keeping
    // separately, because OCR is the least reliable part of this and the
    // distinction lets a prompt hedge it.
    const quoted = text.match(/"([^"]{4,200})"/)?.[1] ?? null;

    return {
      description: text,
      extractedText: quoted,
      // Never full confidence. A description is one model's reading of a
      // picture, and downstream prompts say so.
      confidence: 0.7,
      analyzedBy: `${result.provider}/${result.model}`,
      status: 'analyzed',
      error: null,
    };
  } catch (error) {
    return {
      description: null,
      extractedText: null,
      confidence: 0,
      analyzedBy: null,
      status: 'failed',
      error: errorMessage(error).slice(0, 400),
    };
  }
}

export interface ResolveMediaInput {
  eventId: string;
  agentId: string;
  jobId: string | null;
  text: string;
  inventory: MediaInventory;
  /**
   * True when these attachments belong to the post being replied to rather
   * than to the mention itself. Carried through so the prompt can say whose
   * picture it is; describing somebody else's screenshot as "your image" is a
   * small lie that reads as a large one.
   */
  onParentPost?: boolean;
  policy: MediaPolicy;
  /** Ceiling on vision calls, taken from the budget policy. */
  maxCalls: number;
}

/**
 * Stores what was found, looks at what is worth looking at, and returns the
 * context the prompt will render.
 */
export async function resolveMedia(input: ResolveMediaInput): Promise<SocialMediaContext> {
  const { policy, inventory } = input;

  const stored = await mediaRepo.recordMedia(input.eventId, inventory.media);

  if (inventory.quoted && policy.resolveQuotedPosts) {
    const quotedMedia = inventory.quoted.media.length;
    await mediaRepo.recordQuote({
      eventId: input.eventId,
      remoteId: inventory.quoted.remoteId,
      remoteUrl: inventory.quoted.remoteUrl,
      authorHandle: inventory.quoted.authorHandle,
      text: inventory.quoted.text,
      // The quoted post's own media is summarised rather than analysed: it is
      // context for context, and the budget is better spent on the post itself.
      mediaSummary: quotedMedia > 0 ? `${quotedMedia} attached image${quotedMedia === 1 ? '' : 's'}` : null,
    });
  }

  for (const url of inventory.links) {
    const decision = decideLink(url, policy);
    await mediaRepo.recordLink({ eventId: input.eventId, url, ...decision });
  }

  const visionAvailable = await hasVisionModel(input.agentId);
  let looked = 0;

  for (const row of stored) {
    if (row.status === 'analyzed') continue;

    const wanted =
      (row.kind === 'image' && policy.analyzeImages) ||
      (row.kind === 'gif' && policy.analyzeGifs) ||
      (row.kind === 'video' && policy.analyzeVideo);

    if (!wanted) {
      await mediaRepo.markMediaSkipped(row.id, `${row.kind} analysis is turned off for this agent.`);
      continue;
    }
    if (looked >= policy.maxItemsPerEvent) {
      await mediaRepo.markMediaSkipped(row.id, 'Past the per-post limit on media to look at.');
      continue;
    }
    if (!row.sourceUrl) {
      await mediaRepo.markMediaSkipped(row.id, 'No retrievable URL for this item.');
      continue;
    }
    if (!visionAvailable) {
      await mediaRepo.markMediaSkipped(
        row.id,
        'This agent has no vision model configured, so images are not read. Set one under Intelligence.',
      );
      continue;
    }
    // A video is stored as its poster frame; describing one still image of a
    // video is honest about being partial and costs one call rather than many.
    looked += 1;
    const understanding = await analyseOne({
      agentId: input.agentId,
      jobId: input.jobId,
      kind: row.kind,
      url: row.sourceUrl,
      altText: row.altText,
      maxCalls: input.maxCalls,
    });
    await mediaRepo.recordUnderstanding(row.id, understanding);
  }

  return buildContext(input.eventId, input.text, input.inventory, input.onParentPost ?? false);
}

/** Turns everything stored about an event into the shape prompts render. */
export async function buildContext(
  eventId: string,
  text: string,
  inventory?: MediaInventory,
  onParentPost = false,
): Promise<SocialMediaContext> {
  const [rows, quote, links] = await Promise.all([
    mediaRepo.listMedia(eventId),
    mediaRepo.getQuote(eventId),
    mediaRepo.listLinks(eventId),
  ]);

  const items = rows.map((row) => ({
    kind: row.kind,
    position: row.position,
    description: row.description,
    extractedText: row.extractedText,
    altText: row.altText,
    status: row.status,
    confidence: row.confidence,
  }));

  // A gap is only a gap if it mattered. An undescribed image on a post that
  // explains itself is not worth stopping for.
  const unread = rows.filter((r) => r.status !== 'analyzed' && (r.kind === 'image' || r.kind === 'video'));
  const substantive = inventory ? mediaCarriesTheSubstance(text, inventory) : unread.length > 0;
  const hasGap = unread.length > 0 && substantive;

  return {
    items,
    onParentPost,
    quoted: quote
      ? { authorHandle: quote.authorHandle, text: quote.text, mediaSummary: quote.mediaSummary }
      : null,
    links: links.map((l) => ({ url: l.url, title: l.title, summary: l.summary, resolution: l.resolution })),
    hasUnderstandingGap: hasGap,
    gapDetail: hasGap
      ? `${unread.length} attached ${unread.length === 1 ? 'item was' : 'items were'} on ${onParentPost ? 'the post above' : 'this post'} and not read, and the question needs them: ${unread[0]?.error ?? 'no reason recorded'}`
      : null,
  };
}

/**
 * What to do about a link.
 *
 * Fetching an arbitrary URL found in a social post is a real network act
 * against a third party, so it happens only where policy has said it may.
 */
export function decideLink(
  url: string,
  policy: MediaPolicy,
): { resolution: string; reason: string | null; title?: null; summary?: null } {
  if (policy.linkPolicy === 'IGNORE_LINKS') {
    return { resolution: 'ignored', reason: 'This agent does not open links.' };
  }

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { resolution: 'refused', reason: 'That is not a URL this can open.' };
  }

  if (policy.linkPolicy === 'ALWAYS_RESOLVE_ALLOWED_DOMAINS') {
    const allowed = policy.allowedLinkDomains.some(
      (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
    );
    return allowed
      ? { resolution: 'metadata_only', reason: null }
      : { resolution: 'refused', reason: `${host} is not on this agent's allowed list.` };
  }

  // READ_METADATA and READ_PAGE_IF_RELEVANT both record the intent here; the
  // fetch itself is a tool call, subject to the agent's tool permissions.
  return { resolution: 'metadata_only', reason: null };
}

export { log as mediaLog };
