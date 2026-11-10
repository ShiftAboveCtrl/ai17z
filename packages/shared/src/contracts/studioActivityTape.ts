import { z } from 'zod';

export const ActivityEventId = z.string().toLowerCase().regex(/^(action|paper|radar|receipt):/)
  .refine((id) => z.string().uuid().safeParse(id.slice(id.indexOf(':') + 1)).success, 'The event id must contain a UUID.');
const AssetLabel = z.string().regex(/^[A-Z0-9.]{1,16}$/);
const Size = z.string().regex(/^\d{1,78}$/);
export const ActivityTapeEvent = z.object({
  id: ActivityEventId, agent_id: z.string().uuid(),
  kind: z.enum(['REPLY', 'POST', 'PAPER_FILL', 'RADAR_HIT', 'RECEIPT']),
  at: z.string().datetime(), dry_run: z.boolean().nullable(), target_handle: z.null(),
  paper: z.object({ simulated: z.literal(true), size_base_units: Size.nullable(),
    asset: AssetLabel.nullable(), verdict: z.literal('PAPER_FILLED') }).strict().nullable(),
}).strict().superRefine((event, ctx) => {
  if ((event.kind === 'PAPER_FILL') !== (event.paper !== null)) ctx.addIssue({ code: 'custom', message: 'Only a paper fill carries paper fields.' });
});
export const ActivityTapeBatch = z.object({ protocol: z.literal(1), events: z.array(ActivityTapeEvent).max(50), remove: z.array(ActivityEventId).max(200) }).strict();
export type ActivityEvent = z.infer<typeof ActivityTapeEvent>;
