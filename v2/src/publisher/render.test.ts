import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../policy/load.ts';
import { parseUnifiedDiff } from '../evidence/diff.ts';
import { decideVerdict, renderReview } from './render.ts';
import type { Finding, PullMeta } from '../types.ts';

const meta: PullMeta = { repo: 'acme/demo', number: 7, title: 'T', body: '', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha: 'f'.repeat(40), baseSha: 'e'.repeat(40), baseRef: 'main', headRef: 'feat', changedFiles: 1, additions: 1, deletions: 1, labels: [], htmlUrl: 'https://github.com/acme/demo/pull/7', cloneUrl: 'https://github.com/acme/demo.git' };
const anchors = parseUnifiedDiff('diff --git a/h.py b/h.py\n--- a/h.py\n+++ b/h.py\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n');
const f = (over: Partial<Finding>): Finding => ({ id: 'abcdef123456', severity: 'high', blocking: true, path: 'h.py', line: 1, side: 'RIGHT', title: 'Bug', scenario: 's', impact: 'i', evidence: 'b', fix: 'x', fingerprint: 'fp', ...over });

test('verdict follows policy mode; verifier can demote a blocking finding', () => {
  const comment = parsePolicy('version: 1\nname: c\nverdict: { mode: comment }', 'c');
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  const rc = parsePolicy('version: 1\nname: r\nverdict: { mode: request_changes }', 'r');
  assert.equal(decideVerdict(comment, [f({})]).verdict, 'comment');
  assert.equal(decideVerdict(rc, [f({})]).verdict, 'request_changes');
  assert.equal(decideVerdict(approve, []).verdict, 'approve');
  assert.equal(decideVerdict(approve, [f({ verified: { real: false, confidence: 0.9, reason: 'guarded upstream' } })]).verdict, 'approve', 'verifier-rejected blocker does not block');
  assert.equal(decideVerdict(comment, []).verdict, 'comment', 'comment mode never approves');
  assert.equal(decideVerdict(approve, [], 'medium').verdict, 'comment', 'medium confidence never approves');
  assert.equal(decideVerdict(rc, [f({})], 'medium').verdict, 'comment', 'medium confidence never requests changes');
});

test('a medium-confidence review renders as comments only with the non-withdrawal notice', () => {
  const policy = parsePolicy('version: 1\nname: p\nverdict: { mode: request_changes }', 'p');
  const out = renderReview(policy, meta, { summary: 'Unsure about the caller.', confidence: 'medium', findings: [f({})], reviewedFiles: ['h.py'], lenses: ['correctness'], questions: [] }, anchors, new Map());
  assert.equal(out.event, 'COMMENT');
  assert.equal(out.checkConclusion, 'neutral');
  assert.match(out.body, /Comments only \(medium confidence\)/);
  assert.match(out.body, /does not withdraw earlier approvals or change requests/);
});

test('render places anchored findings inline, others in the body, and always carries the marker', () => {
  const policy = parsePolicy('version: 1\nname: p\nverdict: { mode: request_changes }', 'p');
  const out = renderReview(policy, meta, { summary: 'Sum', confidence: 'high', findings: [f({}), f({ id: '222222222222', path: 'other.py', line: 40, blocking: false, severity: 'low', fingerprint: 'fp2' })], reviewedFiles: ['h.py'], lenses: ['correctness'], questions: ['Why?'] }, anchors, new Map([['fp2', f({})]]));
  assert.equal(out.event, 'REQUEST_CHANGES');
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0]!.findingId, 'abcdef123456');
  assert.match(out.body, /other\.py:40/);
  assert.match(out.body, /still open from an earlier head/);
  assert.match(out.body, /Questions for the author/);
  assert.ok(out.body.endsWith(`<!-- falcon-review:v2 acme/demo#7@${'f'.repeat(40)} -->`));
  assert.equal(out.checkConclusion, 'action_required');
});
