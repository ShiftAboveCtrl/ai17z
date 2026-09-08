import { z } from 'zod';

/**
 * Where in the interface the fix for a blocker lives.
 *
 * The API works this out and has always sent it. Every screen that renders a
 * blocker used to declare its own `{ what, fix }[]` inline and drop this field,
 * so four places told somebody an account was not connected and none of them
 * could take them to the accounts panel. `null` is a real answer: a fault in
 * AI17Z itself has nowhere useful to send anybody.
 */
export const BLOCKER_WHERES = ['account', 'models', 'persona', 'worker', 'capabilities'] as const;
export const blockerWhereSchema = z.enum(BLOCKER_WHERES).nullable();
export type BlockerWhere = z.infer<typeof blockerWhereSchema>;

/**
 * One thing stopping an agent from running, and what to do about it.
 *
 * Both fields are sentences somebody can act on. "Browser context state
 * authentication health failure" is not one.
 */
export const blockerSchema = z.object({
  what: z.string(),
  fix: z.string(),
  where: blockerWhereSchema,
});
export type Blocker = z.infer<typeof blockerSchema>;

/** The answer to "could this run right now", without changing anything. */
export const preflightResultSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(blockerSchema),
});
export type PreflightResult = z.infer<typeof preflightResultSchema>;

/**
 * The answer to "start this".
 *
 * `started: false` with blockers is not an error -- it is the check having done
 * its job. An agent that goes ACTIVE and fails on its first job has told nobody
 * anything useful.
 */
export const startResultSchema = z.object({
  started: z.boolean(),
  blockers: z.array(blockerSchema),
  state: z.string().optional(),
});
export type StartResult = z.infer<typeof startResultSchema>;
