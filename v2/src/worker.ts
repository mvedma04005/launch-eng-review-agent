import type Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isAllowedRepo, type Config } from './config.ts';
import { Mirror } from './evidence/git.ts';
import type { GitHubAuth } from './ingress/github.ts';
import type { Logger } from './log.ts';
import { metrics } from './metrics.ts';
import { isGateFile } from './policy/gate.ts';
import { minimatch } from './policy/glob.ts';
import { applyPolicy, inScope, isTeamMember, loadPolicyFile, mergePolicies, overrideBy, parsePolicy } from './policy/load.ts';
import { missingPlanSections } from './policy/plan.ts';
import type { PolicyPack } from './policy/schema.ts';
import { OctokitGitHub, type GitHubPort } from './publisher/github.ts';
import { boundBytes, LIMITS, redactorFromEnv, type Redactor } from './publisher/redact.ts';
import { renderReview, type RenderedReview } from './publisher/render.ts';
import type { Store } from './queue/store.ts';
import { Incomplete, type Reviewer } from './reviewer/claude.ts';
import type { Finding, Job, PendingPublication, PullMeta, ReviewOutput, Usage } from './types.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
// shortcut: a refused PR is not requeued on its own; re-run is manual until requeue-on-poll has a loop-safe design.
const RERUN = 'After updating the PR, post its link in the review space again to re-run Falcon.';

export interface WorkerContext {
  config: Config;
  store: Store;
  auth: GitHubAuth;
  anthropic: Anthropic;
  reviewer: Reviewer;
  log: Logger;
  /** Dry run: everything except posting to GitHub. */
  dryRun: boolean;
  /** Receives every terminal outcome (published, held, skipped, dry run) so requesters can be told. */
  notify?: (job: Job, outcome: JobOutcome & { event?: string; summary?: string; confidence?: string }) => void;
  /** Test seams. */
  githubFor?: (repo: string) => Promise<GitHubPort>;
  redactor?: Redactor;
}

export interface JobOutcome {
  status: 'published' | 'skipped' | 'held' | 'deferred' | 'dry_run';
  reason?: string;
  rendered?: RenderedReview;
  output?: ReviewOutput;
  usage?: Usage;
  reviewUrl?: string;
}

/** Per-review limits: the policy's budgets, never above the operator's ceilings. */
export function effectiveBudget(config: Config, policy: PolicyPack) {
  const cap = config.limits.perReview;
  return {
    maxInputTokens: Math.min(policy.budgets.maxInputTokens, cap.maxInputTokens),
    maxOutputTokens: Math.min(policy.budgets.maxOutputTokens, cap.maxOutputTokens),
    maxCostUsd: Math.min(policy.budgets.maxCostUsd, cap.maxCostUsd),
    maxMinutes: Math.min(policy.budgets.maxMinutes, cap.maxMinutes),
    maxToolCalls: Math.min(policy.budgets.maxToolCalls, cap.maxToolCalls),
  };
}

/** Daily spend gate. Returns the reason to defer, or null. Unpriced runs do not count, so set prices for every model in use. */
export function dailyCapReason(store: Store, config: Config, repo: string, now = new Date()): string | null {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const since = dayStart.toISOString();
  const repoSpend = store.spendSince(since, repo).usd;
  if (config.limits.daily.perRepoUsd > 0 && repoSpend >= config.limits.daily.perRepoUsd) return `daily spend cap for ${repo} reached ($${repoSpend.toFixed(2)} of $${config.limits.daily.perRepoUsd})`;
  const globalSpend = store.spendSince(since).usd;
  if (config.limits.daily.globalUsd > 0 && globalSpend >= config.limits.daily.globalUsd) return `global daily spend cap reached ($${globalSpend.toFixed(2)} of $${config.limits.daily.globalUsd})`;
  return null;
}

export function secondsUntilNextUtcDay(now = new Date()): number {
  const next = new Date(now); next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.round((next.getTime() - now.getTime()) / 1000));
}

/** Converts a rendered review into the durable form that publication retries and operator replay work from. */
export function toPending(rendered: RenderedReview, headSha: string, summary: string): PendingPublication {
  return {
    headSha, event: rendered.event, body: rendered.body, comments: rendered.comments, checkConclusion: rendered.checkConclusion,
    blockingCount: rendered.blocking.length, overridden: rendered.overridden, ...(rendered.notApproved ? { notApprovedTitle: rendered.notApproved.title } : {}), summary, attempts: 0, renderedAt: new Date().toISOString(),
  };
}

/** Secrets out, sizes bounded. Applied to everything that leaves the host. */
export function sanitize(rendered: RenderedReview, redactor: Redactor): RenderedReview {
  return {
    ...rendered,
    body: boundBytes(redactor.apply(rendered.body), LIMITS.reviewBody),
    comments: rendered.comments.map((c) => ({ ...c, body: boundBytes(redactor.apply(c.body), LIMITS.comment) })),
  };
}

/** One PR at one head, end to end. Every exit path records why, so held work is diagnosable. */
export async function processJob(ctx: WorkerContext, job: Job, owner: string): Promise<JobOutcome> {
  const log = ctx.log.child({ job: job.id, repo: job.repo, number: job.number, head: job.headSha.slice(0, 12) });
  const startedAt = Date.now();
  // Where the wall time of one review goes. Logged once per job as 'job phases'.
  const phases: Record<string, number> = {};
  let phaseMark = startedAt;
  const phase = (name: string) => { const now = Date.now(); phases[name] = (phases[name] ?? 0) + now - phaseMark; phaseMark = now; };
  const redactor = ctx.redactor ?? redactorFromEnv();
  if (job.attempts <= 1) metrics.queueWaitSeconds.observe(Math.max(0, (startedAt - Date.parse(job.createdAt)) / 1000), { repo: job.repo });
  const github = ctx.githubFor ? await ctx.githubFor(job.repo) : new OctokitGitHub(await ctx.auth.octokitFor(job.repo), await ctx.auth.botLogin());
  /** True when someone asked for this PR in Chat. Such a request is honoured for a draft, and with the poll off. */
  const askedInChat = () => ctx.store.chatRequestsForJob(job.id).length > 0;
  /** With the poll off nothing is reviewed on its own, so no message may promise that. */
  const auto = ctx.config.github.pollSeconds > 0;
  phase('auth');
  const beat = setInterval(() => ctx.store.heartbeat(job.id, owner, ctx.config.workers.leaseSeconds), 60_000);
  let worktreeDir: string | null = null;
  let mirror: Mirror | null = null;
  let checkId: number | null = null;
  let checksEnabled = false;
  try {
    if (!isAllowedRepo(ctx.config, job.repo)) return await done('skipped', `${job.repo} is not in the repository allowlist (${ctx.config.github.repos.join(', ')}).`);
    if (ctx.config.github.pollSeconds === 0 && job.trigger === 'poll' && !askedInChat()) {
      return await done('skipped', 'Automatic reviews are off. Post the PR link in the review space to request one.');
    }
    const meta = await github.pull(job.repo, job.number);
    if (meta.state !== 'open' || meta.merged) return await done('skipped', 'PR is closed or merged.');
    if (meta.draft && !askedInChat()) return await done('skipped', 'PR is a draft. Post the link in the review space to have it reviewed.');
    if (meta.headSha !== job.headSha) return await done('skipped', `Head moved to ${meta.headSha.slice(0, 12)}. ${auto ? 'A newer job covers it.' : 'Post the PR link in the review space again to review the new commit.'}`);
    if (meta.authorType === 'Bot') return await done('skipped', 'Bot-authored PR.');

    // Someone asked for a fresh review of this commit: an earlier Falcon review at this head does not stop it.
    const fresh = ctx.store.chatRequestsForJob(job.id).some((r) => r.command === 're-review' && r.status === 'queued');
    const existing = fresh ? [] : await github.ownReviews(job.repo, job.number, job.headSha);
    if (existing.length) return { ...(await done('skipped', 'Already reviewed at this head.')), reviewUrl: existing[0]!.htmlUrl };

    // A finished review that failed to publish is replayed without another model run.
    const pending = ctx.store.pending(job);
    if (pending) {
      checksEnabled = true;
      const outcome = await publish(pending, meta);
      if (outcome.status === 'published') ctx.notify?.(job, { ...outcome, event: pending.event, summary: pending.summary });
      return outcome;
    }

    const ci = await github.ci(job.repo, job.headSha, ctx.config.github.stalledCheckMinutes * 60_000);
    if (ci === 'pending') return defer(90, 'CI still running', 'ci_pending');
    if (ci === 'failure') return await done('held', `CI failed at this head. ${auto ? 'Fix CI and the next push is reviewed automatically.' : 'Fix CI, then post the PR link in the review space again.'}`);

    const capReason = dailyCapReason(ctx.store, ctx.config, job.repo);
    if (capReason) return defer(secondsUntilNextUtcDay(), capReason, 'daily_cap');

    phase('github');
    mirror = new Mirror(ctx.config.stateDir, job.repo, meta.cloneUrl, () => ctx.auth.gitTokenFor(job.repo));
    await mirror.fetchPull(job.number, job.headSha, meta.baseRef, meta.baseSha);
    phase('fetch');
    const mergeBase = await mirror.mergeBase(meta.baseSha, job.headSha);
    const anchors = await mirror.diff(mergeBase, job.headSha);
    phase('diff');
    worktreeDir = join(ctx.config.stateDir, 'worktrees', job.id);
    const worktree = await mirror.worktree(job.headSha, worktreeDir);
    phase('checkout');

    // Policy and instruction files come from the tip of the default branch: never from the PR, never from a base
    // branch its author may control, and not from the PR's recorded base commit either. That commit is where the
    // PR started, so it can be older than the rules in force today.
    const trustedSha = await mirror.fetchBranchTip(job.number, meta.defaultBranch);
    const trustedRead = (path: string) => mirrorShow(mirror!, trustedSha, path);
    const baseRead = (path: string) => mirrorShow(mirror!, mergeBase, path);
    // The first changed file that decides who may merge: the policy pack or CODEOWNERS.
    const gateFile = anchors.files.flatMap((f) => [f.path, f.oldPath]).find((p) => p === ctx.config.policy.repoPath || isGateFile(p)) ?? null;
    const loaded = await loadPolicyFor(ctx, job.repo, trustedRead);
    // The first changed path the pack keeps for a person (verdict.commentOnly), for example infrastructure.
    const humanPath = anchors.files.flatMap((f) => [f.path, f.oldPath]).find((p) => p && loaded.verdict.commentOnly.some((g) => minimatch(p, g))) ?? null;
    // A PR that edits the policy pack, CODEOWNERS or such a path is a human's call: comment only, whatever the mode.
    const policy: PolicyPack = gateFile || humanPath ? { ...loaded, verdict: { ...loaded.verdict, mode: 'comment' } } : loaded;
    checksEnabled = policy.verdict.checkRun;
    const override = overrideBy(policy, meta.author, await github.approvers(job.repo, job.number, job.headSha));
    if (!override && policy.outsiders.requirePlan && !isTeamMember(policy, meta.author)) {
      const missing = missingPlanSections(meta.body, policy.outsiders.planHeadings);
      if (missing.length) return await done('skipped', `This PR needs a short write-up before review. Add or fill in these sections in the description: ${missing.map((h) => `## ${h}`).join(', ')}. Say what problem this solves and how the change solves it, in a few sentences each. ${RERUN}`, 'block');
    }
    const budget = effectiveBudget(ctx.config, policy);
    // Deleted files are part of the change: their lines count toward the size limit and the reviewer sees them.
    const changed = anchors.files.map((f) => f.path);
    const excluded = changed.filter((p) => !inScope(policy, p));
    const inScopeFiles = changed.filter((p) => inScope(policy, p));
    if (!inScopeFiles.length) return await done('skipped', 'No in-scope files changed.');
    if (inScopeFiles.length > policy.budgets.maxChangedFiles) return await done('held', `${inScopeFiles.length} changed files exceeds the policy budget of ${policy.budgets.maxChangedFiles}.`, true);
    const changedLines = anchors.files.filter((f) => inScopeFiles.includes(f.path)).reduce((n, f) => n + f.additions + f.deletions, 0);
    if (changedLines > policy.budgets.maxChangedLines && override) return await done('skipped', `${changedLines} changed lines is over the limit of ${policy.budgets.maxChangedLines}; overridden by @${override}, not reviewed.`, 'pass');
    if (changedLines > policy.budgets.maxChangedLines) return await done('skipped', `${changedLines} changed lines exceeds the policy budget of ${policy.budgets.maxChangedLines}. Split the PR into smaller, focused PRs so the review can assess the changes and their interactions reliably. ${RERUN}`, 'block');
    const instructionDocs = await collectInstructionDocs(trustedRead, inScopeFiles, policy);
    const requiredDocs: Array<{ path: string; text: string }> = [];
    for (const p of policy.context.required) {
      const text = await trustedRead(p);
      if (text === null) return await done('held', `Required context file ${p} is missing on the default branch.`, true);
      requiredDocs.push({ path: p, text });
    }
    if (gateFile) instructionDocs.unshift({ path: '(note)', text: `This PR changes ${gateFile}. The review was governed by the default branch's version; treat the PR's version as a change under review.` });
    const prior = ctx.store.priorFingerprints(job.repo, job.number, job.headSha);
    const lessons = policy.feedback.learn ? ctx.store.lessons(job.repo, inScopeFiles, policy.feedback.maxLessons) : [];

    phase('context');
    log.info('model started');
    if (checksEnabled && !ctx.dryRun) checkId = await github.startCheckRun(job.repo, job.headSha, `Reviewing ${inScopeFiles.length} file(s), ${changedLines} changed lines, against policy ${policy.name}.`);

    const { output, usage } = await ctx.reviewer.review({
      client: ctx.anthropic, model: ctx.config.model.reviewer, effort: ctx.config.model.effort, serverSideFallback: ctx.config.model.serverSideFallback,
      policy, budget, worktree, anchors, meta, lessons, baseRead,
      onStep: (step) => ctx.store.recordStep(job.id, step),
      turn: { changedFiles: inScopeFiles, excludedFiles: excluded, instructionDocs, requiredDocs, priorOpen: [...prior.values()].map((f) => ({ path: f.path, line: f.line, title: f.title })) },
    });
    recordUsage(ctx, job, usage);
    phase('model');

    const { kept, dropped } = applyPolicy(policy, output.findings);
    for (const d of dropped) log.info({ finding: d.finding.id, reason: d.reason }, 'finding dropped by policy');
    if (policy.verdict.verifyBlocking) {
      for (const f of kept.filter((k) => k.blocking)) {
        const text = f.side === 'RIGHT' ? worktree.readText(f.path, policy.budgets.maxFileBytes) : (await baseRead(f.path)) ?? '';
        f.verified = await ctx.reviewer.verify(ctx.anthropic, ctx.config.model.verifier, f, excerpt(text, f.line));
        if (f.verified && !f.verified.real) log.info({ finding: f.id, reason: f.verified.reason }, 'verifier rejected blocking finding');
      }
    }
    phase('verify');
    // A review that does not account for every in-scope file is incomplete: medium confidence, comment-only.
    const unreviewed = inScopeFiles.filter((p) => !output.reviewedFiles.includes(p));
    if (unreviewed.length) log.info({ unreviewed }, 'review did not cover every in-scope file');
    const summary = gateFile ? `This PR changes ${gateFile}, so Falcon only comments: a human must review policy changes.\n\n${output.summary}`
      : humanPath ? `This PR changes ${humanPath}, so Falcon only comments: the policy pack keeps this path for a person's approval.\n\n${output.summary}`
      : output.summary;
    const finalOutput: ReviewOutput = { ...output, summary, findings: kept, confidence: unreviewed.length ? 'medium' : output.confidence };
    const rendered = sanitize(renderReview(policy, meta, finalOutput, anchors, prior, override), redactor);
    // The reason leads the check summary and the Chat reply, where the author looks first.
    const toPublish = toPending(rendered, job.headSha, boundBytes(redactor.apply(`${rendered.notApproved ? `${rendered.notApproved.why}\n\n` : ''}${finalOutput.summary}`), LIMITS.summary));
    ctx.store.recordFindings(job, kept);
    ctx.store.savePending(job.id, toPublish);
    phase('render');
    if (ctx.dryRun) {
      ctx.store.finish(job.id, 'skipped', { error: 'dry run: review rendered, nothing posted' });
      ctx.notify?.(job, { status: 'dry_run', summary: toPublish.summary });
      return { status: 'dry_run', rendered, output: finalOutput, usage };
    }
    const outcome = await publish(toPublish, meta);
    if (outcome.status === 'published') ctx.notify?.(job, { ...outcome, event: toPublish.event, summary: toPublish.summary, confidence: finalOutput.confidence });
    return { ...outcome, rendered, output: finalOutput, usage };
  } catch (error) {
    if (error instanceof Incomplete) return done('held', error.message, true);
    if (isTransient(error) && job.attempts < 5) return defer(60 * job.attempts, `transient: ${(error as Error).message}`, 'transient');
    metrics.errors.inc({ component: 'worker' });
    metrics.jobsFinished.inc({ repo: job.repo, outcome: 'failed' });
    log.error({ err: error }, 'job failed');
    ctx.store.finish(job.id, 'failed', { error: `${(error as Error).name}: ${(error as Error).message}` });
    await notice('neutral', 'Review failed', `${(error as Error).name}: ${redactor.apply((error as Error).message)}`);
    ctx.notify?.(job, { status: 'held', reason: `the review failed (${(error as Error).name}). The operator has the details.` });
    return { status: 'held', reason: (error as Error).message };
  } finally {
    clearInterval(beat);
    phase('other');
    if (mirror && worktreeDir) await mirror.removeWorktree(worktreeDir);
    phase('cleanup');
    log.info({ phases, totalMs: Date.now() - startedAt, attempts: job.attempts }, 'job phases');
  }

  /** Publishes a finished review. Failures keep the review and retry; after the cap, the job parks for `falcon replay`. */
  async function publish(pendingReview: PendingPublication, meta: PullMeta): Promise<JobOutcome> {
    // Dry run posts nothing, on every path. Without this, replaying a dry-run job that holds a retained review
    // would post that review for real.
    if (ctx.dryRun) {
      const reason = 'dry run: review rendered, nothing posted';
      ctx.store.finish(job.id, 'skipped', { error: reason });
      return { status: 'skipped', reason };
    }
    const fresh = await github.pull(job.repo, job.number);
    if (fresh.headSha !== job.headSha) return done('skipped', `Head moved during review. ${auto ? 'The newer head will be reviewed.' : 'Post the PR link in the review space again to review the new commit.'}`);
    if (fresh.state !== 'open' || fresh.merged || (fresh.draft && !askedInChat())) return done('skipped', 'PR closed, merged or converted to draft during review.');
    try {
      const posted = await github.postReview(job.repo, job.number, job.headSha, pendingReview);
      for (const [findingId, commentId] of posted.commentIds) ctx.store.setFindingComment(findingId, commentId);
      const title = pendingReview.blockingCount ? `${pendingReview.blockingCount} blocking finding(s)` : pendingReview.overridden ? 'Blocking findings overridden' : pendingReview.event === 'APPROVE' ? 'Approved' : pendingReview.notApprovedTitle ?? 'No blocking findings';
      const check = checksEnabled ? await github.completeCheckRun(job.repo, job.headSha, checkId, pendingReview.checkConclusion, title, pendingReview.summary, posted.htmlUrl) : null;
      ctx.store.recordReview(job.id, { githubReviewId: posted.id, checkRunId: check, event: pendingReview.event, marker: pendingReview.body.split('\n').at(-1)! });
      ctx.store.finish(job.id, 'published', { result: { reviewUrl: posted.htmlUrl, event: pendingReview.event, inlineDropped: posted.inlineDropped } });
      metrics.jobsFinished.inc({ repo: job.repo, outcome: 'published' });
      metrics.reviewsPublished.inc({ repo: job.repo, event: pendingReview.event });
      metrics.reviewSeconds.observe((Date.now() - startedAt) / 1000, { repo: job.repo });
      log.info({ url: posted.htmlUrl, event: pendingReview.event, attempts: pendingReview.attempts + 1 }, 'review published');
      return { status: 'published', reviewUrl: posted.htmlUrl };
    } catch (error) {
      const attempts = pendingReview.attempts + 1;
      ctx.store.savePending(job.id, { ...pendingReview, attempts });
      metrics.errors.inc({ component: 'publisher' });
      if (attempts >= ctx.config.workers.maxPublicationAttempts) {
        log.error({ err: error, attempts }, 'publication parked');
        return done('held', `Publication failed ${attempts} times; the finished review is retained. Run: falcon replay ${job.id}`, true);
      }
      log.warn({ err: error, attempts }, 'publication failed; will retry');
      return defer(Math.min(300, 30 * attempts), `publication retry ${attempts}: ${(error as Error).message}`, 'publish_retry');
    }
  }

  async function notice(conclusion: 'neutral' | 'action_required' | 'success', title: string, summary: string): Promise<void> {
    if (!checksEnabled || ctx.dryRun) return;
    try { await github.completeCheckRun(job.repo, job.headSha, checkId, conclusion, title, boundBytes(summary, LIMITS.summary), null); }
    catch (error) { log.warn({ err: error }, 'could not post check-run notice'); }
  }

  // Awaits its check-run notice: `run-job` exits as soon as processJob returns, which would drop a pending notice.
  async function done(status: 'skipped' | 'held', reason: string, tell: boolean | 'block' | 'pass' = false): Promise<JobOutcome> {
    // Recorded in dry run too: an unrecorded skip left the job leased, so it was retried and then marked failed.
    ctx.store.finish(job.id, status, { error: reason });
    if (!ctx.dryRun || status === 'held') {
      metrics.jobsFinished.inc({ repo: job.repo, outcome: status });
    }
    log.info({ status, reason }, 'job finished');
    if (tell === 'block') await notice('action_required', 'Changes needed', reason);
    else if (tell === 'pass') await notice('success', 'Overridden', reason);
    else if (tell) await notice('neutral', status === 'held' ? 'Review held' : 'Review not performed', reason);
    // Whoever asked for this PR in Chat hears every outcome, a quiet skip included. With no request there is nobody to tell.
    ctx.notify?.(job, { status, reason });
    return { status, reason };
  }

  function defer(seconds: number, reason: string, kind: string): JobOutcome {
    ctx.store.requeue(job.id, seconds, reason);
    metrics.deferred.inc({ repo: job.repo, reason: kind });
    log.info({ seconds, reason }, 'job deferred');
    return { status: 'deferred', reason };
  }
}

function recordUsage(ctx: WorkerContext, job: Job, usage: Usage): void {
  ctx.store.recordUsage(job, ctx.config.model.reviewer, usage);
  metrics.tokens.inc({ repo: job.repo, kind: 'input' }, usage.inputTokens);
  metrics.tokens.inc({ repo: job.repo, kind: 'cache_read' }, usage.cachedInputTokens);
  metrics.tokens.inc({ repo: job.repo, kind: 'cache_write' }, usage.cacheCreationTokens);
  metrics.tokens.inc({ repo: job.repo, kind: 'output' }, usage.outputTokens);
  if (usage.estimatedCostUsd !== null) metrics.costUsd.inc({ repo: job.repo }, usage.estimatedCostUsd);
  metrics.toolCalls.observe(usage.toolCalls, { repo: job.repo });
}

async function loadPolicyFor(ctx: WorkerContext, repo: string, trustedRead: (path: string) => Promise<string | null>): Promise<PolicyPack> {
  const packPath = isAbsolute(ctx.config.policy.defaultPack) ? ctx.config.policy.defaultPack : join(PACKAGE_ROOT, ctx.config.policy.defaultPack);
  const base = loadPolicyFile(packPath);
  const text = await trustedRead(ctx.config.policy.repoPath);
  if (!text) return base;
  try {
    return mergePolicies(base, parsePolicy(text, `${repo}:${ctx.config.policy.repoPath}`));
  } catch (error) {
    throw new Incomplete(`Repository policy on the default branch is invalid: ${(error as Error).message}`);
  }
}

async function collectInstructionDocs(trustedRead: (path: string) => Promise<string | null>, files: string[], policy: PolicyPack): Promise<Array<{ path: string; text: string }>> {
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
        const text = await trustedRead(p);
        if (text !== null) docs.push({ path: p, text: boundBytes(text, 40_000) });
      }
    }
  }
  return docs;
}

const run = promisify(execFile);
async function mirrorShow(mirror: Mirror, sha: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${sha}:${path}`], { cwd: mirror.path, maxBuffer: 64 * 1024 * 1024 });
    return stdout.includes('\0') ? null : stdout;
  } catch { return null; }
}

// 150 lines each side: with 25 the second opinion disputed every finding that needed more than one screen of code.
function excerpt(text: string, line: number, radius = 150): string {
  const lines = text.split('\n');
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}${start + i === line ? '>' : '|'}${l}`).join('\n');
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
