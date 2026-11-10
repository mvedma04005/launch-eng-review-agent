import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { ReviewRequest } from '../types.ts';

const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({ repo: 'ROKT/x', number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRef: 'main', trigger: 'poll', receivedAt: new Date().toISOString(), ...over });
const limits = { perRepo: 2, global: 4 };

test('a writer waits for a busy database instead of failing', () => {
  const store = new Store(':memory:');
  assert.deepEqual({ ...store.db.prepare('pragma busy_timeout').get() }, { timeout: 15000 });
});

test('enqueue is idempotent per head and supersedes older unpublished heads', () => {
  const store = new Store(':memory:');
  const first = store.enqueue(req());
  const again = store.enqueue(req({ trigger: 'comment', requestedBy: 'bob' }));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id);
  const newer = store.enqueue(req({ headSha: 'c'.repeat(40) }));
  assert.equal(newer.created, true);
  assert.equal(store.job(first.job.id)?.status, 'cancelled');
  assert.equal(store.counts()['queued'], 1);
});

test('claim respects per-repo and global caps and orders by priority then age', () => {
  const store = new Store(':memory:');
  for (let n = 1; n <= 3; n++) store.enqueue(req({ number: n, headSha: String(n).repeat(40) }));
  store.enqueue(req({ repo: 'ROKT/y', number: 9, headSha: '9'.repeat(40) }), 5);
  const a = store.claim('w1', 300, limits)!;
  assert.equal(a.repo, 'ROKT/y', 'higher priority first');
  const b = store.claim('w2', 300, limits)!;
  const c = store.claim('w3', 300, limits)!;
  assert.deepEqual([b.number, c.number], [1, 2]);
  assert.equal(store.claim('w4', 300, limits), null, 'ROKT/x is at its per-repo cap and nothing else is queued');
});

test('an expired lease is recovered by another worker with attempts incremented', () => {
  const store = new Store(':memory:');
  store.enqueue(req());
  const t0 = 1_000_000;
  const first = store.claim('w1', 60, limits, t0)!;
  assert.equal(first.attempts, 1);
  assert.equal(store.claim('w2', 60, limits, t0 + 30), null, 'still leased');
  const recovered = store.claim('w2', 60, limits, t0 + 61)!;
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.leaseOwner, 'w2');
  assert.equal(store.heartbeat(first.id, 'w1', 60, t0 + 62), false, 'the old owner can no longer extend');
  assert.equal(store.heartbeat(first.id, 'w2', 60, t0 + 62), true);
});

test('finish, requeue and findings round-trip', () => {
  const store = new Store(':memory:');
  const { job } = store.enqueue(req());
  store.requeue(job.id, 90, 'CI pending');
  assert.equal(store.claim('w', 60, limits, Date.now() / 1000), null, 'not ready yet');
  assert.ok(store.claim('w', 60, limits, Date.now() / 1000 + 100));
  store.recordFindings(job, [{ id: 'f1', severity: 'high', blocking: true, path: 'a.ts', line: 3, side: 'RIGHT', title: 'T', scenario: 's', impact: 'i', evidence: 'e', fix: 'f', fingerprint: 'fp1' }]);
  store.setFindingComment('f1', 777);
  assert.equal(store.findingByComment(777)?.title, 'T');
  assert.equal(store.recordOutcome({ findingId: 'f1', signal: 'thumbs_down', actor: 'alice', at: 'now' }), true);
  assert.equal(store.recordOutcome({ findingId: 'f1', signal: 'thumbs_down', actor: 'alice', at: 'later' }), false, 'same signal from same actor recorded once');
  store.finish(job.id, 'published', { result: { ok: true } });
  assert.equal(store.job(job.id)?.status, 'published');
  assert.equal(store.priorFingerprints('ROKT/x', 1, 'z'.repeat(40)).has('fp1'), true);
});

test('lessons are scoped by path prefix and bounded', () => {
  const store = new Store(':memory:');
  store.addLesson({ repo: 'ROKT/x', pathPrefix: 'Orbit', text: 'Orbit uses Aurelia 1.x intentionally.', sourceFindingId: null, confidence: 0.9 });
  store.addLesson({ repo: 'ROKT/x', pathPrefix: '', text: 'Repo-wide lesson.', sourceFindingId: null, confidence: 0.5 });
  store.addLesson({ repo: 'ROKT/other', pathPrefix: '', text: 'Other repo.', sourceFindingId: null, confidence: 0.9 });
  assert.deepEqual(store.lessons('ROKT/x', ['src/a.ts'], 10).map((l) => l.text), ['Repo-wide lesson.']);
  assert.deepEqual(store.lessons('ROKT/x', ['Orbit/x.js'], 1).map((l) => l.text), ['Orbit uses Aurelia 1.x intentionally.']);
});

test('pending publications and tool-call steps round-trip', () => {
  const store = new Store(':memory:');
  const { job } = store.enqueue(req());
  assert.equal(store.pending(job), null);
  store.savePending(job.id, { headSha: job.headSha, event: 'COMMENT', body: 'b', comments: [], checkConclusion: 'neutral', blockingCount: 0, summary: 's', attempts: 2, renderedAt: 'now' });
  assert.equal(store.pending(store.job(job.id)!)?.attempts, 2);
  assert.equal(store.pending({ ...store.job(job.id)!, headSha: 'z'.repeat(40) }), null, 'a review for another head is never replayed');
  store.recordStep(job.id, { seq: 1, at: 'now', tool: 'read_file', input: 'a.ts:1-', durationMs: 4, outcome: 'ok' });
  store.recordStep(job.id, { seq: 2, at: 'now', tool: 'search', input: 'foo', durationMs: 9, outcome: 'budget' });
  assert.deepEqual(store.steps(job.id).map((s) => [s.seq, s.tool, s.outcome]), [[1, 'read_file', 'ok'], [2, 'search', 'budget']]);
  store.finish(job.id, 'failed', { error: 'x' });
  assert.equal(store.failedSince('1970-01-01T00:00:00Z'), 1);
  assert.equal(store.lastProgressAt(), null, 'failed is not progress');
});
