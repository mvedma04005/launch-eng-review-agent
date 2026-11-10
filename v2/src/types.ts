/** Domain types shared across the engine. Keep this file dependency-free. */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export type Side = 'LEFT' | 'RIGHT';

export type Trigger = 'opened' | 'synchronize' | 'ready_for_review' | 'reopened' | 'comment' | 'manual' | 'poll' | 'retry';

export interface ReviewRequest {
  /** "owner/name" */
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  trigger: Trigger;
  requestedBy?: string | undefined;
  installationId?: number | undefined;
  receivedAt: string;
}

export interface PullMeta {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  authorType: 'User' | 'Bot' | string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  labels: string[];
  htmlUrl: string;
  cloneUrl: string;
}

export interface Finding {
  /** Stable id within the review, assigned by the host. */
  id: string;
  ruleId?: string | undefined;
  severity: Severity;
  blocking: boolean;
  path: string;
  line: number;
  side: Side;
  title: string;
  scenario: string;
  impact: string;
  evidence: string;
  fix: string;
  /** Host-computed; stable across heads when the same issue persists. */
  fingerprint: string;
  /** Set by the verifier pass. */
  verified?: { real: boolean; confidence: number; reason: string } | undefined;
}

export interface ReviewOutput {
  summary: string;
  /** Medium confidence means a material question remains; the verdict is then comment-only regardless of policy mode. */
  confidence: 'high' | 'medium';
  findings: Finding[];
  reviewedFiles: string[];
  lenses: string[];
  /** Model-reported open questions that are not findings. */
  questions: string[];
}

export type Verdict = 'approve' | 'request_changes' | 'comment';

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  toolCalls: number;
  modelCalls: number;
  wallMs: number;
  /** Null when the model has no price entry. */
  estimatedCostUsd: number | null;
}

export type JobStatus =
  | 'queued' | 'leased' | 'waiting_ci' | 'published' | 'skipped' | 'held' | 'cancelled' | 'failed';

export interface Job {
  id: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  trigger: Trigger;
  requestedBy: string | null;
  installationId: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  readyAfter: number;
  createdAt: string;
  updatedAt: string;
  resultJson: string | null;
  error: string | null;
}

export type FeedbackSignal =
  | 'thumbs_up' | 'thumbs_down' | 'reply_agree' | 'reply_disagree' | 'reply_question'
  | 'resolved' | 'line_changed_next_push' | 'merged_unaddressed' | 'dismissed' | 'command_ignore' | 'command_wrong';

export interface FindingOutcome {
  findingId: string;
  signal: FeedbackSignal;
  actor: string;
  at: string;
  detail?: string | undefined;
}

export interface Lesson {
  id: string;
  repo: string;
  pathPrefix: string;
  text: string;
  sourceFindingId: string | null;
  confidence: number;
  uses: number;
  createdAt: string;
  lastUsedAt: string | null;
  retiredAt: string | null;
}
