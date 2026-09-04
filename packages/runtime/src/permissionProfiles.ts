/**
 * "What may this agent do", as four answers instead of nine checkboxes.
 *
 * The permission model underneath is already right: `agent_accounts.action_type`
 * says what an agent attempts, `agent_account_capabilities` says what it may do,
 * and both are checked at ingest and again immediately before execution. What it
 * lacked was a way to say the whole thing in one go without reading nine boxes
 * and working out which combinations mean something.
 *
 * A profile is a view over those rows, exactly as Easy Mode is a view over
 * persona and policy. There is no `permission_profile` column: the profile is
 * derived from the grants, so grants edited one at a time cannot disagree with
 * the profile shown, and an installation that never touches this file behaves
 * identically.
 *
 * The property that makes this safe, and the reason for the regression test:
 *
 *   **A profile grants what its name says and touches nothing else.**
 *
 * Switching Replies only to Replies and posts must not re-enable a tool the
 * owner turned off, must not widen which events trigger the agent, and must not
 * change its automation mode. The natural implementation -- a profile as a
 * bundle of settings applied wholesale -- gets this wrong: it carries defaults
 * for things it does not name, and every switch quietly restores them. An agent
 * whose owner disabled market lookups because it kept quoting prices at people
 * would start quoting prices at people again, and the only thing they did was
 * let it post.
 */
import type { Capability } from '@xbam/shared/contracts';
import { capabilities as capabilitiesRepo } from '@xbam/database';

export type PermissionProfile = 'MONITOR_ONLY' | 'REPLIES_ONLY' | 'REPLIES_AND_POSTS' | 'EVERYTHING' | 'CUSTOM';

interface ProfileShape {
  label: string;
  /** One sentence, in the words somebody choosing would use. */
  summary: string;
  capabilities: readonly Capability[];
  /** What the agent will attempt, for the link row. */
  actionType: 'NONE' | 'REPLY' | 'POST';
}

/**
 * The four, in increasing order of what they permit.
 *
 * READ and GENERATE are in all but the narrowest, because an agent that may not
 * generate cannot draft for review either, and "watch and show me what it would
 * have said" is the single most useful thing a new agent does.
 */
export const PROFILES: Record<Exclude<PermissionProfile, 'CUSTOM'>, ProfileShape> = {
  MONITOR_ONLY: {
    label: 'Watch only',
    summary: 'Reads and shows what it would have said. Sends nothing.',
    capabilities: ['READ', 'GENERATE'],
    actionType: 'NONE',
  },
  REPLIES_ONLY: {
    label: 'Replies only',
    summary: 'Answers people who talk to it. Never starts a conversation.',
    capabilities: ['READ', 'GENERATE', 'REPLY'],
    actionType: 'REPLY',
  },
  REPLIES_AND_POSTS: {
    label: 'Replies and posts',
    summary: 'Answers people, and says things of its own on a schedule.',
    capabilities: ['READ', 'GENERATE', 'REPLY', 'POST'],
    actionType: 'REPLY',
  },
  EVERYTHING: {
    label: 'Everything on this account',
    summary: 'Replies, posts, likes and reacts.',
    capabilities: ['READ', 'GENERATE', 'REPLY', 'POST', 'LIKE', 'REACT'],
    actionType: 'REPLY',
  },
};

/**
 * What each profile will and will not change, for the confirmation.
 *
 * The second list is the important one. Somebody switching a profile is
 * entitled to know that it is not about to undo an afternoon of settings, and
 * saying so is also what keeps the implementation honest -- every line in
 * `leaves` is something `applyProfile` provably does not write.
 */
export function describeProfile(profile: Exclude<PermissionProfile, 'CUSTOM'>): {
  label: string;
  summary: string;
  grants: string[];
  leaves: string[];
} {
  const shape = PROFILES[profile];
  const grants: string[] = [];
  grants.push(shape.capabilities.includes('READ') ? 'Read this account' : 'No reading');
  grants.push(shape.capabilities.includes('GENERATE') ? 'Write drafts' : 'No drafting');
  grants.push(shape.capabilities.includes('REPLY') ? 'Send replies' : 'No replies');
  grants.push(shape.capabilities.includes('POST') ? 'Post of its own accord' : 'No posts of its own');
  if (shape.capabilities.includes('LIKE')) grants.push('Like and react');

  return {
    label: shape.label,
    summary: shape.summary,
    grants,
    leaves: [
      'Which tools it may use, including market lookups and web search',
      'Which events it is triggered by',
      'Whether replies are held for review before sending',
      'Its posting schedule, persona, policies and limits',
    ],
  };
}

/**
 * Which profile the current grants amount to.
 *
 * Derived rather than stored. A grant edited one at a time therefore shows as
 * CUSTOM instead of quietly mislabelling itself as a profile it no longer
 * matches, and nothing has to be kept in step.
 */
export function profileOf(granted: Iterable<Capability>): PermissionProfile {
  const held = new Set(granted);
  for (const name of ['MONITOR_ONLY', 'REPLIES_ONLY', 'REPLIES_AND_POSTS', 'EVERYTHING'] as const) {
    const wanted = PROFILES[name].capabilities;
    if (wanted.length === held.size && wanted.every((capability) => held.has(capability))) return name;
  }
  return 'CUSTOM';
}

/**
 * Applies a profile to one agent-account link.
 *
 * Writes capabilities and the action type, and nothing else. Not "writes
 * defaults for everything else too": the things a profile does not name are the
 * things somebody spent time on, and a switch that resets them is a switch
 * nobody can use twice.
 *
 * Revoking is as much the point as granting. Moving from posts to replies has to
 * remove POST, or a narrower profile would be a label with nothing behind it --
 * and the capability check immediately before execution is what makes that
 * removal stop a job already queued.
 */
export async function applyProfile(input: {
  agentId: string;
  accountId: string;
  profile: Exclude<PermissionProfile, 'CUSTOM'>;
  grantedBy?: string | null;
}): Promise<{ profile: PermissionProfile; capabilities: Capability[] }> {
  const shape = PROFILES[input.profile];
  const granted = await capabilitiesRepo.setGrants(
    input.agentId,
    input.accountId,
    [...shape.capabilities],
    input.grantedBy ?? null,
  );
  return { profile: input.profile, capabilities: granted };
}

/** The profile a link currently amounts to, read from its grants. */
export async function currentProfile(agentId: string, accountId: string): Promise<PermissionProfile> {
  return profileOf(await capabilitiesRepo.grantsFor(agentId, accountId));
}
