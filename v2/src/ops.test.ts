import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { AlertState, evaluateAlerts } from './alerts.ts';
import { ConfigSchema } from './config.ts';
import { registerStoreGauges, startStatusServer } from './http.ts';
import { log } from './log.ts';
import { Counter, Histogram, Registry } from './metrics.ts';
import { emptyUsage, estimateCostUsd, overBudget } from './pricing.ts';
import { Store } from './queue/store.ts';
import { dailyCapReason, effectiveBudget, secondsUntilNextUtcDay } from './worker.ts';
import { parsePolicy } from './policy/load.ts';

test('cost estimate uses list prices per token kind and is null for unknown models', () => {
  const usage = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheCreationTokens: 0, outputTokens: 100_000 };
  assert.equal(estimateCostUsd('claude-opus-5-5', usage), 4 + 0.2 + 2);
  assert.equal(estimateCostUsd('claude-haiku-5-5', { ...usage, outputTokens: 0 }), 0.1 + 0.01);
  assert.equal(estimateCostUsd('not-a-model', usage), null);
});

test('overBudget stops a review on tokens or dollars and stays quiet within limits', () => {
  const budget = { maxInputTokens: 1000, maxOutputTokens: 500, maxCostUsd: 1 };
  const ok = { ...emptyUsage(), inputTokens: 900, outputTokens: 100, estimatedCostUsd: 0.5 };
  assert.equal(overBudget(ok, budget), null);
  assert.match(overBudget({ ...ok, cachedInputTokens: 200 }, budget)!, /input tokens 1100/);
  assert.match(overBudget({ ...ok, outputTokens: 501 }, budget)!, /output tokens/);
  assert.match(overBudget({ ...ok, estimatedCostUsd: 1.5 }, budget)!, /\$1\.50 exceeds/);
  assert.equal(overBudget({ ...ok, estimatedCostUsd: null }, budget), null, 'unpriced models are limited by tokens only');
});

test('effective budget is the policy budget clamped by the operator ceiling', () => {
  const config = ConfigSchema.parse({ limits: { perReview: { maxCostUsd: 2, maxToolCalls: 50 } } });
  const policy = parsePolicy('version: 1\nname: p\nbudgets: { maxCostUsd: 10, maxToolCalls: 20, maxMinutes: 5 }', 'p');
  const b = effectiveBudget(config, policy);
  assert.equal(b.maxCostUsd, 2, 'ceiling wins when the policy asks for more');
  assert.equal(b.maxToolCalls, 20, 'policy wins when it asks for less');
  assert.equal(b.maxMinutes, 5);
});

test('daily caps defer new reviews to the next UTC day once spend is reached', () => {
  const store = new Store(':memory:');
  const config = ConfigSchema.parse({ limits: { daily: { perRepoUsd: 1, globalUsd: 5 } } });
  const job = store.enqueue({ repo: 'a/x', number: 1, headSha: '1'.repeat(40), baseSha: '2'.repeat(40), baseRef: 'main', trigger: 'poll', receivedAt: 'now' }).job;
  assert.equal(dailyCapReason(store, config, 'a/x'), null);
  store.recordUsage(job, 'claude-opus-5-5', { ...emptyUsage(), estimatedCostUsd: 1.2 });
  assert.match(dailyCapReason(store, config, 'a/x')!, /daily spend cap for a\/x/);
  assert.equal(dailyCapReason(store, config, 'a/y'), null, 'other repositories are unaffected until the global cap');
  const other = store.enqueue({ repo: 'a/y', number: 2, headSha: '3'.repeat(40), baseSha: '4'.repeat(40), baseRef: 'main', trigger: 'poll', receivedAt: 'now' }).job;
  store.recordUsage(other, 'claude-opus-5-5', { ...emptyUsage(), estimatedCostUsd: 4 });
  assert.match(dailyCapReason(store, config, 'a/z')!, /global daily spend cap/);
  assert.ok(secondsUntilNextUtcDay() >= 60 && secondsUntilNextUtcDay() <= 86_400);
  assert.equal(store.snapshot().spendTodayUsd, 5.2);
  assert.equal(store.spendSince('1970-01-01T00:00:00Z').runs, 2);
});

test('metrics render in Prometheus text format with escaped labels and histogram buckets', () => {
  const registry = new Registry();
  const c = new Counter('x_total', 'X.');
  c.inc({ repo: 'a/"b"' }, 2);
  const h = new Histogram('d_seconds', 'D.', [1, 5]);
  h.observe(0.5); h.observe(3); h.observe(9);
  registry.gauge('g', 'G.', () => [{ labels: { s: 'q' }, value: 7 }]);
  const text = registry.render() + c.render() + h.render();
  assert.match(text, /# TYPE g gauge\ng\{s="q"\} 7/);
  assert.match(text, /x_total\{repo="a\/\\"b\\""\} 2/);
  assert.match(text, /d_seconds_bucket\{le="1"\} 1\nd_seconds_bucket\{le="5"\} 2\nd_seconds_bucket\{le="\+Inf"\} 3\nd_seconds_sum 12\.5\nd_seconds_count 3/);
});

test('status server serves health, metrics, queue snapshot, jobs and the dashboard', async () => {
  const store = new Store(':memory:');
  const { job } = store.enqueue({ repo: 'a/x', number: 4, headSha: '5'.repeat(40), baseSha: '6'.repeat(40), baseRef: 'main', trigger: 'poll', receivedAt: 'now' });
  store.claim('w1', 300, { perRepo: 1, global: 1 });
  registerStoreGauges(store);
  const config = ConfigSchema.parse({ http: { port: 0 } });
  const server = startStatusServer(config, store, log);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await (await fetch(`${base}/healthz`)).json() as { ok: boolean };
    assert.equal(health.ok, true);
    const metricsText = await (await fetch(`${base}/metrics`)).text();
    assert.match(metricsText, /falcon_queue_jobs\{status="leased"\} 1/);
    const queue = await (await fetch(`${base}/api/queue`)).json() as { leased: Array<{ owner: string }> };
    assert.equal(queue.leased[0]?.owner, 'w1');
    const detail = await (await fetch(`${base}/api/jobs/${job.id}`)).json() as { job: { id: string }; events: unknown[] };
    assert.equal(detail.job.id, job.id);
    assert.ok(detail.events.length >= 2);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>Falcon review engine<\/title>/);
    assert.match(html, /a\/x#4/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test('alerts fire on sustained stall, spend near cap and repeated failures, and clear edge-triggered', () => {
  const config = ConfigSchema.parse({ limits: { daily: { globalUsd: 100 } }, alerts: { stallMinutes: 30, failuresPerHour: 3 } });
  const snapshot = { at: 'now', byStatus: { queued: 4 }, byRepo: [], leased: [], oldestQueuedAgeSec: 45 * 60, spendTodayUsd: 85 };
  const now = new Date('2026-11-10T12:00:00Z');
  const active = evaluateAlerts(config, { snapshot, lastProgressAt: new Date('2026-11-10T11:00:00Z'), failedLastHour: 3, now });
  assert.deepEqual([...active.keys()].sort(), ['repeated_failures', 'spend_near_cap', 'stalled']);
  assert.equal(evaluateAlerts(config, { snapshot, lastProgressAt: new Date('2026-11-10T11:50:00Z'), failedLastHour: 0, now }).has('stalled'), false, 'recent progress means the queue is slow, not stalled');
  assert.equal(evaluateAlerts(config, { snapshot: { ...snapshot, byStatus: {}, spendTodayUsd: 1 }, lastProgressAt: null, failedLastHour: 0, now }).size, 0);
  const state = new AlertState();
  assert.equal(state.transition(active).length, 3, 'three new conditions announced');
  assert.equal(state.transition(active).length, 0, 'nothing repeated while they persist');
  const cleared = state.transition(new Map());
  assert.equal(cleared.length, 3);
  assert.ok(cleared.every((m) => m.startsWith('🟢 Cleared')));
});
