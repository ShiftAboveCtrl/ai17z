import { z } from 'zod';
import { PersonaDraft } from './persona';
import { PolicyConfig } from './policy';

export const RegressionCandidate = z.object({ persona: PersonaDraft.optional(), policy: PolicyConfig.optional() }).strict();
export type RegressionCandidate = z.infer<typeof RegressionCandidate>;
export const REGRESSION_TRIGGERS = ['MANUAL', 'PERSONA', 'POLICY', 'MODEL', 'PREVIEW'] as const;
export type RegressionTrigger = typeof REGRESSION_TRIGGERS[number];
export const RegressionChecks = z.object({
  mustBeSilent: z.boolean().optional(), silentOk: z.boolean().optional(),
  forbid: z.array(z.string().max(500)).max(100).optional(),
  requireOneOf: z.array(z.string().max(500)).max(100).optional(),
  language: z.enum(['zh', 'en']).optional(), maxChars: z.number().int().positive().optional(),
}).strict();
export type RegressionChecks = z.infer<typeof RegressionChecks>;
export interface RegressionSubject {
  channel: 'x' | 'mock'; authorHandle: string; text: string;
  remoteId?: string | null; url?: string | null; authorId?: string | null; authorName?: string | null;
  parentText?: string | null; parentRemoteId?: string | null; conversationRef?: string | null;
  occurredAt?: string | null; gaps?: string[]; as?: 'MENTION' | 'KEYWORD_MATCH' | 'TARGET_ACCOUNT_ACTIVITY';
  authorFollowers?: number | null; metrics?: Record<string, number> | null;
}
export interface DecisionDigest {
  decision: 'ANSWERED' | 'SILENT' | 'REVIEW' | 'FAILED'; silenceReason?: string | null;
  answer: string | null; draft: string | null;
  validator: { outcome: string; detail: string }; voice: { outcome: string; detail: string }; worth: { outcome: string; detail: string };
  personaVersionId: string | null; policyVersionId: string | null;
  modelRoles: { role: string; model: string; providerCredentialId: string; parameters: unknown }[];
}
export interface RegressionCase {
  id: string; agentId: string; title: string; subject: RegressionSubject; sourceJobId: string | null;
  checks: RegressionChecks; baseline: DecisionDigest; createdBy: string | null; createdAt: string; archivedAt: string | null;
}
export interface RegressionRun {
  id: string; agentId: string; trigger: RegressionTrigger; candidate: RegressionCandidate | null;
  baselineRunId: string | null; createdAt: string; finishedAt: string | null;
}
export interface RegressionResult {
  runId: string; caseId: string; jobId: string | null; error: string | null; digest: DecisionDigest | null;
  baseline: DecisionDigest; checks: RegressionChecks; title: string;
}
