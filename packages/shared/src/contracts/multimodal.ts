import { z } from 'zod';

/**
 * What a social post can contain besides its own text.
 *
 * Kept as distinct objects rather than flattened into one string, because "the
 * question is in the second image" and "the substance is in the post being
 * quoted" are different situations and the model has to be told which.
 */
export const MEDIA_KINDS = ['image', 'gif', 'video', 'link', 'poll'] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ['pending', 'analyzed', 'skipped', 'failed', 'unsupported'] as const;
export const MediaStatus = z.enum(MEDIA_STATUSES);
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** What to do about links in a post. Fetching one is a real network act. */
export const LINK_POLICIES = [
  /** Never look. The URL is context enough. */
  'IGNORE_LINKS',
  /** Read the page's own metadata — title and description — and nothing more. */
  'READ_METADATA',
  /** Fetch the page when the post makes no sense without it. */
  'READ_PAGE_IF_RELEVANT',
  /** Always fetch, but only for domains the owner listed. */
  'ALWAYS_RESOLVE_ALLOWED_DOMAINS',
] as const;
export const LinkPolicy = z.enum(LINK_POLICIES);
export type LinkPolicy = (typeof LINK_POLICIES)[number];

/** What to do when media that mattered could not be understood. */
export const VISION_FAILURE_POLICIES = ['RETRY', 'RESPOND_TEXT_ONLY_IF_SAFE', 'REVIEW', 'IGNORE'] as const;
export const VisionFailurePolicy = z.enum(VISION_FAILURE_POLICIES);
export type VisionFailurePolicy = (typeof VISION_FAILURE_POLICIES)[number];

export const MediaPolicy = z.object({
  /** Look at images at all. Off means the agent answers on text alone. */
  analyzeImages: z.boolean().default(true),
  /** Read text inside images. Useful and frequently wrong, hence its own switch. */
  extractImageText: z.boolean().default(true),
  analyzeGifs: z.boolean().default(true),
  /** Video is expensive; metadata and captions come first, frames only if asked. */
  analyzeVideo: z.boolean().default(false),
  /** How many media items on one post are worth looking at. */
  maxItemsPerEvent: z.number().int().min(0).max(10).default(4),
  /** Frames sampled from a video, when video analysis is on. */
  maxVideoFrames: z.number().int().min(0).max(12).default(3),
  resolveQuotedPosts: z.boolean().default(true),
  linkPolicy: LinkPolicy.default('READ_METADATA'),
  allowedLinkDomains: z.array(z.string().max(253)).max(200).default([]),
  onVisionFailure: VisionFailurePolicy.default('RESPOND_TEXT_ONLY_IF_SAFE'),
  /** Keep retrieved bytes this long. 0 means never store them at all. */
  retainArtifactHours: z.number().int().min(0).max(24 * 90).default(72),
});
export type MediaPolicy = z.infer<typeof MediaPolicy>;

/** One media item as the adapter found it, before anything has looked at it. */
export const MediaCandidate = z.object({
  kind: MediaKind,
  position: z.number().int().min(0).default(0),
  sourceUrl: z.string().max(2_000).nullable().default(null),
  altText: z.string().max(2_000).nullable().default(null),
  /** Anything the platform said about it: duration, dimensions, poll options. */
  meta: z.record(z.unknown()).default({}),
});
export type MediaCandidate = z.infer<typeof MediaCandidate>;

/** A post quoted by the one being handled. */
export const QuotedPost = z.object({
  remoteId: z.string().max(300).nullable().default(null),
  remoteUrl: z.string().max(2_000).nullable().default(null),
  authorHandle: z.string().max(300).nullable().default(null),
  text: z.string().max(50_000).default(''),
  media: z.array(MediaCandidate).default([]),
});
export type QuotedPost = z.infer<typeof QuotedPost>;

/** Everything an adapter could see attached to a post. */
export const MediaInventory = z.object({
  media: z.array(MediaCandidate).default([]),
  quoted: QuotedPost.nullable().default(null),
  links: z.array(z.string().max(2_000)).default([]),
});
export type MediaInventory = z.infer<typeof MediaInventory>;

/** What was understood about one media item. */
export const MediaUnderstanding = z.object({
  description: z.string().max(4_000).nullable().default(null),
  /** Text read out of the image. Never treated as reliably correct. */
  extractedText: z.string().max(8_000).nullable().default(null),
  /** 0–1. Low confidence is shown rather than hidden. */
  confidence: z.number().min(0).max(1).default(0.5),
  analyzedBy: z.string().max(200).nullable().default(null),
  status: MediaStatus.default('analyzed'),
  error: z.string().nullable().default(null),
});
export type MediaUnderstanding = z.infer<typeof MediaUnderstanding>;

/**
 * The assembled multimodal context for one event.
 *
 * This is what the prompt layer renders, and what the trace shows. Anything the
 * agent was not able to understand appears here as an explicit gap rather than
 * being quietly omitted — pretending media was understood is worse than saying
 * it was not.
 */
export const SocialMediaContext = z.object({
  items: z
    .array(
      z.object({
        kind: MediaKind,
        position: z.number().int(),
        description: z.string().nullable(),
        extractedText: z.string().nullable(),
        altText: z.string().nullable(),
        status: MediaStatus,
        confidence: z.number().nullable(),
      }),
    )
    .default([]),
  quoted: z
    .object({
      authorHandle: z.string().nullable(),
      text: z.string(),
      mediaSummary: z.string().nullable(),
    })
    .nullable()
    .default(null),
  links: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullable(),
        summary: z.string().nullable(),
        resolution: z.string(),
      }),
    )
    .default([]),
  /** True when something that probably mattered could not be read. */
  hasUnderstandingGap: z.boolean().default(false),
  gapDetail: z.string().nullable().default(null),
});
export type SocialMediaContext = z.infer<typeof SocialMediaContext>;
