import { z } from 'zod';

/**
 * The share card an agent posts for its public home, and the owner's pitch it
 * carries.
 *
 * ## The pitch is the owner's words
 *
 * The pitch is a one-line sentence the owner wrote and approved. It is stored
 * here and passed through `reticence` before any post is proposed, exactly like
 * every other unprompted subject. It is length-capped and single-line so a
 * pitch cannot smuggle a second thought past the gate.
 *
 * ## Core never fabricates a title or an image
 *
 * This share shape carries the url, the pitch and a fixed disclosure. It has
 * no slot for a title, a description or an image. The preview a platform draws
 * for the link comes from the Open Graph metadata Studio serves on the public
 * home page itself. Core composing its own title or image would be a second,
 * competing description of the same page, and this contract deliberately has
 * nowhere to put one.
 *
 * ## The disclosure is not optional
 *
 * The disclosure is a literal, not a field somebody fills in, so a share card
 * always identifies an AI agent and simulated paper results. A card that does
 * not say both is refused by the schema rather than by a caller remembering to
 * add them.
 */

/** How long the owner's pitch may be. One line, so a pitch is a pitch. */
export const PUBLIC_HOME_PITCH_MAX = 160;

/** The owner-approved one-line pitch. Trimmed, single-line, non-empty. */
export const PublicHomePitch = z
  .string()
  .trim()
  .min(1)
  .max(PUBLIC_HOME_PITCH_MAX)
  .refine((value) => !/[\r\n]/.test(value), 'a single line');

/**
 * The fixed disclosure every share card carries. It is the identification the
 * send gate checks, written here rather than in two places.
 */
export const PUBLIC_HOME_DISCLOSURE = 'An AI agent. Any trading results shown are simulated paper results.';

/**
 * The exact exported share shape. Strict, so a credential, a memory or an
 * account identity has no field to land in: adding one is a refusal of the
 * whole card, not a field quietly ignored.
 */
export const PublicHomeShare = z
  .object({
    protocol: z.literal(1),
    identity: z.literal('AI_AGENT'),
    simulated: z.literal(true),
    /** The published public home. Only the current, confirmed url is ever shared. */
    url: z.url().max(300),
    pitch: PublicHomePitch,
    disclosure: z.literal(PUBLIC_HOME_DISCLOSURE),
  })
  .strict();
export type PublicHomeShare = z.infer<typeof PublicHomeShare>;
