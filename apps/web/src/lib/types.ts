import type {
  Account,
  ActionRecord,
  Agent,
  AgentAccountLink,
  Approval,
  ChannelId,
  JobRecord,
  MemoryRecord,
  ModelCallRecord,
  ModelConfig,
  PersonaVersion,
  PipelineEdge,
  PipelineNode,
  PolicyConfig,
  ProviderCredential,
  RetrievedMemory,
  TraceEvent,
} from '@xbam/shared/contracts';

export interface AgentStats {
  memories: number;
  accounts: number;
  jobsTotal: number;
  jobsNeedingReview: number;
  jobsFailed: number;
  lastActivityAt: string | null;
}

export interface AgentAccountRow extends AgentAccountLink {
  channel: ChannelId;
  handle: string;
  displayName: string;
  status: Account['status'];
  accountEnabled: boolean;
}

export interface AgentListItem extends Agent {
  stats: AgentStats;
  accounts: AgentAccountRow[];
}

export interface PipelineVersionRecord {
  id: string;
  version: number;
  name: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  createdAt: string;
}

export interface AgentDetail {
  agent: Agent;
  persona: PersonaVersion | null;
  policy: { id: string; version: number; config: PolicyConfig } | null;
  pipeline: PipelineVersionRecord | null;
  models: ModelConfig[];
  accounts: AgentAccountRow[];
  stats: AgentStats;
  memoryCounts: Record<string, number>;
  tools: AgentTool[];
}

export interface AgentTool {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface JobSummary extends JobRecord {
  agentName: string;
  authorHandle: string | null;
  incomingText: string;
  remoteUrl: string | null;
}

export interface DiagnosticRow {
  id: string;
  jobId: string | null;
  channel: string;
  kind: string;
  url: string | null;
  targetRef: string | null;
  message: string;
  artifactId: string | null;
  createdAt: string;
}

export interface JobDetail {
  job: JobRecord;
  event: {
    id: string;
    remoteEventId: string;
    remoteAuthorHandle: string | null;
    remoteUrl: string | null;
    text: string;
    ingestedAt: string;
  } | null;
  trace: TraceEvent[];
  modelCalls: ModelCallRecord[];
  retrievals: RetrievedMemory[];
  actions: ActionRecord[];
  approval: Approval | null;
  attempts: Array<{ attempt: number; step: string; outcome: string | null; error: string | null; startedAt: string }>;
  diagnostics: DiagnosticRow[];
}

export interface AccountRow extends Account {
  browserSession: {
    id: string;
    mode: 'MANAGED' | 'CDP';
    cdpUrl: string | null;
    status: string;
    lastCheckedAt: string | null;
    lastError: string | null;
  } | null;
  implemented: boolean;
}

export interface BrowserTask {
  id: string;
  accountId: string;
  kind: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ChannelInfo {
  id: ChannelId;
  displayName: string;
  capabilities: string[];
  requiresBrowser: boolean;
}

export interface ProviderKindInfo {
  kind: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
}

export type { Agent, MemoryRecord, PersonaVersion, PolicyConfig, ProviderCredential, ModelConfig };

export interface HealthComponentView {
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  detail: string | null;
  optional: boolean;
  checkedAt: string;
}

export interface HealthReportView {
  status: 'healthy' | 'degraded' | 'offline';
  components: HealthComponentView[];
  checkedAt: string;
}
