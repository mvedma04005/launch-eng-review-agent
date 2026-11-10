import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHub } from './github.ts';

const HEAD = 'h'.repeat(40);
const review = (login: string, state: string, commit_id = HEAD) => ({ user: { login }, state, commit_id });

test('approvers: only the latest verdict on exactly the head counts', async () => {
  const rows = [
    review('old', 'APPROVED', 'o'.repeat(40)),
    review('chatty', 'APPROVED'), review('chatty', 'COMMENTED'),
    review('flipped', 'APPROVED'), review('flipped', 'CHANGES_REQUESTED'),
    review('dismissed', 'DISMISSED'),
    review('good', 'APPROVED'),
  ];
  const octokit = { paginate: async () => rows, pulls: { listReviews: {} } } as unknown as Octokit;
  assert.deepEqual(await new OctokitGitHub(octokit, null).approvers('acme/demo', 3, HEAD), ['chatty', 'good']);
});

test('ci: the merge gate check is never counted as CI', async () => {
  const octokit = {
    repos: { getCombinedStatusForRef: async () => ({ data: { state: 'pending', statuses: [] } }) },
    checks: { listForRef: {} },
    paginate: async () => [{ name: 'Merge gate', status: 'in_progress', conclusion: null }, { name: 'build', status: 'completed', conclusion: 'success' }],
  } as unknown as Octokit;
  assert.equal(await new OctokitGitHub(octokit, null).ci('acme/demo', HEAD), 'success');
});

test('postGate: a pass is a completed success; anything else stays in progress, never neutral', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const octokit = { checks: { create: async (args: Record<string, unknown>) => { sent.push(args); return { data: {} }; } } } as unknown as Octokit;
  const github = new OctokitGitHub(octokit, null);
  await github.postGate('acme/demo', HEAD, true, 't', 's');
  await github.postGate('acme/demo', HEAD, false, 't', 's');
  assert.deepEqual(sent.map((a) => [a['name'], a['head_sha'], a['status'], a['conclusion']]), [['Merge gate', HEAD, 'completed', 'success'], ['Merge gate', HEAD, 'in_progress', undefined]]);
});

test('changedPaths: renamed files count under both names, and a list at the cap is refused', async () => {
  const some = { paginate: async () => [{ filename: 'new.py', previous_filename: 'old.py' }, { filename: 'a.py' }], pulls: { listFiles: {} } } as unknown as Octokit;
  assert.deepEqual(await new OctokitGitHub(some, null).changedPaths('acme/demo', 3), ['new.py', 'old.py', 'a.py']);
  // 1600 renamed files are 3200 names but 1600 files: under the cap.
  const renames = { paginate: async () => Array.from({ length: 1600 }, (_, i) => ({ filename: `n${i}`, previous_filename: `o${i}` })), pulls: { listFiles: {} } } as unknown as Octokit;
  assert.equal((await new OctokitGitHub(renames, null).changedPaths('acme/demo', 3))?.length, 3200);
  const capped = { paginate: async () => Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` })), pulls: { listFiles: {} } } as unknown as Octokit;
  assert.equal(await new OctokitGitHub(capped, null).changedPaths('acme/demo', 3), null);
});

test('ci: a check pending for longer than the limit is stalled and holds nothing up; a recent one still does', async () => {
  const HOUR = 3_600_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const github = (statuses: Array<{ state: string; updated_at: string }>, runs: Array<Record<string, unknown>> = []) => new OctokitGitHub({
    repos: { getCombinedStatusForRef: async () => ({ data: { state: 'pending', statuses } }) },
    checks: { listForRef: {} },
    paginate: async () => runs,
  } as unknown as Octokit, null);
  const green = { state: 'success', updated_at: ago(26 * HOUR) };
  const stuck = { state: 'pending', updated_at: ago(26 * HOUR) };
  assert.equal(await github([green, stuck]).ci('acme/demo', HEAD, HOUR), 'success', 'a status pending for a day is stalled');
  assert.equal(await github([green, stuck]).ci('acme/demo', HEAD), 'pending', 'without a limit it still waits');
  assert.equal(await github([green, { state: 'pending', updated_at: ago(5 * 60_000) }]).ci('acme/demo', HEAD, HOUR), 'pending', 'a build that started five minutes ago is running');
  assert.equal(await github([stuck, { state: 'failure', updated_at: ago(HOUR) }]).ci('acme/demo', HEAD, HOUR), 'failure', 'a failure still counts when the pending check is stalled');
  assert.equal(await github([green], [{ name: 'build', status: 'in_progress', conclusion: null, started_at: ago(3 * HOUR) }]).ci('acme/demo', HEAD, HOUR), 'success', 'a check run stuck in progress is stalled too');
  assert.equal(await github([green], [{ name: 'build', status: 'in_progress', conclusion: null, started_at: ago(60_000) }]).ci('acme/demo', HEAD, HOUR), 'pending');
});
