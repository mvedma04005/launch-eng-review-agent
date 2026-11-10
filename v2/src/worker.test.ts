import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigSchema } from './config.ts';
import { log } from './log.ts';
import type { GitHubPort } from './publisher/github.ts';
import type { RenderedReview } from './publisher/render.ts';
import { Store } from './queue/store.ts';
import type { Reviewer } from './reviewer/claude.ts';
import type { PullMeta } from './types.ts';
import { processJob } from './worker.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'falcon-worker-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'CLAUDE.md'), '# Conventions\nUse the shared client.\n');
  writeFileSync(join(origin, 'svc.py'), 'def handler(user):\n    return user\n');
  writeFileSync(join(origin, 'package-lock.json'), '{}\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(origin, 'svc.py'), 'def handler(user):\n    return user.name\n');
  writeFileSync(join(origin, 'package-lock.json'), '{"changed": true}\n');
  mkdirSync(join(origin, '.falcon'));
  writeFileSync(join(origin, '.falcon', 'policy.yaml'), 'version: 1\nname: repo\nverdict: { mode: request_changes }\nsuppressions:\n  - { rule: noisy-rule, paths: ["**"], reason: test }\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'change');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/3/head', headSha);
  git(origin, 'checkout', '-q', 'main');
  return { root, origin, baseSha, headSha };
}

class FakeGitHub implements GitHubPort {
  posted: RenderedReview[] = [];
  checks: string[] = [];
  reject422Once = false;
  meta: PullMeta;
  ciState: 'none' | 'pending' | 'success' | 'failure';
  existing: Array<{ id: number; htmlUrl: string }> = [];
  constructor(meta: PullMeta, ciState: 'none' | 'pending' | 'success' | 'failure' = 'success') { this.meta = meta; this.ciState = ciState; }
  async pull() { return this.meta; }
  async ci() { return this.ciState; }
  async ownReviews() { return this.existing; }
  async postReview(_r: string, _n: string | number, _h: string, review: RenderedReview) {
    if (this.reject422Once) { this.reject422Once = false; const e = new Error('Unprocessable') as Error & { status: number }; e.status = 422; throw e; }
    this.posted.push(review);
    return { id: 1, htmlUrl: 'https://example.test/review/1', inlineDropped: false, commentIds: new Map(review.comments.map((c, i) => [c.findingId, 100 + i])) };
  }
  async checkRun(_r: string, _h: string, conclusion: RenderedReview['checkConclusion']) { this.checks.push(conclusion); return 7; }
  async fileAtRef() { return null; }
}

const fakeReviewer = (findings: Array<{ path: string; line: number; evidence: string; severity: 'critical' | 'high' | 'medium'; ruleId?: string }>): Reviewer => ({
  async review(opts) {
    // The fake behaves like the real reviewer's host validation would: it only emits what the worktree supports.
    assert.ok(opts.turn.changedFiles.includes('svc.py'));
    assert.ok(!opts.turn.changedFiles.includes('package-lock.json'), 'lockfile excluded by policy scope');
    assert.equal(opts.turn.instructionDocs[0]?.path, 'CLAUDE.md');
    assert.equal(opts.policy.verdict.mode, 'request_changes', 'repository overlay applied');
    return {
      output: {
        summary: 'Null user crashes handler.', confidence: 'high' as const, reviewedFiles: opts.turn.changedFiles, lenses: opts.policy.lenses, questions: [],
        findings: findings.map((f, i) => ({ id: `f${i}`.padEnd(12, '0'), ruleId: f.ruleId, severity: f.severity, blocking: false, path: f.path, line: f.line, side: 'RIGHT' as const, title: `Finding ${i}`, scenario: 's', impact: 'i', evidence: f.evidence, fix: 'guard', fingerprint: `fp${i}` })),
      },
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 5, toolCalls: 3, modelCalls: 1, wallMs: 10, estimatedCostUsd: 0.0001 },
    };
  },
  async verify(_c, _m, finding) { return { real: finding.line === 2, confidence: 0.9, reason: finding.line === 2 ? 'confirmed' : 'line 1 is the signature' }; },
});

test('worker runs a PR end to end: gates, git evidence, repo policy, verification, publish, feedback ids', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), policy: { defaultPack: new URL('../policies/default.yaml', import.meta.url).pathname } });
  const store = new Store(':memory:');
  const meta: PullMeta = { repo: 'acme/demo', number: 3, title: 'Use name', body: 'desc', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha, baseSha, baseRef: 'main', headRef: 'feature', changedFiles: 3, additions: 2, deletions: 2, labels: [], htmlUrl: 'https://example.test/pr/3', cloneUrl: origin };
  const github = new FakeGitHub(meta);
  const reviewer = fakeReviewer([
    { path: 'svc.py', line: 2, evidence: 'user.name', severity: 'high' },
    { path: 'svc.py', line: 1, evidence: 'def handler', severity: 'critical' },
    { path: 'svc.py', line: 2, evidence: 'user.name', severity: 'medium', ruleId: 'noisy-rule' },
  ]);
  const auth = { mode: 'token' as const, octokitFor: async () => { throw new Error('unused'); }, gitTokenFor: async () => 'tok', botLogin: async () => 'falcon[bot]', installationIdFor: async () => null };
  const ctx = { config, store, auth, anthropic: {} as Anthropic, reviewer, log, dryRun: false, githubFor: async () => github };
  const { job } = store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'manual', receivedAt: 'now' });
  const leased = store.claim('t', 60, { perRepo: 1, global: 1 })!;

  const outcome = await processJob(ctx, leased, 't');
  assert.equal(outcome.status, 'published', outcome.reason);
  assert.equal(github.posted.length, 1);
  const review = github.posted[0]!;
  assert.equal(review.event, 'REQUEST_CHANGES', 'one verified blocking finding remains');
  assert.equal(review.blocking.length, 1, 'verifier demoted the signature-line finding; suppression dropped the noisy rule');
  assert.equal(review.comments.length, 2, 'both surviving findings sit on changed lines and go inline');
  assert.ok(review.comments.some((c) => /verifier disagrees/.test(c.body)), 'demoted finding explains the verifier result inline');
  assert.deepEqual(github.checks, ['action_required']);
  assert.equal(store.job(job.id)?.status, 'published');
  assert.equal(store.findingByComment(100)?.path, 'svc.py', 'inline comment ids are stored for feedback');

  // Same head again: skipped without a model call.
  github.existing = [{ id: 1, htmlUrl: 'https://example.test/review/1' }];
  const again = store.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'comment', receivedAt: 'now' });
  assert.equal(again.created, false);
});

test('worker holds on failed CI, requeues on pending CI, and skips drafts without touching git', async () => {
  const { root, origin, baseSha, headSha } = fixture();
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), policy: { defaultPack: new URL('../policies/default.yaml', import.meta.url).pathname } });
  const store = new Store(':memory:');
  const meta: PullMeta = { repo: 'acme/demo', number: 3, title: 't', body: '', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha, baseSha, baseRef: 'main', headRef: 'f', changedFiles: 1, additions: 1, deletions: 1, labels: [], htmlUrl: 'u', cloneUrl: origin };
  const reviewer: Reviewer = { review: async () => { throw new Error('model must not be called'); }, verify: async () => undefined };
  const auth = { mode: 'token' as const, octokitFor: async () => { throw new Error('unused'); }, gitTokenFor: async () => 'tok', botLogin: async () => null, installationIdFor: async () => null };
  for (const [ci, draft, expected] of [['failure', false, 'held'], ['pending', false, 'deferred'], ['success', true, 'skipped']] as const) {
    const github = new FakeGitHub({ ...meta, draft }, ci);
    const s = new Store(':memory:');
    const { job } = s.enqueue({ repo: 'acme/demo', number: 3, headSha, baseSha, baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
    const outcome = await processJob({ config, store: s, auth, anthropic: {} as Anthropic, reviewer, log, dryRun: false, githubFor: async () => github }, s.claim('t', 60, { perRepo: 1, global: 1 })!, 't');
    assert.equal(outcome.status, expected, `ci=${ci} draft=${draft}`);
    if (expected === 'deferred') assert.equal(s.job(job.id)?.status, 'queued');
  }
  store.close();
});
