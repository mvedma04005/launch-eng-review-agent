import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Finding, FindingOutcome, Job, JobStatus, Lesson, ReviewRequest, Usage } from '../types.ts';

const SCHEMA = `
pragma journal_mode = WAL;
pragma synchronous = NORMAL;
pragma foreign_keys = ON;
create table if not exists jobs(
  id text primary key, repo text not null, number integer not null, head_sha text not null, base_sha text not null,
  base_ref text not null, status text not null, priority integer not null default 0, attempts integer not null default 0,
  trigger text not null, requested_by text, installation_id integer, lease_owner text, lease_until real,
  ready_after real not null default 0, created_at text not null, updated_at text not null, result_json text, error text,
  unique(repo, number, head_sha));
create index if not exists jobs_claim on jobs(status, ready_after, priority, created_at);
create table if not exists events(id integer primary key, job_id text, at text not null, kind text not null, data text);
create table if not exists findings(
  id text primary key, job_id text not null references jobs(id), repo text not null, number integer not null, head_sha text not null,
  rule_id text, severity text not null, blocking integer not null, path text not null, line integer not null, side text not null,
  fingerprint text not null, title text not null, body_json text not null, github_comment_id integer, created_at text not null);
create index if not exists findings_pr on findings(repo, number);
create index if not exists findings_fp on findings(repo, fingerprint);
create table if not exists finding_outcomes(
  id integer primary key, finding_id text not null references findings(id), signal text not null, actor text not null,
  at text not null, detail text, unique(finding_id, signal, actor));
create table if not exists reviews(
  id integer primary key, job_id text not null references jobs(id), github_review_id integer, check_run_id integer,
  event text not null, marker text not null, posted_at text not null);
create table if not exists usage(
  job_id text primary key references jobs(id), input_tokens integer, cached_input_tokens integer, output_tokens integer,
  tool_calls integer, model_calls integer, wall_ms integer, model text);
create table if not exists lessons(
  id text primary key, repo text not null, path_prefix text not null default '', text text not null, source_finding_id text,
  confidence real not null, uses integer not null default 0, created_at text not null, last_used_at text, retired_at text);
create index if not exists lessons_repo on lessons(repo, retired_at);
create table if not exists cursors(key text primary key, value text not null);
`;

const now = () => new Date().toISOString();

export interface ClaimLimits { perRepo: number; global: number }

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  /** Idempotent by (repo, number, head). A repeat request for a live job returns the existing job and records the source. */
  enqueue(request: ReviewRequest, priority = 0): { job: Job; created: boolean } {
    const existing = this.db.prepare('select * from jobs where repo=? and number=? and head_sha=?')
      .get(request.repo, request.number, request.headSha) as unknown as Row | undefined;
    if (existing) {
      this.event(existing.id, 'request_repeated', { trigger: request.trigger, by: request.requestedBy ?? null });
      return { job: toJob(existing), created: false };
    }
    const job: Job = {
      id: randomUUID(), repo: request.repo, number: request.number, headSha: request.headSha, baseSha: request.baseSha,
      baseRef: request.baseRef, status: 'queued', priority, attempts: 0, trigger: request.trigger,
      requestedBy: request.requestedBy ?? null, installationId: request.installationId ?? null,
      leaseOwner: null, leaseUntil: null, readyAfter: 0, createdAt: now(), updatedAt: now(), resultJson: null, error: null,
    };
    this.db.prepare(`insert into jobs(id,repo,number,head_sha,base_sha,base_ref,status,priority,attempts,trigger,requested_by,installation_id,ready_after,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.repo, job.number, job.headSha, job.baseSha, job.baseRef, job.status, job.priority,
      job.attempts, job.trigger, job.requestedBy, job.installationId, job.readyAfter, job.createdAt, job.updatedAt);
    // Older heads of the same PR that have not been published are obsolete.
    this.db.prepare(`update jobs set status='cancelled', updated_at=?, error='superseded by newer head' where repo=? and number=? and head_sha<>? and status in ('queued','waiting_ci')`)
      .run(now(), job.repo, job.number, job.headSha);
    this.event(job.id, 'queued', { trigger: request.trigger });
    return { job, created: true };
  }

  /**
   * Lease the next runnable job for a worker. Leases expire, so a crashed worker's job becomes claimable again
   * without any operator action. Per-repo and global caps keep one busy repository from starving others.
   */
  claim(owner: string, leaseSeconds: number, limits: ClaimLimits, nowSec = Date.now() / 1000): Job | null {
    const tx = this.db.prepare('begin immediate');
    tx.run();
    try {
      const leased = this.db.prepare(`select repo, count(*) as n from jobs where status='leased' and lease_until>? group by repo`).all(nowSec) as Array<{ repo: string; n: number }>;
      const total = leased.reduce((s, r) => s + r.n, 0);
      if (total >= limits.global) { this.db.exec('commit'); return null; }
      const busy = new Set(leased.filter((r) => r.n >= limits.perRepo).map((r) => r.repo));
      const candidates = this.db.prepare(`select * from jobs where (status in ('queued','waiting_ci') or (status='leased' and lease_until<=?)) and ready_after<=?
        order by priority desc, created_at asc limit 50`).all(nowSec, nowSec) as unknown as Row[];
      const row = candidates.find((c) => !busy.has(c.repo));
      if (!row) { this.db.exec('commit'); return null; }
      const expired = row.status === 'leased';
      this.db.prepare(`update jobs set status='leased', lease_owner=?, lease_until=?, attempts=attempts+1, updated_at=? where id=?`)
        .run(owner, nowSec + leaseSeconds, now(), row.id);
      this.db.exec('commit');
      this.event(row.id, expired ? 'lease_recovered' : 'leased', { owner });
      return toJob(this.db.prepare('select * from jobs where id=?').get(row.id) as unknown as Row);
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  heartbeat(jobId: string, owner: string, leaseSeconds: number, nowSec = Date.now() / 1000): boolean {
    const r = this.db.prepare(`update jobs set lease_until=?, updated_at=? where id=? and lease_owner=? and status='leased'`)
      .run(nowSec + leaseSeconds, now(), jobId, owner);
    return r.changes === 1;
  }

  finish(jobId: string, status: Exclude<JobStatus, 'leased' | 'queued'>, opts: { result?: unknown; error?: string; readyAfter?: number } = {}): void {
    this.db.prepare(`update jobs set status=?, lease_owner=null, lease_until=null, result_json=coalesce(?, result_json), error=?, ready_after=?, updated_at=? where id=?`)
      .run(status, opts.result === undefined ? null : JSON.stringify(opts.result), opts.error ?? null, opts.readyAfter ?? 0, now(), jobId);
    this.event(jobId, status, opts.error ? { error: opts.error } : null);
  }

  requeue(jobId: string, delaySeconds: number, reason: string): void {
    this.db.prepare(`update jobs set status='queued', lease_owner=null, lease_until=null, ready_after=?, error=?, updated_at=? where id=?`)
      .run(Date.now() / 1000 + delaySeconds, reason, now(), jobId);
    this.event(jobId, 'requeued', { reason, delaySeconds });
  }

  job(id: string): Job | null {
    const row = this.db.prepare('select * from jobs where id=?').get(id) as unknown as Row | undefined;
    return row ? toJob(row) : null;
  }

  event(jobId: string | null, kind: string, data: unknown): void {
    this.db.prepare('insert into events(job_id, at, kind, data) values(?,?,?,?)').run(jobId, now(), kind, data == null ? null : JSON.stringify(data));
  }

  recordFindings(job: Job, findings: Finding[]): void {
    const stmt = this.db.prepare(`insert or replace into findings(id,job_id,repo,number,head_sha,rule_id,severity,blocking,path,line,side,fingerprint,title,body_json,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const f of findings) {
      stmt.run(f.id, job.id, job.repo, job.number, job.headSha, f.ruleId ?? null, f.severity, f.blocking ? 1 : 0, f.path, f.line, f.side, f.fingerprint, f.title, JSON.stringify(f), now());
    }
  }

  setFindingComment(findingId: string, commentId: number): void {
    this.db.prepare('update findings set github_comment_id=? where id=?').run(commentId, findingId);
  }

  findingByComment(commentId: number): (Finding & { repo: string; number: number }) | null {
    const row = this.db.prepare('select body_json, repo, number from findings where github_comment_id=?').get(commentId) as { body_json: string; repo: string; number: number } | undefined;
    return row ? { ...(JSON.parse(row.body_json) as Finding), repo: row.repo, number: row.number } : null;
  }

  /** Findings from earlier heads of the same PR, keyed by fingerprint, so a persisting issue is reported as "still open" rather than new. */
  priorFingerprints(repo: string, number: number, excludeHead: string): Map<string, Finding> {
    const rows = this.db.prepare('select body_json from findings where repo=? and number=? and head_sha<>?').all(repo, number, excludeHead) as Array<{ body_json: string }>;
    const map = new Map<string, Finding>();
    for (const r of rows) { const f = JSON.parse(r.body_json) as Finding; map.set(f.fingerprint, f); }
    return map;
  }

  recordOutcome(outcome: FindingOutcome): boolean {
    const r = this.db.prepare('insert or ignore into finding_outcomes(finding_id, signal, actor, at, detail) values(?,?,?,?,?)')
      .run(outcome.findingId, outcome.signal, outcome.actor, outcome.at, outcome.detail ?? null);
    return r.changes === 1;
  }

  outcomes(findingId: string): FindingOutcome[] {
    return (this.db.prepare('select * from finding_outcomes where finding_id=? order by at').all(findingId) as Array<{ finding_id: string; signal: string; actor: string; at: string; detail: string | null }>)
      .map((r) => ({ findingId: r.finding_id, signal: r.signal as FindingOutcome['signal'], actor: r.actor, at: r.at, detail: r.detail ?? undefined }));
  }

  recordReview(jobId: string, review: { githubReviewId: number | null; checkRunId: number | null; event: string; marker: string }): void {
    this.db.prepare('insert into reviews(job_id, github_review_id, check_run_id, event, marker, posted_at) values(?,?,?,?,?,?)')
      .run(jobId, review.githubReviewId, review.checkRunId, review.event, review.marker, now());
  }

  recordUsage(jobId: string, model: string, usage: Usage): void {
    this.db.prepare(`insert or replace into usage(job_id,input_tokens,cached_input_tokens,output_tokens,tool_calls,model_calls,wall_ms,model) values(?,?,?,?,?,?,?,?)`)
      .run(jobId, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.toolCalls, usage.modelCalls, usage.wallMs, model);
  }

  addLesson(lesson: Omit<Lesson, 'id' | 'uses' | 'createdAt' | 'lastUsedAt' | 'retiredAt'>): Lesson {
    const full: Lesson = { ...lesson, id: randomUUID(), uses: 0, createdAt: now(), lastUsedAt: null, retiredAt: null };
    this.db.prepare('insert into lessons(id,repo,path_prefix,text,source_finding_id,confidence,uses,created_at) values(?,?,?,?,?,?,0,?)')
      .run(full.id, full.repo, full.pathPrefix, full.text, full.sourceFindingId, full.confidence, full.createdAt);
    return full;
  }

  /** Active lessons for a repository, most useful first; `paths` narrows to lessons whose prefix matches a changed file. */
  lessons(repo: string, paths: string[], limit: number): Lesson[] {
    const rows = this.db.prepare('select * from lessons where repo=? and retired_at is null order by confidence desc, uses desc, created_at desc').all(repo) as unknown as LessonRow[];
    const picked = rows.filter((l) => l.path_prefix === '' || paths.some((p) => p.startsWith(l.path_prefix))).slice(0, limit);
    if (picked.length) {
      const stmt = this.db.prepare('update lessons set uses=uses+1, last_used_at=? where id=?');
      for (const l of picked) stmt.run(now(), l.id);
    }
    return picked.map(toLesson);
  }

  retireLesson(id: string): void { this.db.prepare('update lessons set retired_at=? where id=?').run(now(), id); }

  cursor(key: string): string | null {
    const row = this.db.prepare('select value from cursors where key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setCursor(key: string, value: string): void { this.db.prepare('insert or replace into cursors(key,value) values(?,?)').run(key, value); }

  counts(): Record<string, number> {
    const rows = this.db.prepare('select status, count(*) as n from jobs group by status').all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

interface Row {
  id: string; repo: string; number: number; head_sha: string; base_sha: string; base_ref: string; status: string; priority: number;
  attempts: number; trigger: string; requested_by: string | null; installation_id: number | null; lease_owner: string | null;
  lease_until: number | null; ready_after: number; created_at: string; updated_at: string; result_json: string | null; error: string | null;
}
interface LessonRow {
  id: string; repo: string; path_prefix: string; text: string; source_finding_id: string | null; confidence: number; uses: number;
  created_at: string; last_used_at: string | null; retired_at: string | null;
}
function toJob(r: Row): Job {
  return {
    id: r.id, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, baseRef: r.base_ref, status: r.status as JobStatus,
    priority: r.priority, attempts: r.attempts, trigger: r.trigger as Job['trigger'], requestedBy: r.requested_by, installationId: r.installation_id,
    leaseOwner: r.lease_owner, leaseUntil: r.lease_until, readyAfter: r.ready_after, createdAt: r.created_at, updatedAt: r.updated_at,
    resultJson: r.result_json, error: r.error,
  };
}
function toLesson(r: LessonRow): Lesson {
  return { id: r.id, repo: r.repo, pathPrefix: r.path_prefix, text: r.text, sourceFindingId: r.source_finding_id, confidence: r.confidence,
    uses: r.uses, createdAt: r.created_at, lastUsedAt: r.last_used_at, retiredAt: r.retired_at };
}
