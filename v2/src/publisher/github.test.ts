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

test("olderApprovals: a person's later comment keeps their approval; Falcon's later comment ends Falcon's", async () => {
  const OLD = 'o'.repeat(40);
  const rows = [review('lee', 'APPROVED', OLD), review('lee', 'COMMENTED'), review('falcon[bot]', 'APPROVED', OLD), review('falcon[bot]', 'COMMENTED'), review('oz', 'APPROVED', OLD)];
  const octokit = { paginate: async () => rows, pulls: { listReviews: {} } } as unknown as Octokit;
  assert.deepEqual((await new OctokitGitHub(octokit, 'falcon[bot]').olderApprovals('acme/demo', 3, HEAD)).map((x) => x.login), ['lee', 'oz']);
  rows.splice(3, 1);
  assert.deepEqual((await new OctokitGitHub(octokit, 'falcon[bot]').olderApprovals('acme/demo', 3, HEAD)).map((x) => x.login), ['lee', 'falcon[bot]', 'oz']);
});

test('latestVerdicts: a person\'s comment keeps their verdict, the bot\'s comment ends its approval', async () => {
  const bot = 'falcon-review[bot]';
  const row = (login: string, state: string, at: string) => ({ user: { login }, state, commit_id: HEAD, submitted_at: `2026-11-10T${at}:00Z` });
  const rows = [row('lee', 'APPROVED', '10:00'), row('lee', 'COMMENTED', '10:01'), row(bot, 'APPROVED', '10:02'), row(bot, 'COMMENTED', '10:03'), { user: null, state: 'APPROVED', commit_id: HEAD, submitted_at: 'x' }, { user: { login: 'sam' }, state: 'APPROVED', commit_id: null, submitted_at: 'x' }, row('pat', 'APPROVED', '10:04'), row('pat', 'PENDING', '10:05'), row('kim', 'APPROVED', '10:06'), row('kim', 'DISMISSED', '10:07')];
  const octokit = { paginate: async () => rows, pulls: { listReviews: {} } } as unknown as Octokit;
  assert.deepEqual(await new OctokitGitHub(octokit, bot).latestVerdicts('acme/demo', 3), [
    { login: 'lee', state: 'APPROVED', sha: HEAD, submittedAt: '2026-11-10T10:00:00Z' },
    { login: bot, state: 'COMMENTED', sha: HEAD, submittedAt: '2026-11-10T10:03:00Z' },
    { login: 'pat', state: 'APPROVED', sha: HEAD, submittedAt: '2026-11-10T10:04:00Z' },
    { login: 'kim', state: 'DISMISSED', sha: HEAD, submittedAt: '2026-11-10T10:07:00Z' },
  ]);
});

test('mergeBase: reads the compare API\'s merge base', async () => {
  const base = 'b'.repeat(40);
  const seen: Array<Record<string, unknown>> = [];
  const octokit = { repos: { compareCommitsWithBasehead: async (a: Record<string, unknown>) => { seen.push(a); return { data: { merge_base_commit: { sha: 'm'.repeat(40) } } }; } } } as unknown as Octokit;
  assert.equal(await new OctokitGitHub(octokit, null).mergeBase('acme/demo', base, HEAD), 'm'.repeat(40));
  assert.equal(seen[0]!['basehead'], `${base}...${HEAD}`);
});

test('baseRefAt: the base in force at a time', async () => {
  const graphql = (nodes: unknown[]) => async () => ({ repository: { pullRequest: { baseRefName: 'feat-b', timelineItems: { nodes } } } });
  const events = [
    { __typename: 'BaseRefChangedEvent', createdAt: '2026-11-10T12:00:00Z', previousRefName: 'feat-a', currentRefName: 'main' },
    { __typename: 'AutomaticBaseChangeSucceededEvent', createdAt: '2026-11-10T13:00:00Z', oldBase: 'main', newBase: 'feat-b' },
  ];
  const at = (h: string, nodes = events) => new OctokitGitHub({ graphql: graphql(nodes) } as unknown as Octokit, null).baseRefAt('acme/demo', 3, Date.parse(`2026-11-10T${h}:00Z`));
  assert.equal(await at('11:00'), 'feat-a');
  assert.equal(await at('12:30'), 'main');
  assert.equal(await at('13:00'), 'feat-b');
  assert.equal(await at('11:00', []), 'feat-b');
  const many = Array.from({ length: 100 }, (_, i) => ({ __typename: 'BaseRefChangedEvent', createdAt: '2026-11-10T12:00:00Z', previousRefName: `p${i}`, currentRefName: `c${i}` }));
  assert.equal(await at('12:30', many), '', 'a read at the cap may be cut short, so no base is claimed');
});

test('stackMembers: maps the stack entries and marks the open ones', async () => {
  const entry = (position: number, state: string, n: number) => ({ position, pullRequest: { number: n, state, baseRefName: `b${n}`, headRefName: `h${n}`, headRefOid: `sha${n}` } });
  const reply = (stack: unknown) => async () => ({ repository: { pullRequest: { stack } } });
  const members = await new OctokitGitHub({ graphql: reply({ entries: { nodes: [entry(1, 'MERGED', 5), entry(2, 'OPEN', 6)].reverse() } }) } as unknown as Octokit, null).stackMembers('acme/demo', 6);
  assert.deepEqual(members, [
    { number: 5, position: 1, open: false, baseRef: 'b5', headRef: 'h5', headSha: 'sha5' },
    { number: 6, position: 2, open: true, baseRef: 'b6', headRef: 'h6', headSha: 'sha6' },
  ]);
  assert.deepEqual(await new OctokitGitHub({ graphql: reply(null) } as unknown as Octokit, null).stackMembers('acme/demo', 6), []);
});

test('openPulls: carries the stack and the head branch', async () => {
  const pr = (number: number, stack?: unknown) => ({ number, head: { sha: `s${number}`, ref: `feat-${number}` }, base: { ref: 'main', repo: { default_branch: 'main' } }, updated_at: 't', user: { login: 'sam' }, ...(stack ? { stack } : {}) });
  const octokit = { paginate: async () => [pr(7, { base: { ref: 'main', sha: 's' }, number: 7, position: 2 }), pr(8)], pulls: { list: {} } } as unknown as Octokit;
  const rows = await new OctokitGitHub(octokit, null).openPulls('acme/demo');
  assert.deepEqual(rows.map((r) => [r.headRef, r.stack]), [['feat-7', { number: 7, baseRef: 'main', position: 2 }], ['feat-8', null]]);
});
