import { z } from 'zod';

export const ActivityEventId = z.string().toLowerCase().regex(/^(action|paper|radar|receipt):/)
  .refine((id) => z.string().uuid().safeParse(id.slice(id.indexOf(':') + 1)).success, 'The event id must contain a UUID.');
const AssetLabel = z.string().regex(/^[A-Z0-9.]{1,16}$/);
const Size = z.string().regex(/^\d{1,78}$/);
/** The status link of a post the agent published. The one shape Studio will link to. */
export const ActivityPostUrl = z.string().max(120).regex(/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}$/);
/** Owner-consented words of that post. Bounded so a long post is left out rather than cut off. */
export const ACTIVITY_POST_TEXT_MAX = 500;
export const ActivityPostText = z.string().min(1).max(ACTIVITY_POST_TEXT_MAX);
export const ActivityRadarDetail = z.object({
  asset: AssetLabel,
  source_post_url: z.string().regex(/^https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,25}$/),
}).strict();
export const ActivityTapeEvent = z.object({
  id: ActivityEventId, agent_id: z.string().uuid(),
  kind: z.enum(['REPLY', 'POST', 'PAPER_FILL', 'RADAR_HIT', 'RECEIPT']),
  at: z.string().datetime(), dry_run: z.boolean().nullable(), target_handle: z.null(),
  radar: ActivityRadarDetail.nullable().optional(),
  paper: z.object({ simulated: z.literal(true), size_base_units: Size.nullable(),
    asset: AssetLabel.nullable(), verdict: z.literal('PAPER_FILLED') }).strict().nullable(),
  // Optional, and absent rather than null when there is nothing to say, so an event
  // without them is byte for byte what an older receiver already accepts.
  post_url: ActivityPostUrl.optional(), post_text: ActivityPostText.optional(),
}).strict().superRefine((event, ctx) => {
  if (event.radar && event.kind !== 'RADAR_HIT') ctx.addIssue({ code: 'custom', message: 'Only a radar hit carries a radar source.' });
  if ((event.kind === 'PAPER_FILL') !== (event.paper !== null)) ctx.addIssue({ code: 'custom', message: 'Only a paper fill carries paper fields.' });
  if (event.post_url !== undefined && !((event.kind === 'POST' || event.kind === 'REPLY') && event.dry_run === false))
    ctx.addIssue({ code: 'custom', message: 'Only a published post or reply carries a link.' });
  if (event.post_text !== undefined && event.post_url === undefined)
    ctx.addIssue({ code: 'custom', message: 'Text travels only beside the link it belongs to.' });
});
export const ActivityTapeBatch = z.object({ protocol: z.literal(1), events: z.array(ActivityTapeEvent).max(50), remove: z.array(ActivityEventId).max(200) }).strict();
export type ActivityEvent = z.infer<typeof ActivityTapeEvent>;
