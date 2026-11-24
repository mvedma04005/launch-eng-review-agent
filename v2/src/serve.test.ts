import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import type { Octokit } from '@octokit/rest';
import { ConfigSchema } from './config.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { eachRepo, gateTick, probeGate, shouldSweep, sleep, type GateLast, type GateProbe } from './serve.ts';

test('sleep leaves no listener on the signal, and an abort ends it early', async () => {
  const controller = new AbortController();
  // The loops share one signal for the life of the process. A listener left per sleep made each later sleep
  // slower (Node walks the list on every add) until the process spent a whole core on it.
  for (let i = 0; i < 200; i++) await sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);
  await sleep(60_000, controller.signal);
  assert.ok(Date.now() - started < 5_000, 'abort resolves the sleep, it does not reject or wait');
  await sleep(60_000, controller.signal);
});

const POLL_MS = 30_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const seen = (over: Partial<NonNullable<GateProbe['newest']>> = {}, queue = ['main:1:q1']): GateProbe => ({ newest: { number: 1, updatedAt: '2026-11-10T10:00:00Z', headSha: 'sha1', defaultBranch: 'main', ...over }, queue });

test('the gate loop runs a pass on the first tick, on a change, and when pollSeconds went by, but not for a failed probe', () => {
  const recent = NOW - 1_000;
  assert.equal(shouldSweep(null, seen(), 0, NOW, POLL_MS), true, 'first tick');
  assert.equal(shouldSweep(null, null, 0, NOW, POLL_MS), true, 'first tick, even when the probe failed');
  assert.equal(shouldSweep(seen(), seen(), recent, NOW, POLL_MS), false, 'no change and under pollSeconds');
  assert.equal(shouldSweep(seen(), seen({ updatedAt: '2026-11-10T10:00:05Z' }), recent, NOW, POLL_MS), true, 'the newest PR was updated');
  assert.equal(shouldSweep(seen(), seen({ number: 2 }), recent, NOW, POLL_MS), true, 'another PR is the newest');
  assert.equal(shouldSweep(seen(), seen({ headSha: 'sha1b' }), recent, NOW, POLL_MS), true, 'a new head');
  assert.equal(shouldSweep(seen(), { newest: null, queue: [] }, recent, NOW, POLL_MS), true, 'no open PR now');
  assert.equal(shouldSweep(seen(), seen({}, ['main:1:q1', 'main:2:q2']), recent, NOW, POLL_MS), true, 'a PR joined the queue');
  assert.equal(shouldSweep(seen(), seen({}, []), recent, NOW, POLL_MS), true, 'a PR left the queue');
  assert.equal(shouldSweep(seen(), null, recent, NOW, POLL_MS), false, 'a probe that failed is no change');
  assert.equal(shouldSweep(null, null, recent, NOW, POLL_MS), false, 'nor is the one after it');
  assert.equal(shouldSweep(null, seen(), recent, NOW, POLL_MS), true, 'the first look after a failed one is a change');
  assert.equal(shouldSweep(seen(), seen(), NOW - POLL_MS, NOW, POLL_MS), true, 'pollSeconds went by');
  assert.equal(shouldSweep(seen(), null, NOW - POLL_MS, NOW, POLL_MS), true, 'pollSeconds went by, with the probe failing');
});

test('a failed probe or a failed pass waits for pollSeconds: neither runs a pass on every tick', async () => {
  const last = new Map<string, GateLast>();
  let at = NOW;
  const clock = () => at;
  let passes = 0;
  const down = async (): Promise<GateProbe> => { throw new Error('GitHub is down'); };
  const tick = (look: () => Promise<GateProbe>, pass: () => Promise<void>) => gateTick(last, 'acme/demo', look, pass, POLL_MS, clock);
  const ok = async () => { passes++; };
  await tick(down, ok);
  assert.equal(passes, 1, 'the first tick runs a pass, even with the probe down');
  for (at = NOW + 5_000; at < NOW + POLL_MS; at += 5_000) await tick(down, ok);
  assert.equal(passes, 1, 'a failed probe starts no pass');
  await tick(down, ok);
  assert.equal(passes, 2, 'the timer pass still comes');
  // A pass that throws, started by a change. It is recorded, so it runs again only on the timer.
  const broken = async () => { passes++; throw new Error('pass failed'); };
  const started = at;
  at += 5_000;
  await assert.rejects(tick(async () => seen(), broken));
  assert.equal(passes, 3);
  for (at += 5_000; at < started + 5_000 + POLL_MS; at += 5_000) await tick(async () => seen(), broken);
  assert.equal(passes, 3, 'not retried on every tick');
  await assert.rejects(tick(async () => seen(), broken));
  assert.equal(passes, 4, 'retried at the pollSeconds pace');
});

test('one repository that fails does not stop the others', async () => {
  const ran: string[] = [];
  await eachRepo(['acme/a', 'acme/b'], async (repo) => { ran.push(repo); if (repo === 'acme/a') throw new Error('GitHub is down'); });
  assert.deepEqual(ran, ['acme/a', 'acme/b']);
});

test('the probe reads the newest PR, then the queues of its default branch and of each extra branch', async () => {
  const asked: string[] = [];
  let newest: GateProbe['newest'] = { number: 2, updatedAt: '2026-11-10T10:00:00Z', headSha: 'sha2', defaultBranch: 'main' };
  const github = {
    newestPull: async () => newest,
    queueEntries: async (_repo: string, branch: string) => { asked.push(branch); return branch === 'main' ? [{ number: 2, headSha: 'q2' }, { number: 1, headSha: 'q1' }] : []; },
  };
  assert.deepEqual(await probeGate(github, 'acme/demo', ['release']), { newest, queue: ['main:1:q1', 'main:2:q2'] });
  assert.deepEqual(asked, ['main', 'release']);
  newest = null;
  assert.deepEqual(await probeGate(github, 'acme/demo', ['release']), { newest: null, queue: [] });
  assert.deepEqual(asked, ['main', 'release'], 'no open PR, so no queue is read');
});

test('newestPull asks GitHub for the one open PR updated last', async () => {
  const asked: unknown[] = [];
  const rows = [{ number: 7, updated_at: '2026-11-10T10:00:00Z', head: { sha: 'sha7' }, base: { repo: { default_branch: 'main' } } }];
  const octokit = { pulls: { list: async (params: unknown) => { asked.push(params); return { data: rows.splice(0) }; } } } as unknown as Octokit;
  const github = new OctokitGitHub(octokit, null);
  assert.deepEqual(await github.newestPull('acme/demo'), { number: 7, updatedAt: '2026-11-10T10:00:00Z', headSha: 'sha7', defaultBranch: 'main' });
  assert.deepEqual(asked[0], { owner: 'acme', repo: 'demo', state: 'open', sort: 'updated', direction: 'desc', per_page: 1 });
  assert.equal(await github.newestPull('acme/demo'), null, 'no open PR');
});

test('config: gate.probeSeconds defaults to 5, 0 turns the probe off, and anything else is at least 5', () => {
  assert.equal(ConfigSchema.parse({}).gate.probeSeconds, 5);
  assert.equal(ConfigSchema.parse({ gate: { probeSeconds: 0 } }).gate.probeSeconds, 0);
  assert.equal(ConfigSchema.parse({ gate: { probeSeconds: 10 } }).gate.probeSeconds, 10);
  for (const probeSeconds of [-1, 1, 4]) assert.throws(() => ConfigSchema.parse({ gate: { probeSeconds } }), /must be 0 \(off\) or at least 5/);
});
