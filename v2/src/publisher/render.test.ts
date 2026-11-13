import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../policy/load.ts';
import { parseUnifiedDiff } from '../evidence/diff.ts';
import { decideVerdict, renderReview } from './render.ts';
import type { Finding, PullMeta } from '../types.ts';

const meta: PullMeta = { repo: 'acme/demo', number: 7, title: 'T', body: '', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha: 'f'.repeat(40), baseSha: 'e'.repeat(40), baseRef: 'main', defaultBranch: 'main', headRef: 'feat', changedFiles: 1, additions: 1, deletions: 1, labels: [], htmlUrl: 'https://github.com/acme/demo/pull/7', cloneUrl: 'https://github.com/acme/demo.git' };
const anchors = parseUnifiedDiff('diff --git a/h.py b/h.py\n--- a/h.py\n+++ b/h.py\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n');
const f = (over: Partial<Finding>): Finding => ({ id: 'abcdef123456', severity: 'high', blocking: true, path: 'h.py', line: 1, side: 'RIGHT', title: 'Bug', scenario: 's', impact: 'i', evidence: 'b', fix: 'x', fingerprint: 'fp', ...over });

test('verdict follows policy mode; verifier can demote a blocking finding', () => {
  const comment = parsePolicy('version: 1\nname: c\nverdict: { mode: comment }', 'c');
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  const rc = parsePolicy('version: 1\nname: r\nverdict: { mode: request_changes }', 'r');
  assert.equal(decideVerdict(comment, [f({})]).verdict, 'comment');
  assert.equal(decideVerdict(rc, [f({})]).verdict, 'request_changes');
  assert.equal(decideVerdict(approve, []).verdict, 'approve');
  assert.equal(decideVerdict(rc, [f({ verified: { real: false, confidence: 0.9, reason: 'guarded upstream' } })]).verdict, 'comment', 'verifier-rejected blocker does not block');
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

test('an override turns a blocking verdict into a comment', () => {
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  assert.deepEqual(decideVerdict(approve, [f({})], 'high', 'lee'), { verdict: 'comment', blocking: [], overridden: true });
  assert.equal(decideVerdict(approve, [], 'high', 'lee').verdict, 'approve');
});

test('an overridden review says who overrode it, and only when something was blocking', () => {
  const rc = parsePolicy('version: 1\nname: r\nverdict: { mode: request_changes }', 'r');
  const out = (findings: Finding[]) => ({ summary: 's', findings, reviewedFiles: ['h.py'], questions: [], confidence: 'high' as const, lenses: ['correctness'] });
  const blocked = renderReview(rc, meta, out([f({})]), anchors, new Map(), 'lee');
  assert.match(blocked.body, /### Falcon review: .*\n\nBlocking findings overridden by @lee's approval\./);
  assert.equal(blocked.event, 'COMMENT');
  assert.equal(blocked.checkConclusion, 'neutral');
  assert.doesNotMatch(renderReview(rc, meta, out([]), anchors, new Map(), 'lee').body, /overridden/);
});

test('approve mode never approves past a blocking-severity finding the verifier disputes', () => {
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  const out = (findings: Finding[]) => ({ summary: 's', findings, reviewedFiles: ['h.py'], questions: [], confidence: 'high' as const, lenses: ['correctness'] });
  for (const verified of [{ real: false, confidence: 0.3, reason: 'cannot see callers' }, { real: false, confidence: 0, reason: 'verifier returned no structured result' }]) {
    const critical = f({ severity: 'critical', verified });
    assert.equal(decideVerdict(approve, [critical]).verdict, 'comment');
    const r = renderReview(approve, meta, out([critical]), anchors, new Map());
    assert.equal(r.event, 'COMMENT');
    assert.equal(r.checkConclusion, 'neutral');
    assert.match(r.body, /### Falcon review: Comments only — 1 blocking finding disputed by the verifier/);
  }
  // A nit is the only finding the bot approves over.
  const clean = renderReview(approve, meta, out([f({ severity: 'info', blocking: false })]), anchors, new Map());
  assert.equal(clean.event, 'APPROVE');
  assert.equal(clean.checkConclusion, 'success');
});

test('an overridden block says so in the headline and marks the render as overridden', () => {
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  const r = renderReview(approve, meta, { summary: 's', findings: [f({})], reviewedFiles: ['h.py'], questions: [], confidence: 'high', lenses: ['correctness'] }, anchors, new Map(), 'lee');
  assert.match(r.body, /^### Falcon review: Blocking findings overridden by @lee/);
  assert.doesNotMatch(r.body, /no blocking findings/i);
  assert.equal(r.overridden, true);
  assert.equal(r.event, 'COMMENT');
});

test('approve mode: only a nit lets the bot approve; P2 and P3 hold the approval', () => {
  const approve = parsePolicy('version: 1\nname: a\nverdict: { mode: approve }', 'a');
  const p2 = f({ severity: 'medium', blocking: false });
  const p3 = f({ severity: 'low', blocking: false });
  const nit = f({ severity: 'info', blocking: false });
  assert.equal(decideVerdict(approve, [p2]).verdict, 'comment');
  assert.equal(decideVerdict(approve, [p3]).verdict, 'comment');
  assert.equal(decideVerdict(approve, [nit]).verdict, 'approve');
  assert.equal(decideVerdict(approve, [nit, p3]).verdict, 'comment');
  const out = { summary: 's', confidence: 'high' as const, findings: [p3, nit], reviewedFiles: ['h.py'], lenses: ['correctness'], questions: [] };
  const held = renderReview(approve, meta, out, anchors, new Map());
  assert.equal(held.event, 'COMMENT');
  assert.match(held.body, /Comments only — 1 finding to fix before Falcon approves/);
  assert.match(held.body, /1 P3, 1 Nit/);
  // A pack may choose to approve over P2 and P3 again.
  const loose = parsePolicy('version: 1\nname: a\nverdict: { mode: approve, holdOn: [] }', 'a');
  assert.equal(decideVerdict(loose, [p2]).verdict, 'approve');
});
