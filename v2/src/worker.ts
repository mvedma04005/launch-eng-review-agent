import type Anthropic from '@anthropic-ai/sdk';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import { Mirror } from './evidence/git.ts';
import type { GitHubAuth } from './ingress/github.ts';
import type { Logger } from './log.ts';
import { applyPolicy, inScope, loadPolicyFile, mergePolicies, parsePolicy } from './policy/load.ts';
import type { PolicyPack } from './policy/schema.ts';
import { OctokitGitHub, type GitHubPort } from './publisher/github.ts';
import { renderReview, type RenderedReview } from './publisher/render.ts';
import type { Store } from './queue/store.ts';
import { Incomplete, type Reviewer } from './reviewer/claude.ts';
import type { Finding, Job, PullMeta, ReviewOutput, Usage } from './types.ts';

export interface WorkerContext {
  config: Config;
  store: Store;
  auth: GitHubAuth;
  anthropic: Anthropic;
  reviewer: Reviewer;
  log: Logger;
  /** Dry run: everything except posting to GitHub. */
  dryRun: boolean;
  /** Test seam. */
  githubFor?: (repo: string) => Promise<GitHubPort>;
}

export interface JobOutcome {
  status: 'published' | 'skipped' | 'held' | 'waiting_ci' | 'dry_run';
  reason?: string;
  rendered?: RenderedReview;
  output?: ReviewOutput;
  usage?: Usage;
  reviewUrl?: string;
}

/** One PR at one head, end to end. Every exit path records why, so held work is diagnosable. */
export async function processJob(ctx: WorkerContext, job: Job, owner: string): Promise<JobOutcome> {
  const log = ctx.log.child({ job: job.id, repo: job.repo, number: job.number, head: job.headSha.slice(0, 12) });
  const github = ctx.githubFor ? await ctx.githubFor(job.repo) : new OctokitGitHub(await ctx.auth.octokitFor(job.repo), await ctx.auth.botLogin());
  const beat = setInterval(() => ctx.store.heartbeat(job.id, owner, ctx.config.workers.leaseSeconds), 60_000);
  try {
    const meta = await github.pull(job.repo, job.number);
    if (meta.state !== 'open' || meta.merged) return done('skipped', 'PR is closed or merged.');
    if (meta.draft) return done('skipped', 'PR is a draft; it will be reviewed when marked ready.');
    if (meta.headSha !== job.headSha) return done('skipped', `Head moved to ${meta.headSha.slice(0, 12)}; a newer job covers it.`);
    if (meta.authorType === 'Bot') return done('skipped', 'Bot-authored PR.');

    const existing = await github.ownReviews(job.repo, job.number, job.headSha);
    if (existing.length) return { ...done('skipped', 'Already reviewed at this head.'), reviewUrl: existing[0]!.htmlUrl };

    const ci = await github.ci(job.repo, job.headSha);
    if (ci === 'pending') { ctx.store.requeue(job.id, 90, 'CI still running'); return { status: 'waiting_ci' }; }
    if (ci === 'failure') return done('held', 'CI failed at this head; fix CI and the next push is reviewed automatically.');

    const mirror = new Mirror(ctx.config.stateDir, job.repo, meta.cloneUrl, () => ctx.auth.gitTokenFor(job.repo));
    await mirror.fetchPull(job.number, job.headSha, meta.baseRef, meta.baseSha);
    const mergeBase = await mirror.mergeBase(meta.baseSha, job.headSha);
    const anchors = await mirror.diff(mergeBase, job.headSha);
    const worktreeDir = join(ctx.config.stateDir, 'worktrees', job.id);
    const worktree = await mirror.worktree(job.headSha, worktreeDir);
    try {
      const policy = await loadPolicyFor(ctx, job.repo, (p) => worktree.exists(p) ? worktree.readText(p, 200_000) : null);
      const changed = anchors.files.filter((f) => f.status !== 'removed').map((f) => f.path);
      const excluded = changed.filter((p) => !inScope(policy, p));
      const inScopeFiles = changed.filter((p) => inScope(policy, p));
      if (!inScopeFiles.length) return done('skipped', 'No in-scope files changed.');
      if (inScopeFiles.length > policy.budgets.maxChangedFiles) return done('held', `${inScopeFiles.length} changed files exceeds the policy budget of ${policy.budgets.maxChangedFiles}.`);
      const baseRead = async (path: string) => { try { return await mirrorShow(mirror, mergeBase, path); } catch { return null; } };
      const instructionDocs = collectInstructionDocs(worktree, inScopeFiles, policy);
      const requiredDocs: Array<{ path: string; text: string }> = [];
      for (const p of policy.context.required) {
        if (!worktree.exists(p)) return done('held', `Required context file ${p} is missing at the head commit.`);
        requiredDocs.push({ path: p, text: worktree.readText(p, 200_000) });
      }
      const prior = ctx.store.priorFingerprints(job.repo, job.number, job.headSha);
      const lessons = policy.feedback.learn ? ctx.store.lessons(job.repo, inScopeFiles, policy.feedback.maxLessons) : [];

      const { output, usage } = await ctx.reviewer.review({
        client: ctx.anthropic, model: ctx.config.model.reviewer, effort: ctx.config.model.effort, serverSideFallback: ctx.config.model.serverSideFallback,
        policy, worktree, anchors, meta, lessons, baseRead,
        turn: { changedFiles: inScopeFiles, excludedFiles: excluded, instructionDocs, requiredDocs,
          priorOpen: [...prior.values()].map((f) => ({ path: f.path, line: f.line, title: f.title })) },
      });
      ctx.store.recordUsage(job.id, ctx.config.model.reviewer, usage);

      const { kept, dropped } = applyPolicy(policy, output.findings);
      for (const d of dropped) log.info({ finding: d.finding.id, reason: d.reason }, 'finding dropped by policy');
      if (policy.verdict.verifyBlocking) {
        for (const f of kept.filter((k) => k.blocking)) {
          const text = f.side === 'RIGHT' ? worktree.readText(f.path, policy.budgets.maxFileBytes) : (await baseRead(f.path)) ?? '';
          f.verified = await ctx.reviewer.verify(ctx.anthropic, ctx.config.model.verifier, f, excerpt(text, f.line));
          if (f.verified && !f.verified.real) log.info({ finding: f.id, reason: f.verified.reason }, 'verifier rejected blocking finding');
        }
      }
      const finalOutput: ReviewOutput = { ...output, findings: kept };
      const rendered = renderReview(policy, meta, finalOutput, anchors, prior);
      ctx.store.recordFindings(job, kept);
      if (ctx.dryRun) return { status: 'dry_run', rendered, output: finalOutput, usage };

      const fresh = await github.pull(job.repo, job.number);
      if (fresh.headSha !== job.headSha) return done('skipped', 'Head moved during review; the newer head will be reviewed.');
      if (fresh.state !== 'open' || fresh.merged || fresh.draft) return done('skipped', 'PR closed, merged or converted to draft during review.');
      const posted = await github.postReview(job.repo, job.number, job.headSha, rendered);
      for (const [findingId, commentId] of posted.commentIds) ctx.store.setFindingComment(findingId, commentId);
      const checkId = policy.verdict.checkRun
        ? await github.checkRun(job.repo, job.headSha, rendered.checkConclusion, rendered.blocking.length ? `${rendered.blocking.length} blocking finding(s)` : 'No blocking findings', finalOutput.summary.slice(0, 60_000), posted.htmlUrl)
        : null;
      ctx.store.recordReview(job.id, { githubReviewId: posted.id, checkRunId: checkId, event: rendered.event, marker: rendered.body.split('\n').at(-1)! });
      ctx.store.finish(job.id, 'published', { result: { reviewUrl: posted.htmlUrl, event: rendered.event, findings: kept.length, inlineDropped: posted.inlineDropped } });
      log.info({ url: posted.htmlUrl, event: rendered.event, findings: kept.length, usage }, 'review published');
      return { status: 'published', rendered, output: finalOutput, usage, reviewUrl: posted.htmlUrl };
    } finally {
      await mirror.removeWorktree(worktreeDir);
    }
  } catch (error) {
    if (error instanceof Incomplete) return done('held', error.message);
    const transient = isTransient(error);
    if (transient && job.attempts < 5) { ctx.store.requeue(job.id, 60 * job.attempts, `transient: ${(error as Error).message}`); return { status: 'waiting_ci', reason: (error as Error).message }; }
    log.error({ err: error }, 'job failed');
    ctx.store.finish(job.id, 'failed', { error: `${(error as Error).name}: ${(error as Error).message}` });
    return { status: 'held', reason: (error as Error).message };
  } finally {
    clearInterval(beat);
  }

  function done(status: 'skipped' | 'held', reason: string): JobOutcome {
    if (!ctx.dryRun || status === 'held') ctx.store.finish(job.id, status, { error: reason });
    log.info({ status, reason }, 'job finished');
    return { status, reason };
  }
}

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadPolicyFor(ctx: WorkerContext, repo: string, readAtHead: (path: string) => string | null): Promise<PolicyPack> {
  const packPath = isAbsolute(ctx.config.policy.defaultPack) ? ctx.config.policy.defaultPack : join(PACKAGE_ROOT, ctx.config.policy.defaultPack);
  const base = loadPolicyFile(packPath);
  const text = readAtHead(ctx.config.policy.repoPath);
  if (!text) return base;
  try {
    return mergePolicies(base, parsePolicy(text, `${repo}:${ctx.config.policy.repoPath}`));
  } catch (error) {
    throw new Incomplete(`Repository policy is invalid: ${(error as Error).message}`);
  }
}

function collectInstructionDocs(worktree: import('./evidence/git.ts').Worktree, files: string[], policy: PolicyPack): Array<{ path: string; text: string }> {
  const seen = new Set<string>();
  const docs: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const dir = parts.slice(0, depth).join('/');
      for (const name of policy.context.instructionFiles) {
        const p = dir ? `${dir}/${name}` : name;
        if (seen.has(p)) continue;
        seen.add(p);
        if (worktree.exists(p)) docs.push({ path: p, text: worktree.readText(p, 100_000) });
      }
    }
  }
  return docs;
}

async function mirrorShow(mirror: Mirror, sha: string, path: string): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('git', ['show', `${sha}:${path}`], { cwd: mirror.path, maxBuffer: 64 * 1024 * 1024 });
    return stdout.includes('\0') ? null : stdout;
  } catch { return null; }
}

function excerpt(text: string, line: number, radius = 25): string {
  const lines = text.split('\n');
  const start = Math.max(1, line - radius), end = Math.min(lines.length, line + radius);
  return lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}${start + i === line ? '>' : '│'}${l}`).join('\n');
}

function isTransient(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status && (status === 429 || status >= 500)) return true;
  const code = (error as { code?: string }).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
}

export function findingsSummary(findings: Finding[]): string {
  return findings.map((f) => `${f.blocking ? 'BLOCK' : 'note '} ${f.severity.padEnd(8)} ${f.path}:${f.line} ${f.title}`).join('\n');
}
export type { PullMeta };
