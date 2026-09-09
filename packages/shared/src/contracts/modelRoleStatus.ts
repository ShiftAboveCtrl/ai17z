import { MODEL_ROLES, type ModelRole } from './enums';

/**
 * What each model role actually is, so the interface can stop guessing.
 *
 * A role nothing can set is a capability the product does not have. `vision`
 * proved that in the worst direction: the runtime asked for it on every image
 * and the Intelligence screen had no row for it, so every agent read pictures
 * with nothing configured and admitted it could not see them.
 *
 * `transcription` and `critic` are the other direction. Both have sat in the
 * enum since migration 0026 with no consumer anywhere -- no step asks for
 * them, no screen offers them. Adding rows to match the enum's length would
 * advertise capabilities that do not exist; leaving them undeclared is how
 * they went unnoticed for as long as they did.
 *
 * So each role says which it is, and a test holds the interface to it.
 */
export type ModelRoleStatus =
  /** The runtime asks for it, and somebody can set it. Needs a row. */
  | 'ACTIVE'
  /** Deliberately not offered: derived, or chosen by the runtime itself. */
  | 'INTERNAL'
  /** In the enum and the CHECK constraint, wired to nothing. Must have no row. */
  | 'RESERVED';

export interface ModelRoleFacts {
  status: ModelRoleStatus;
  /** Why, for anything that is not ACTIVE. Required, because "unused" is not a reason. */
  why?: string;
}

export const MODEL_ROLE_STATUS: Record<ModelRole, ModelRoleFacts> = {
  primary: { status: 'ACTIVE' },
  fallback_1: { status: 'ACTIVE' },
  fallback_2: { status: 'ACTIVE' },
  classifier: { status: 'ACTIVE' },
  vision: { status: 'ACTIVE' },
  voice_rewrite: { status: 'ACTIVE' },
  research: { status: 'ACTIVE' },
  transcription: {
    status: 'RESERVED',
    why:
      'Audio to text, for video posts. AI17Z has no audio path at all: media resolution reads ' +
      'images and video frames and never touches a soundtrack. The value stays in the enum and ' +
      'its CHECK constraint because removing one costs a migration and buys nothing.',
  },
  critic: {
    status: 'RESERVED',
    why:
      'A second model judging a candidate reply. The voice compiler does the equivalent work ' +
      'deterministically and offers `voice_rewrite` for the paid version of it, so nothing asks ' +
      'for a critic. Kept for the same reason as transcription.',
  },
};

/** The roles a person is offered. Everything else is deliberately absent. */
export const ACTIVE_MODEL_ROLES: ModelRole[] = MODEL_ROLES.filter(
  (role) => MODEL_ROLE_STATUS[role].status === 'ACTIVE',
);

/** The roles wired to nothing, named so their absence is a decision. */
export const RESERVED_MODEL_ROLES: ModelRole[] = MODEL_ROLES.filter(
  (role) => MODEL_ROLE_STATUS[role].status === 'RESERVED',
);
