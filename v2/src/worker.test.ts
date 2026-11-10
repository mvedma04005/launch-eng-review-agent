import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigSchema } from './config.ts';
import { log } from './log.ts';
import type { CheckConclusion, GitHubPort, Publishable } from './publisher/github.ts';
import { buildRedactor } from './publisher/redact.ts';
import { Store } from './queue/store.ts';
import type { Reviewer } from './reviewer/claude.ts';
import type { PullMeta } from './types.ts';
import { processJob, type WorkerContext } from './worker.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** Base branch carries the trusted policy (request_changes). The PR tries to rewrite it to exclude everything. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'falcon-worker-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'CLAUDE.md'), '# Conventions\nUse the shared client.\n');
  writeFileSync(join(origin, 'svc.py'), 'def handler(user):\n    return user\n');
  writeFileSync(join(origin, 'package-lock.json'), '{}\n');
  mkdirSync(join(origin, '.falcon'));
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nverdict: { mode: request_changes }\nsuppressions:\n  - { rule: noisy-rule, paths: ["**"], reason: test }\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(origin, 'svc.py'), 'def handler(user):\n    return user.name\n');
  writeFileSync(join(origin, 'package-lock.json'), '{"changed": true}\n');
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: attacker\nverdict: { mode: comment }\nscope: { exclude: ["**"] }\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'change');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/3/head', headSha);
  git(origin, 'checkout', '-q', 'main');
  return { root, origin, baseSha, headSha };
}

class FakeGitHub implements GitHubPort {
  posted: Publishable[] = [];
  checks: Array<{ status: 'in_progress' | 'completed'; conclusion?: CheckConclusion; title?: string; id: number | null }> = [];
  approversByHead = new Map<string, string[]>();
  failPostsRemaining = 0;
  meta: PullMeta;
  ciState: 'none' | 'pending' | 'success' | 'failure';
  existing: Array<{ id: number; htmlUrl: string }> = [];
  private nextCheckId = 500;
  constructor(meta: PullMeta, ciState: 'none' | 'pending' | 'success' | 'failure' = 'success') { this.meta = meta; this.ciState = ciState; }
  async pull() { return this.meta; }
  async ci() { return this.ciState; }
  async ownReviews() { return this.existing; }
  async approvers(_r: string, _n: number, headSha: string) { return this.approversByHead.get(headSha) ?? []; }
  async postReview(_r: string, _n: number, _h: string, review: Publishable) {
    if (this.failPostsRemaining > 0) { this.failPostsRemaining--; const e = new Error('bad gateway') as Error & { status: number }; e.status = 502; throw e; }
    this.posted.push(review);
    return { id: 1, htmlUrl: 'https://example.test/review/1', inlineDropped: false, commentIds: new Map(review.comments.map((c, i) => [c.findingId, 100 + i])) };
  }
  async startCheckRun() { const id = this.nextCheckId++; this.checks.push({ status: 'in_progress', id }); return id; }
  async completeCheckRun(_r: string, _h: string, id: number | null, conclusion: CheckConclusion, title: string) { this.checks.push({ status: 'completed', conclusion, title, id }); return id ?? this.nextCheckId++; }
  async fileAtRef() { return null; }
}

const auth = { mode: 'token' as const, octokitFor: async () => { throw new Error('unused'); }, gitTokenFor: async () => 'tok', botLogin: async () => 'falcon[bot]', installationIdFor: async () => null };
const meta = (origin: string, headSha: string, baseSha: string, over: Partial<PullMeta> = {}): PullMeta => ({
  repo: 'acme/demo', number: 3, title: 'Use name', body: 'desc', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha, baseSha,
  baseRef: 'main', headRef: 'feature', changedFiles: 3, additions: 2, deletions: 2, labels: [], htmlUrl: 'https://example.test/pr/3', cloneUrl: origin, ...over,
});
const configFor = (root: string) => ConfigSchema.parse({ stateDir: join(root, 'state'), github: { repos: ['acme/demo'] }, policy: { defaultPack: new URL('../policies/default.yaml', import.meta.url).pathname } });

function fakeReviewer(findings: Array<{ path: string; line: number; evidence: string; severity: 'critical' | 'high' | 'medium'; ruleId?: string }>, calls: { n: number }): Reviewer {
  return {
    async review(opts) {
      calls.n++;
      assert.ok(opts.turn.changedFiles.includes('svc.py'), 'svc.py stays in scope: the PR cannot exclude itself');
      assert.ok(!opts.turn.changedFiles.includes('package-lock.json'), 'lockfile excluded by the engine pack');
      assert.equal(opts.policy.verdict.mode, 'request_changes', 'the base branch policy governs, not the PR copy');
      assert.ok(opts.turn.instructionDocs.some((d) => d.path === 'CLAUDE.md'), 'instruction files come from the base branch');
      assert.ok(opts.turn.instructionDocs.some((d) => d.path === '(note)' && /changes \.falcon\/policy\.yaml/.test(d.text)), 'the reviewer is told the PR edits the policy');
      opts.onStep?.({ seq: 1, at: new Date().toISOString(), tool: 'read_file', input: 'svc.py', durationMs: 3, outcome: 'ok' });
      return {
        output: {
          summary: 'Null user crashes handler. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', confidence: 'high', reviewedFiles: opts.turn.changedFiles, lenses: opts.policy.lenses, questions: [],
          findings: findings.map((f, i) => ({ id: `f${i}`.padEnd(12, '0'), ruleId: f.ruleId, severity: f.severity, blocking: false, path: f.path, line: f.line, side: 'RIGHT' as const, title: `Finding ${i}`, scenario: 's', impact: 'i', evidence: f.evidence, fix: 'guard', fingerprint: `fp${i}` })),
        },
        usage: { inputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 5, toolCalls: 3, modelCalls: 1, wallMs: 10, estimatedCostUsd: 0.0001 },
      };
    },
    async verify(_c, _m, finding) { return { real: finding.line === 2, confidence: 0.9, reason: finding.line === 2 ? 'confirmed' : 'line 1 is the signature' }; },
  };
}

test('worker runs a PR end to end: base-branch policy, git evidence, verification, redaction, check run, publish, feedback ids, steps', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const store = new Store(':memory:');
  const github = new FakeGitHub(meta(origin, headSha, baseSha));
  const calls = { n: 0 };
  const reviewer = fakeReviewer([
    { path: 'svc.py', line: 2, evidence: 'user.name', severity: 'high' },
    { path: 'svc.py', line: 1, evidence: 'def handler', severity: 'critical' },
    { path: 'svc.py', line: 2, evidence: 'user.name', severity: 'medium', ruleId: 'noisy-rule' },
  ], calls);
  const ctx: WorkerContext = { config: configFor(root), store, auth, anthropic: {} as Anthropic, reviewer, log, dryRun: false, githubFor: async () => github, redactor: buildRedactor(['super-secret-value']) };
  const { job } = store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'manual', receivedAt: 'now' });
  const leased = store.claim('t', 60, { perRepo: 1, global: 1 })!;

  const outcome = await processJob(ctx, leased, 't');
  assert.equal(outcome.status, 'published', outcome.reason);
  assert.equal(github.posted.length, 1);
  const review = github.posted[0]!;
  assert.equal(review.event, 'REQUEST_CHANGES', 'one verified blocking finding remains');
  assert.equal(review.comments.length, 2, 'verifier demoted one, suppression dropped one, both survivors inline');
  assert.ok(review.comments.some((c) => /verifier disagrees/.test(c.body)));
  assert.doesNotMatch(review.body, /ghp_abcdefghijklmnopqrstuvwxyz/, 'token-shaped text is redacted before publishing');
  assert.match(review.body, /\[redacted github token\]/);
  assert.deepEqual(github.checks.map((c) => c.status + (c.conclusion ? ':' + c.conclusion : '')), ['in_progress', 'completed:action_required']);
  assert.equal(github.checks[1]!.id, github.checks[0]!.id, 'the in-progress check run is completed, not duplicated');
  assert.equal(store.job(job.id)?.status, 'published');
  assert.equal(store.findingByComment(100)?.path, 'svc.py', 'inline comment ids are stored for feedback');
  assert.equal(store.steps(job.id).length, 1, 'tool calls are recorded');
  assert.equal(calls.n, 1);
});

test('replaying a dry-run job with a retained review posts nothing', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const store = new Store(':memory:');
  const github = new FakeGitHub(meta(origin, headSha, baseSha));
  const calls = { n: 0 };
  const ctx: WorkerContext = { config: configFor(root), store, auth, anthropic: {} as Anthropic, reviewer: fakeReviewer([{ path: 'svc.py', line: 2, evidence: 'user.name', severity: 'high' }], calls), log, dryRun: true, githubFor: async () => github };
  const { job } = store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
  await processJob(ctx, store.claim('t', 60, { perRepo: 1, global: 1 })!, 't');
  assert.ok(store.pending(store.job(job.id)!), 'the dry run keeps its rendered review');
  store.requeue(job.id, 0, 'operator replay');
  const replayed = await processJob(ctx, store.claim('t2', 60, { perRepo: 1, global: 1 })!, 't2');
  assert.equal(replayed.status, 'skipped');
  assert.equal(github.posted.length, 0, 'nothing reaches GitHub in dry run');
  assert.equal(github.checks.length, 0);
  assert.equal(store.job(job.id)?.status, 'skipped');
});

test('a finished review survives publication failures and is republished without another model run', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const store = new Store(':memory:');
  const github = new FakeGitHub(meta(origin, headSha, baseSha));
  github.failPostsRemaining = 1;
  const calls = { n: 0 };
  const config = configFor(root);
  const ctx: WorkerContext = { config, store, auth, anthropic: {} as Anthropic, reviewer: fakeReviewer([{ path: 'svc.py', line: 2, evidence: 'user.name', severity: 'high' }], calls), log, dryRun: false, githubFor: async () => github };
  const { job } = store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
  const first = await processJob(ctx, store.claim('t', 60, { perRepo: 1, global: 1 })!, 't');
  assert.equal(first.status, 'deferred');
  assert.match(first.reason!, /publication retry 1/);
  assert.equal(store.job(job.id)?.status, 'queued');
  assert.ok(store.pending(store.job(job.id)!), 'the rendered review is retained');

  const again = store.claim('t2', 60, { perRepo: 1, global: 1 }, Date.now() / 1000 + 600)!;
  const second = await processJob(ctx, again, 't2');
  assert.equal(second.status, 'published');
  assert.equal(calls.n, 1, 'the model ran once');
  assert.equal(github.posted.length, 1);
  assert.equal(store.job(job.id)?.status, 'published');
});

test('worker holds on failed CI, defers on pending CI, and skips drafts without touching git', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const config = configFor(root);
  const reviewer: Reviewer = { review: async () => { throw new Error('model must not be called'); }, verify: async () => undefined };
  for (const [ci, draft, expected] of [['failure', false, 'held'], ['pending', false, 'deferred'], ['success', true, 'skipped']] as const) {
    const github = new FakeGitHub(meta(origin, headSha, baseSha, { draft }), ci);
    const s = new Store(':memory:');
    const { job } = s.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
    const outcome = await processJob({ config, store: s, auth, anthropic: {} as Anthropic, reviewer, log, dryRun: false, githubFor: async () => github }, s.claim('t', 60, { perRepo: 1, global: 1 })!, 't');
    assert.equal(outcome.status, expected, `ci=${ci} draft=${draft}`);
    if (expected === 'deferred') assert.equal(s.job(job.id)?.status, 'queued');
  }
  // A job for any other repository is refused before GitHub is even asked.
  const s = new Store(':memory:');
  const { job } = s.enqueue({ repo: 'ROKT/op3', number: 1, headSha: headSha, baseSha, baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
  const github = new FakeGitHub(meta(origin, headSha, baseSha));
  const outcome = await processJob({ config, store: s, auth, anthropic: {} as Anthropic, reviewer, log, dryRun: false, githubFor: async () => github }, s.claim('t', 60, { perRepo: 1, global: 1 })!, 't');
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason!, /not in the repository allowlist/);
  assert.equal(s.job(job.id)?.status, 'skipped');
});

test('an oversized PR is refused and the check blocks; dry run posts nothing', async () => {
  const { root, origin, baseSha: fixtureBase } = fixture();
  git(origin, 'checkout', '-q', '-b', 'big', fixtureBase);
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nbudgets: { maxChangedLines: 50 }\n');
  git(origin, 'commit', '-qam', 'budget');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'big.py'), Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'big');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/3/head', headSha);

  const run = async (dryRun: boolean) => {
    const store = new Store(':memory:');
    const github = new FakeGitHub(meta(origin, headSha, baseSha));
    const ctx: WorkerContext = { config: configFor(root), store, auth, anthropic: {} as Anthropic, reviewer: fakeReviewer([], { n: 0 }), log, dryRun, githubFor: async () => github };
    store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'manual', receivedAt: 'now' });
    return { github, outcome: await processJob(ctx, store.claim('t', 60, { perRepo: 1, global: 1 })!, 't') };
  };
  const live = await run(false);
  assert.equal(live.outcome.status, 'skipped');
  assert.match(live.outcome.reason ?? '', /60 changed lines exceeds the policy budget of 50/);
  assert.equal(live.github.checks.at(-1)?.conclusion, 'action_required');
  assert.equal((await run(true)).github.checks.length, 0);
});

test('an outsider without a plan is refused; a team member is not; the base branch list governs', async () => {
  const { root, origin, baseSha: fixtureBase } = fixture();
  git(origin, 'checkout', '-q', '-b', 'gate', fixtureBase);
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nverdict: { mode: request_changes }\nteam: { members: [lee] }\noutsiders: { requirePlan: true }\n');
  git(origin, 'commit', '-qam', 'team');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'svc.py'), 'def handler(user):\n    return user.name\n');
  git(origin, 'commit', '-qam', 'change');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'self', headSha);
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nverdict: { mode: request_changes }\nteam: { members: [lee, eve] }\noutsiders: { requirePlan: true }\n');
  git(origin, 'commit', '-qam', 'promote eve');
  const selfSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/3/head', headSha);

  const run = async (author: string, sha = headSha, dryRun = false) => {
    const store = new Store(':memory:');
    const github = new FakeGitHub(meta(origin, sha, baseSha, { author, body: '' }));
    const ctx: WorkerContext = { config: configFor(root), store, auth, anthropic: {} as Anthropic, reviewer: fakeReviewer([], { n: 0 }), log, dryRun, githubFor: async () => github };
    store.enqueue({ repo: 'acme/demo', number: 3, headSha: sha, baseSha, baseRef: 'main', trigger: 'manual', receivedAt: 'now' });
    return { github, outcome: await processJob(ctx, store.claim('t', 60, { perRepo: 1, global: 1 })!, 't') };
  };
  const eve = await run('eve');
  assert.equal(eve.outcome.status, 'skipped');
  assert.match(eve.outcome.reason ?? '', /Add these sections to the description: ## Problem, ## Plan/);
  assert.equal(eve.github.checks.at(-1)?.conclusion, 'action_required');
  assert.equal((await run('eve', headSha, true)).github.checks.length, 0);
  assert.notEqual((await run('lee')).outcome.status, 'skipped');
  git(origin, 'update-ref', 'refs/pull/3/head', selfSha);
  assert.equal((await run('eve', selfSha)).outcome.status, 'skipped');
});

test('a team approval on the current commit lifts the size block; an approval on an older commit does not', async () => {
  const { root, origin, baseSha: fixtureBase } = fixture();
  git(origin, 'checkout', '-q', '-b', 'ovr', fixtureBase);
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nbudgets: { maxChangedLines: 50 }\nteam: { members: [lee] }\n');
  git(origin, 'commit', '-qam', 'budget');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'big.py'), Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'big');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/3/head', headSha);

  const run = async (approvedAt: string) => {
    const store = new Store(':memory:');
    const github = new FakeGitHub(meta(origin, headSha, baseSha));
    github.approversByHead.set(approvedAt, ['lee']);
    const ctx: WorkerContext = { config: configFor(root), store, auth, anthropic: {} as Anthropic, reviewer: fakeReviewer([], { n: 0 }), log, dryRun: false, githubFor: async () => github };
    store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'manual', receivedAt: 'now' });
    return { github, outcome: await processJob(ctx, store.claim('t', 60, { perRepo: 1, global: 1 })!, 't') };
  };
  const { github: gh, outcome: overridden } = await run(headSha);
  assert.equal(overridden.status, 'skipped');
  assert.match(overridden.reason ?? '', /overridden by @lee, not reviewed/);
  assert.equal(gh.checks.at(-1)?.conclusion, 'success');
  assert.equal(gh.checks.at(-1)?.title, 'Overridden');
  const { github: ghStale } = await run('0'.repeat(40));
  assert.equal(ghStale.checks.at(-1)?.conclusion, 'action_required');
  assert.equal(ghStale.checks.at(-1)?.title, 'Changes needed');
});
