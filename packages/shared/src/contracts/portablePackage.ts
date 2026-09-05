import { z } from 'zod';
import { PortableAgent } from './portable';

/**
 * An agent as a file somebody can send.
 *
 * `PortableAgent` is the document. This is the envelope around it: what it is,
 * where it came from, what it will bring, and a checksum so a truncated
 * download is a refusal rather than a half-imported agent.
 *
 * ## Why a JSON envelope rather than a zip
 *
 * A `.ai17z-agent` file is JSON. Not because JSON is elegant here -- base64
 * attachments cost a third more than they should -- but because of what a zip
 * would invite. A zip has paths, and paths have `..`; it has entries that get
 * written to disk before anything inspects them; it needs a library to read,
 * and archive libraries are where path-traversal bugs live. An agent is a
 * persona, a policy, some settings and possibly a picture. None of that needs a
 * filesystem inside a file.
 *
 * The result is a format with **nowhere to put anything executable**. There is
 * no script field, no command, no path that gets run, no entry that becomes a
 * file at an attacker-chosen location. "Do not execute anything contained in a
 * package" is not a rule the importer has to remember: there is nothing in the
 * shape that could be executed.
 *
 * ## Two modes, and the line between them
 *
 * `SHARE` is configuration: what somebody decided. A persona, a policy, which
 * model role does what. Safe to hand to a stranger, because there is nothing in
 * it that belongs to anybody.
 *
 * `MOVE` is that plus what this agent has learned. That is not shareable and is
 * not meant to be: it is for carrying your own agent to your own new machine.
 * An agent that inherited a stranger's memories would believe things it was
 * never told.
 *
 * Neither mode carries a credential, a session or a browser profile, in the
 * strongest sense available: the shapes have nowhere to put one.
 */

/** Bumped when a change would make an older reader misread a package. */
export const AGENT_PACKAGE_VERSION = 1;

/** The extension, in one place, so the writer and the reader cannot disagree. */
export const AGENT_PACKAGE_EXTENSION = '.ai17z-agent';

export const AgentPackageMode = z.enum(['SHARE', 'MOVE']);
export type AgentPackageMode = z.infer<typeof AgentPackageMode>;

/**
 * A picture, carried inline.
 *
 * The one attachment a package has. Base64 rather than a path, because a path
 * means nothing on another machine, and inline rather than a URL because a URL
 * is a promise that somebody else's server keeps serving it.
 *
 * The bytes are still sniffed on the way in. A declared mime type in a file
 * somebody sent is a claim, and this one arrives from further away than most.
 */
export const PortableAvatar = z
  .object({
    mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    /** Base64, no data: prefix. Capped so a package cannot be a delivery vehicle. */
    base64: z.string().max(8 * 1024 * 1024),
  })
  .strict();
export type PortableAvatar = z.infer<typeof PortableAvatar>;

/**
 * What an agent has learned, for a move rather than a share.
 *
 * Memories, and nothing else. Jobs, actions, events and traces are the record
 * of an installation doing work rather than anything the agent knows, and
 * carrying them would import somebody else's history as though this machine had
 * done it.
 *
 * Relationships and stances are deliberately absent, and their absence is the
 * considered answer rather than an omission. Both are learned from what the
 * agent actually published; on a new installation they rebuild themselves from
 * the first conversation onwards. Carrying them would put a list of everyone
 * the agent has ever spoken to into a file that gets emailed around, to
 * reconstruct something that reconstructs itself.
 */
export const PortableLearned = z
  .object({
    memories: z
      .array(
        z
          .object({
            scope: z.string().max(40),
            memoryType: z.string().max(40),
            content: z.string().max(8_000),
            summary: z.string().max(1_000).nullable().default(null),
            importance: z.number().min(0).max(1).default(0.5),
            /** Who it is about, for a USER memory. Absent for every other scope. */
            aboutHandle: z.string().max(100).nullable().default(null),
          })
          .strict(),
      )
      .max(5_000)
      .default([]),
  })
  .strict();
export type PortableLearned = z.infer<typeof PortableLearned>;

export const AgentPackage = z
  .object({
    /** Says what this file is, for anything that opens it without knowing. */
    format: z.literal('ai17z-agent'),
    version: z.literal(AGENT_PACKAGE_VERSION),
    mode: AgentPackageMode,
    /** When it was written. Informational; nothing trusts it. */
    exportedAt: z.string().max(40),
    /**
     * Which AI17Z wrote it, by version.
     *
     * Not by machine, not by user, not by installation id. A package is
     * something people send each other, and a stable identifier for the sender
     * turns every shared agent into a way of learning who made it.
     */
    exportedByVersion: z.string().max(40),
    /**
     * sha256 of the canonical JSON of `agent`, `learned` and `avatar`.
     *
     * A truncated download is the common case, not an attack: the check turns
     * "half an agent, silently" into "this file is damaged". It is not a
     * signature and does not pretend to be -- anybody who can change the
     * document can change the checksum, which is exactly why the importer
     * validates the content too.
     */
    checksum: z.string().max(128),
    agent: PortableAgent,
    avatar: PortableAvatar.nullable().default(null),
    /** Present only for MOVE. A SHARE package with this set is refused. */
    learned: PortableLearned.nullable().default(null),
  })
  // Strict at every level. An unknown field is a refusal rather than something
  // that rides along into an installation nobody inspected.
  .strict();
export type AgentPackage = z.infer<typeof AgentPackage>;

/**
 * What is in a package, worked out before anything is created.
 *
 * The point of an inspection is that somebody sees what a file will do before
 * it does it. Every number here is counted from the parsed document rather than
 * read from a field the file supplies, because a self-described "0 memories"
 * would be exactly the thing worth lying about.
 */
export const AgentPackageSummary = z
  .object({
    valid: z.boolean(),
    /** Why not, in a sentence, when it is not. */
    problem: z.string().nullable().default(null),
    mode: AgentPackageMode.nullable().default(null),
    name: z.string().nullable().default(null),
    exportedAt: z.string().nullable().default(null),
    exportedByVersion: z.string().nullable().default(null),
    checksumOk: z.boolean(),
    /** Counted, never quoted. */
    counts: z.object({
      styleExamples: z.number().int(),
      models: z.number().int(),
      tools: z.number().int(),
      knowledgeSources: z.number().int(),
      memories: z.number().int(),
    }),
    hasAvatar: z.boolean(),
    /** Things worth saying out loud before somebody presses import. */
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type AgentPackageSummary = z.infer<typeof AgentPackageSummary>;
