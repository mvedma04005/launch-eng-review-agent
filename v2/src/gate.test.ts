import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { ConfigSchema } from './config.ts';
import { sweepGate, type GateDeps, type GatePort, type StackRef } from './gate.ts';
import { decodeState, encodeState } from './gate-binding.ts';
import { log } from './log.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { Store } from './queue/store.ts';

const REPO = 'acme/demo';
const FALCON = 'falcon-review[bot]';
const CODEOWNERS = '* @acme/team\n/merlin/ @pep\n';
const PACK = 'version: 1\nname: repo\nteam: { members: [lee] }\n';
const T0 = Date.parse('2026-11-10T12:00:00Z');
const MINUTE = 60_000;
const APPROVED_AT = '2026-11-10T10:05:00Z';
const approved = (login: string, sha: string, submittedAt = APPROVED_AT) => ({ login, state: 'APPROVED', sha, submittedAt });
const couldNotTell = (login: string) => ` ${login} approved, but Falcon could not tell which change that approval was for, so it does not count here. Approve this commit again.`;

type Verdict = { login: string; state: string; sha: string; submittedAt: string };
interface Pull { number: number; headSha: string; baseRef: string; updatedAt: string; author: string; files: string[] | null; approvers: string[]; older?: Array<{ login: string; sha: string }>; open?: boolean; verdicts?: Verdict[]; baseSha?: string; mergeBase?: string; baseAt?: string; stack?: StackRef | null; fromFork?: boolean }
const pull = (number: number, over: Partial<Pull> = {}): Pull => ({ number, headSha: `sha${number}`, baseRef: 'main', updatedAt: `2026-11-10T10:00:0${number}Z`, author: 'sam', files: ['Orbit/a.py'], approvers: [], ...over });

function fixture(pulls: Pull[], over: Partial<GateDeps> = {}, files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, '.falcon/policy.yaml': PACK }) {
  const posts: Array<{ sha: string; passed: boolean; title: string }> = [];
  const summaries: string[] = [];
  const cursors = new Map<string, string>();
  const hooks: { onFiles?: (p: Pull) => void } = {};
  const queue: Array<{ number: number; headSha: string; branch: string }> = [];
  const find = (number: number) => pulls.find((x) => x.number === number)!;
  const tip = (p: Pull) => p.baseSha ?? `tip-${p.baseRef}`;
  // Observations live in a real store; every other cursor stays in the map.
  const db = new Store(':memory:');
  const clock = { at: T0 };
  const github: GatePort = {
    openPulls: async () => pulls.map((p) => ({ stack: null, fromFork: false, ...p, headRef: `br${p.number}`, defaultBranch: 'main' })),
    pullState: async (_repo, number) => ({ ...find(number), baseSha: tip(find(number)), open: find(number).open ?? true }),
    changedPaths: async (_repo, number) => {
      const p = find(number);
      if (p.files?.[0] === 'boom') throw new Error('GitHub is down');
      hooks.onFiles?.(p);
      return p.files;
    },
    latestVerdicts: async (_repo, number) => {
      const p = find(number);
      return p.verdicts ?? [...p.approvers.map((login) => ({ login, sha: p.headSha })), ...(p.older ?? [])].map(({ login, sha }) => ({ login, state: 'APPROVED', sha, submittedAt: p.updatedAt }));
    },
    // The gate asks with the base branch for the change now, and with a saved base tip for Falcon's review.
    mergeBase: async (_repo, base, headSha) => {
      const branch = base.replace(/^heads\//, '');
      const p = pulls.find((x) => x.headSha === headSha && (x.baseRef === branch || tip(x) === base));
      return p?.mergeBase ?? `mb-${p ? tip(p) : branch}`;
    },
    // The base GitHub's timeline gives at an approval: `baseAt`, else the base now.
    baseRefAt: async (_repo, number) => find(number).baseAt ?? find(number).baseRef,
    stackMembers: async () => [],
    fileAtRef: async (_repo, ref, path) => (ref === 'main' ? files[path] ?? null : null),
    postGate: async (_repo, sha, passed, title, summary) => { posts.push({ sha, passed, title }); summaries.push(summary); },
    queueEntries: async (_repo, branch) => queue.filter((e) => e.branch === branch),
  };
  const store: GateDeps['store'] = {
    cursor: (k) => cursors.get(k) ?? null,
    setCursor: (k, v) => { cursors.set(k, v); },
    observeGate: (o) => db.observeGate(o),
    gateObservationsAround: (repo, number, atMs) => db.gateObservationsAround(repo, number, atMs),
    pruneGateObservations: (beforeMs) => db.pruneGateObservations(beforeMs),
  };
  const deps: GateDeps = { github, store, log, falcon: FALCON, repoPack: '.falcon/policy.yaml', requested: new Set(pulls.map((p) => p.number)), dryRun: false, now: () => clock.at, ...over };
  // What the gate would have recorded of a PR at `at`.
  const observe = (at: string, headSha: string, baseRef = 'main', mergeBase = `mb-tip-${baseRef}`, number = 1) => db.observeGate({ repo: REPO, number, atMs: Date.parse(at), headSha, baseRef, baseSha: `tip-${baseRef}`, mergeBase });
  // The gate saw the same head, base and merge base before and after APPROVED_AT.
  const around = (headSha: string, baseRef = 'main', mergeBase = `mb-tip-${baseRef}`, number = 1) => {
    observe('2026-11-10T10:00:00Z', headSha, baseRef, mergeBase, number);
    observe('2026-11-10T10:10:00Z', headSha, baseRef, mergeBase, number);
  };
  return { deps, posts, summaries, cursors, files, hooks, queue, db, clock, observe, around };
}

test('the gate waits, passes on a Falcon approval, and waits again when the approval goes', async () => {
  const p = pull(1);
  const f = fixture([p]);
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.equal(await sweepGate(f.deps, REPO, T0), 0, 'nothing changed, nothing posted');

  p.approvers = [FALCON];
  p.updatedAt = '2026-11-10T10:05:00Z';
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' });

  p.approvers = [];
  p.headSha = 'sha1b'; // A push: the approval was on the older commit.
  p.updatedAt = '2026-11-10T10:06:00Z';
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1b', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
});

test('an approval in the same second as the cursor is still seen', async () => {
  const p = pull(1);
  const f = fixture([p]);
  await sweepGate(f.deps, REPO, T0);
  p.approvers = ['lee']; // updatedAt unchanged.
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.equal(f.posts.at(-1)!.passed, true);
});

test('without a pack, or with an invalid one, only Falcon counts, and a named owner alone is not enough', async () => {
  for (const pack of [undefined, 'version: [not, a, pack']) {
    const files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, ...(pack ? { '.falcon/policy.yaml': pack } : {}) };
    const f = fixture([pull(1, { approvers: ['lee'] }), pull(2, { files: ['merlin/a.js'], approvers: ['pep'] }), pull(3, { approvers: [FALCON] })], {}, files);
    await sweepGate(f.deps, REPO, T0);
    assert.deepEqual(f.posts.map((p) => [p.sha, p.passed]), [['sha1', false], ['sha2', false], ['sha3', true]]);
  }
});

test('a PR into another branch is skipped, and one failing PR does not stop the rest', async () => {
  const f = fixture([pull(1, { baseRef: 'stack/base' }), pull(2, { files: ['boom'] }), pull(3, { approvers: ['lee'] })]);
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha3', passed: true, title: 'Approved by Launch Engineering or Falcon' }]);
  assert.equal(f.cursors.get(`gate:${REPO}`), undefined, 'the cursor stays so the failed PR is read again');
  assert.equal(await sweepGate(f.deps, REPO, T0), 0, 'the PR already posted is not posted twice');
});

test('a dry run posts nothing and marks nothing as seen', async () => {
  const f = fixture([pull(1, { approvers: [FALCON] })], { dryRun: true });
  assert.equal(await sweepGate(f.deps, REPO, T0), 0);
  assert.deepEqual(f.posts, []);
  assert.equal(f.cursors.size, 0);
  assert.equal(await sweepGate({ ...f.deps, dryRun: false }, REPO, T0), 1, 'the first real pass still posts');
});

test('an unknown Falcon login, the author, and a cut-short file list never give a pass', async () => {
  const anon = fixture([pull(1, { approvers: [FALCON] })], { falcon: null });
  await sweepGate(anon.deps, REPO, T0);
  assert.equal(anon.posts[0]!.passed, false);
  const self = fixture([pull(1, { author: 'Lee', approvers: ['lee'] })]);
  await sweepGate(self.deps, REPO, T0);
  assert.equal(self.posts[0]!.passed, false);
  const huge = fixture([pull(1, { files: null, approvers: [FALCON, 'lee'] })]);
  await sweepGate(huge.deps, REPO, T0);
  assert.deepEqual(huge.posts[0], { sha: 'sha1', passed: false, title: 'Waiting: too many files to check' });
});

test('a push while the PR is being read: the new commit is judged, never the old commit with the new files', async () => {
  // Commit sha1 changes a merlin file too. The author pushes a commit without it while the pass is reading files.
  const p = pull(1, { files: ['Orbit/a.py', 'merlin/a.js'], approvers: [FALCON] });
  const f = fixture([p]);
  let pushed = false;
  f.hooks.onFiles = (x) => { if (!pushed) { pushed = true; x.files = ['Orbit/a.py']; x.headSha = 'sha1b'; x.approvers = []; x.updatedAt = '2026-11-10T10:09:00Z'; } };
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha1b', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' }]);
});

test('a comment while the PR is being read costs one more read, not a wrong or missing verdict', async () => {
  const p = pull(1, { approvers: ['lee'] });
  const f = fixture([p]);
  let touched = false;
  f.hooks.onFiles = (x) => { if (!touched) { touched = true; x.updatedAt = '2026-11-10T10:09:00Z'; } }; // Only the update time moves.
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' }]);
});

test('a PR that keeps moving loses its pass until it holds still', async () => {
  const p = pull(1, { approvers: ['lee'] });
  const f = fixture([p]);
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)!.passed, true);
  let tick = 10;
  f.hooks.onFiles = (x) => { x.updatedAt = `2026-11-10T10:09:${tick++}Z`; }; // Touched on every read.
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting: the PR changed while it was being checked' });
  assert.equal(await sweepGate(f.deps, REPO, T0), 0, 'still moving on the same commit: the wait stands, nothing new is posted');
  delete f.hooks.onFiles;
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
});

test('a PR closed or retargeted while it is being read gets no check', async () => {
  const closed = fixture([pull(1, { approvers: ['lee'] })]);
  closed.hooks.onFiles = (x) => { x.open = false; };
  assert.equal(await sweepGate(closed.deps, REPO, T0), 0);
  const moved = fixture([pull(1, { approvers: ['lee'] })]);
  moved.hooks.onFiles = (x) => { x.baseRef = 'stack/base'; };
  assert.equal(await sweepGate(moved.deps, REPO, T0), 0);
  assert.deepEqual([...closed.posts, ...moved.posts], []);
});

test('a pass does not outlive a change to the rules on the default branch', async () => {
  const f = fixture([pull(1, { approvers: ['lee'] }), pull(2)]);
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts[0]!.passed, true);
  f.files['.falcon/policy.yaml'] = 'version: 1\nname: repo\nteam: { members: [kim] }\n'; // lee leaves the team; PR 1 is not touched.
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
});

test('every open PR is judged again after half an hour, so a silent change is still caught', async () => {
  const p = pull(1, { approvers: ['lee'] });
  const f = fixture([p, pull(2)]);
  await sweepGate(f.deps, REPO, T0);
  p.approvers = []; // Withdrawn without moving the PR's update time.
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 0);
  assert.equal(await sweepGate(f.deps, REPO, T0 + 31 * MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
});

test('only PRs requested in Chat get a check, and a request for an old PR is picked up on the next pass', async () => {
  const f = fixture([pull(1, { approvers: ['lee'] }), pull(2, { approvers: ['lee'] })], { requested: new Set([2]) });
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.map((p) => p.sha), ['sha2']);
  // PR 1 is requested later. Its update time is older than the cursor, and the half-hour pass is not due.
  assert.equal(await sweepGate({ ...f.deps, requested: new Set([1, 2]) }, REPO, T0 + MINUTE), 1);
  assert.deepEqual(f.posts.map((p) => p.sha), ['sha2', 'sha1']);
  // No list at all (gate.everyPull): every open PR into the default branch is judged.
  const all = fixture([pull(1, { approvers: ['lee'] }), pull(2)], { requested: null });
  assert.equal(await sweepGate(all.deps, REPO, T0), 2);
  assert.deepEqual(all.posts.map((p) => [p.sha, p.passed]), [['sha1', true], ['sha2', false]]);
  const none = fixture([pull(1, { approvers: ['lee'] })], { requested: new Set() });
  assert.equal(await sweepGate(none.deps, REPO, T0), 0);
  assert.deepEqual(none.posts, []);
});

test('a queue commit carries the decision on its own PR: a pass once, a wait until the PR passes', async () => {
  const approved = pull(1, { approvers: [FALCON] });
  const waiting = pull(2);
  const f = fixture([approved, waiting]);
  await sweepGate(f.deps, REPO, T0);
  f.posts.length = 0;

  f.queue.push({ number: 1, headSha: 'q1', branch: 'main' }, { number: 2, headSha: 'q2', branch: 'main' }, { number: 1, headSha: 'other', branch: 'release' });
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 2);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q1', true], ['q2', false]], 'the queue of a branch no open PR targets is not read');
  assert.equal(await sweepGate(f.deps, REPO, T0 + 2 * MINUTE), 0, 'a queue commit is posted once');

  waiting.approvers = ['lee'];
  waiting.updatedAt = '2026-11-10T12:05:00Z';
  f.posts.length = 0;
  await sweepGate(f.deps, REPO, T0 + 3 * MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha2', true], ['q2', true]], 'the queue commit follows its PR in the same pass');
});

test('a PR into a listed extra branch is judged like one into the default branch', async () => {
  const f = fixture([pull(1, { baseRef: 'queue-trial', verdicts: [approved('lee', 'sha1')] }), pull(2, { baseRef: 'stack/base', approvers: ['lee'] })], { branches: ['queue-trial'] });
  // Off the default branch, a person's approval binds only from what the gate saw around it.
  f.around('sha1', 'queue-trial');
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', true]]);
});

test('the gate names an approver who is not on the team list, so the author sees why that approval does not count', async () => {
  const f = fixture([pull(1, { approvers: ['Oz', 'pat'] }), pull(2, { approvers: ['lee'] }), pull(3)]);
  await sweepGate(f.deps, REPO, T0);
  assert.match(f.summaries[0]!, /Approved on this commit by Oz, pat\. Oz and pat are not in the team list of the policy file, so their approval does not count here\./);
  assert.doesNotMatch(f.summaries[1]!, /does not count/);
  assert.doesNotMatch(f.summaries[2]!, /does not count/);
  const g = fixture([pull(1, { approvers: ['oz', FALCON], files: ['.github/CODEOWNERS'] })]);
  await sweepGate(g.deps, REPO, T0);
  assert.match(g.summaries[0]!, /oz is not in the team list of the policy file, so that approval does not count here\./, 'Falcon is never named as an outsider');
});

test('an approval on an older commit counts when the change is the same, and the check runs once per pair of commits', async () => {
  const calls: string[] = [];
  let same = true;
  const p = pull(1, { headSha: 'new1', verdicts: [approved('lee', 'old1')] });
  const f = fixture([p], { sameChange: async (number, oldSha, headSha, governs) => {
    calls.push(`${number}:${oldSha}:${headSha}`);
    assert.ok(governs('Orbit/a.py') && governs('.falcon/policy.yaml') && governs('.github/CODEOWNERS') && !governs('ad-sentinel/x.py'));
    return same;
  } });
  f.around('old1');
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'new1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  await sweepGate(f.deps, REPO, T0 + 31 * MINUTE); // A full recheck reads the saved result.
  assert.deepEqual(calls, ['1:old1:new1']);

  same = false;
  p.headSha = 'new2';
  p.updatedAt = '2026-11-10T10:07:00Z';
  await sweepGate(f.deps, REPO, T0 + 32 * MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'new2', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
});

test('the gate compares only when it would wait, and only for team members other than the author', async () => {
  const calls: string[] = [];
  const sameChange = async (_n: number, oldSha: string) => { calls.push(oldSha); return true; };
  const kim = approved('kim', 'a', '2026-11-10T10:01:00Z');
  const p = pull(1, { verdicts: [approved('lee', 'sha1'), kim] });
  const f = fixture([
    p,
    // oz is not on the team, sam is the author, and Falcon has no saved review of `b`.
    pull(2, { verdicts: [approved('oz', 'b'), approved('sam', 'b'), approved(FALCON, 'b')] }),
  ], { sameChange }, { '.falcon/policy.yaml': 'version: 1\nname: repo\nteam: { members: [lee, kim, sam] }\n' });
  // Every older approval is bound, so only the rules above keep it from being compared.
  f.observe('2026-11-10T10:00:00Z', 'a');
  f.observe('2026-11-10T10:02:00Z', 'a');
  f.around('b', 'main', 'mb-tip-main', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(calls, []);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', true], ['sha2', false]]);
  // Without lee the gate would wait, so kim's older approval is compared.
  p.verdicts = [kim];
  await sweepGate(f.deps, REPO, T0 + 31 * MINUTE);
  assert.deepEqual(calls, ['a']);
});

test('a failed comparison waits and is tried again on the next pass', async () => {
  let fail = true;
  const f = fixture([pull(1, { verdicts: [approved('lee', 'old1')] })], { sameChange: async () => { if (fail) throw new Error('git down'); return true; } });
  f.around('old1');
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, false);
  fail = false;
  await sweepGate(f.deps, REPO, T0 + 31 * MINUTE);
  assert.equal(f.posts.at(-1)?.passed, true);
});

test("Falcon's approval of an older commit counts while it is Falcon's latest review, measured from the base Falcon saved", async () => {
  const calls: string[] = [];
  let last = { headSha: 'old1', baseSha: 'stackbase', baseRef: 'main', event: 'APPROVE' };
  const p = pull(1, { headSha: 'new1', older: [{ login: FALCON, sha: 'old1' }] });
  const f = fixture([p], { sameChange: async (_n, oldSha, headSha, _governs, oldBase) => { calls.push(`${oldSha}:${headSha}:${oldBase}`); return true; } });
  f.deps.store.lastReview = () => last;
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(calls, ['old1:new1:mb-stackbase'], 'measured from the merge base of the saved base and the reviewed head');
  assert.deepEqual(f.posts.at(-1), { sha: 'new1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  assert.match(f.summaries.at(-1)!, /Approved by falcon-review\[bot\] on old1, an earlier commit with the same change\./);

  // Falcon reviewed the new head and did not approve it: its older approval no longer carries.
  last = { headSha: 'new2', baseSha: 'main1', baseRef: 'main', event: 'COMMENT' };
  p.headSha = 'new2';
  p.updatedAt = '2026-11-10T10:07:00Z';
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.equal(f.posts.at(-1)?.passed, false);
  assert.deepEqual(calls, ['old1:new1:mb-stackbase']);
});

test("Falcon's older approval does not carry when Falcon's recorded review is of another commit", async () => {
  const calls: string[] = [];
  const f = fixture([pull(1, { headSha: 'new1', older: [{ login: FALCON, sha: 'old1' }] })], { sameChange: async (_n, oldSha) => { calls.push(oldSha); return true; } });
  f.deps.store.lastReview = () => ({ headSha: 'other', baseSha: 'b', baseRef: 'main', event: 'APPROVE' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(calls, []);
  assert.equal(f.posts.at(-1)?.passed, false);
  assert.doesNotMatch(f.summaries.at(-1)!, /could not tell/, "an approval of Falcon's that nothing places is not named");
});

test('a carried approval is compared again when the PR moves to another base', async () => {
  const calls: string[] = [];
  const p = pull(1, { headSha: 'new1', baseAt: 'main', verdicts: [approved('lee', 'old1')] });
  const f = fixture([p], { branches: ['release'], sameChange: async (_n, oldSha, headSha) => { calls.push(`${oldSha}:${headSha}`); return true; } });
  f.around('old1');
  await sweepGate(f.deps, REPO, T0);
  Object.assign(p, { baseRef: 'release', updatedAt: '2026-11-10T10:07:00Z' });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(calls, ['old1:new1', 'old1:new1']);
});

test('the check names an approval carried from an older commit, and one that no longer counts', async () => {
  let same = true;
  const p = pull(1, { headSha: 'b'.repeat(40), verdicts: [approved('lee', 'a'.repeat(40))] });
  const f = fixture([p], { sameChange: async () => same });
  f.around('a'.repeat(40));
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, true);
  assert.match(f.summaries.at(-1)!, /Approved by lee on aaaaaaaaaaaa, an earlier commit with the same change\./);
  assert.doesNotMatch(f.summaries.at(-1)!, /Nobody has approved/);

  same = false;
  p.headSha = 'c'.repeat(40);
  p.updatedAt = '2026-11-10T10:07:00Z';
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.equal(f.posts.at(-1)?.passed, false);
  assert.match(f.summaries.at(-1)!, /lee approved aaaaaaaaaaaa, but the change is different on this commit, so that approval does not count here\. Approve this commit again\./);
});

test("a person's approval counts when the gate saw the same head and base on both sides of it", async () => {
  // A base other than the default branch, so GitHub's timeline cannot bind the approval: only the observations can.
  const p = pull(1, { baseRef: 'release' });
  const f = fixture([p], { branches: ['release'] });
  f.clock.at = Date.parse('2026-11-10T10:00:00Z');
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, false);
  p.verdicts = [approved('lee', 'sha1')];
  p.updatedAt = APPROVED_AT;
  f.clock.at = Date.parse('2026-11-10T10:06:00Z');
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  assert.match(f.summaries.at(-1)!, /^Approved on this commit by lee\./);
});

test('an approval in the same second as an observation binds on both sides', async () => {
  const f = fixture([pull(1, { baseRef: 'release', verdicts: [approved('lee', 'sha1', '2026-11-10T10:05:00Z')] })], { branches: ['release'] });
  // The gate records what it sees before it counts, so this pass's own observation is on both sides.
  f.clock.at = Date.parse('2026-11-10T10:05:00Z');
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, true);
});

test('with no observations, an approval of the head given on the default branch counts', async () => {
  const asked: number[] = [];
  const f = fixture([pull(1, { verdicts: [approved('lee', 'sha1')] })]);
  f.deps.github.baseRefAt = async (_repo, _number, atMs) => { asked.push(atMs); return 'main'; };
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(asked, [Date.parse(APPROVED_AT)]);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
});

test('I6: with no observations, an approval on another base does not count and says to approve again', async () => {
  // Still on the other base: GitHub's timeline is trusted only for the default branch.
  const release = fixture([pull(1, { baseRef: 'release', verdicts: [approved('lee', 'sha1')] })], { branches: ['release'] });
  await sweepGate(release.deps, REPO, T0);
  assert.deepEqual(release.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.ok(release.summaries.at(-1)!.includes(couldNotTell('lee')), release.summaries.at(-1));
  // On main now, but GitHub's timeline puts the approval on another base.
  const moved = fixture([pull(1, { verdicts: [approved('lee', 'sha1')] })]);
  moved.deps.github.baseRefAt = async () => 'feat-a';
  await sweepGate(moved.deps, REPO, T0);
  assert.equal(moved.posts.at(-1)?.passed, false);
  assert.ok(moved.summaries.at(-1)!.includes(couldNotTell('lee')), moved.summaries.at(-1));
});

test('I2: a PR moved to main with the same head waits until its change is the same', async () => {
  for (const same of [false, true]) {
    const calls: string[] = [];
    const f = fixture([pull(1, { baseAt: 'feat-a', verdicts: [approved('lee', 'sha1')] })], { sameChange: async (n, oldSha, headSha, _governs, oldBase, baseRef, mergeBase) => { calls.push(`${n}:${oldSha}:${headSha}:${oldBase}:${baseRef}:${mergeBase}`); return same; } });
    // The gate saw the PR on feat-a around the approval, and the timeline agrees. The PR is on main now.
    f.around('sha1', 'feat-a', 'mb-feat');
    await sweepGate(f.deps, REPO, T0);
    assert.deepEqual(calls, ['1:sha1:sha1:mb-feat:main:mb-tip-main']);
    assert.equal(f.posts.at(-1)?.passed, same);
    assert.match(f.summaries.at(-1)!, same ? /Approved by lee on sha1, an earlier commit with the same change\./ : /lee approved sha1, but the change is different on this commit, so that approval does not count here\./);
  }
});

test('I3: a parent force-push that moves the merge base makes the PR wait', async () => {
  const calls: string[] = [];
  const f = fixture([pull(1, { baseRef: 'feat-a', mergeBase: 'm0', verdicts: [approved('lee', 'sha1')] })], { branches: ['feat-a'], sameChange: async (_n, oldSha, headSha, _governs, oldBase, _baseRef, mergeBase) => { calls.push(`${oldSha}:${headSha}:${oldBase}:${mergeBase}`); return false; } });
  f.around('sha1', 'feat-a', 'm1');
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(calls, ['sha1:sha1:m1:m0']);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  // R3: the saved decision is for this head on this base and merge base.
  const saved = decodeState(f.cursors.get(`gate:${REPO}#1`) ?? null);
  assert.deepEqual(saved && { headSha: saved.headSha, baseRef: saved.baseRef, mergeBase: saved.mergeBase, verdict: saved.verdict }, { headSha: 'sha1', baseRef: 'feat-a', mergeBase: 'm0', verdict: 'wait' });
});

test('a review re-pointed to the new head after a same-change restack carries', async () => {
  const calls: string[] = [];
  // GitHub moved lee's review to h2; the gate saw h1 around the time it was given.
  const f = fixture([pull(1, { headSha: 'h2', mergeBase: 'mb2', verdicts: [approved('lee', 'h2')] })], { sameChange: async (_n, oldSha, headSha, _governs, oldBase, _baseRef, mergeBase) => { calls.push(`${oldSha}:${headSha}:${oldBase}:${mergeBase}`); return true; } });
  f.around('h1', 'main', 'mb1');
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(calls, ['h1:h2:mb1:mb2']);
  assert.deepEqual(f.posts.at(-1), { sha: 'h2', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  assert.match(f.summaries.at(-1)!, /Approved by lee on h1, an earlier commit with the same change\./);
});

test('I4: the carry cache key holds the PR number, the binding and the current base', async () => {
  const f = fixture([pull(4, { headSha: 'h2', mergeBase: 'mb2', baseAt: 'feat-a', verdicts: [approved('lee', 'h2')] })], { sameChange: async () => true });
  f.around('h1', 'feat-a', 'mb1', 4);
  await sweepGate(f.deps, REPO, T0);
  // The rules hash too, so a change to the pack compares again.
  const rules = f.cursors.get(`gate:${REPO}:full`)!.split(':')[0];
  assert.deepEqual([...f.cursors].filter(([k]) => k.startsWith('gate-carry:')), [[`gate-carry:${REPO}#4:h1:feat-a:mb1:h2:main:mb2:${rules}`, 'true']]);
});

test('I5: a dry run writes no observations, no cache entries and no decisions', async () => {
  let compared = 0;
  const f = fixture([pull(1, { baseAt: 'feat-a', verdicts: [approved('lee', 'sha1'), approved(FALCON, 'sha1')] })], { dryRun: true, sameChange: async () => { compared++; return true; } });
  f.deps.store.lastReview = () => ({ headSha: 'sha1', baseSha: 'tip-feat-a', baseRef: 'feat-a', event: 'APPROVE' });
  const old = '2026-10-01T00:00:00Z'; // Past the retention, so a real full recheck would delete it.
  f.observe(old, 'sha1', 'feat-a');
  f.around('sha1', 'feat-a', 'mb-feat');
  assert.equal(await sweepGate(f.deps, REPO, T0), 0);
  assert.equal(compared, 2, 'the dry run still looks up, binds and compares both approvals');
  assert.deepEqual(f.posts, []);
  assert.deepEqual([...f.cursors], [], 'no lookup, cache entry or decision saved');
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0).after, null, 'no observation');
  assert.equal(f.db.gateObservationsAround(REPO, 1, Date.parse(old)).before?.atMs, Date.parse(old), 'nothing deleted');
});

test("Falcon's approval binds to the base it reviewed", async () => {
  const asked: number[] = [];
  const f = fixture([pull(1, { approvers: [FALCON] })]);
  f.deps.store.lastReview = () => ({ headSha: 'sha1', baseSha: 'tip-main', baseRef: 'main', event: 'APPROVE' });
  f.deps.github.baseRefAt = async (_repo, _number, atMs) => { asked.push(atMs); return 'main'; };
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  assert.deepEqual(asked, [], 'the saved review is enough');
  // The same head reviewed on feat-a: the change on main is compared, and here it differs.
  const calls: string[] = [];
  const g = fixture([pull(1, { approvers: [FALCON] })], { sameChange: async (_n, oldSha, headSha, _governs, oldBase, baseRef, mergeBase) => { calls.push(`${oldSha}:${headSha}:${oldBase}:${baseRef}:${mergeBase}`); return false; } });
  g.deps.store.lastReview = () => ({ headSha: 'sha1', baseSha: 'tip-feat-a', baseRef: 'feat-a', event: 'APPROVE' });
  await sweepGate(g.deps, REPO, T0);
  assert.deepEqual(calls, ['sha1:sha1:mb-tip-feat-a:main:mb-tip-main']);
  assert.equal(g.posts.at(-1)?.passed, false);
});

test("an approval with an unreadable time does not count, but Falcon's saved review still binds", async () => {
  const asked: number[] = [];
  const f = fixture([pull(1, { verdicts: [approved('lee', 'sha1', '')] })]);
  f.deps.github.baseRefAt = async (_repo, _number, atMs) => { asked.push(atMs); return 'main'; };
  f.around('sha1');
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, false);
  assert.ok(f.summaries.at(-1)!.includes(couldNotTell('lee')), f.summaries.at(-1));
  assert.deepEqual(asked, []);
  const g = fixture([pull(1, { verdicts: [approved(FALCON, 'sha1', '')] })]);
  g.deps.store.lastReview = () => ({ headSha: 'sha1', baseSha: 'tip-main', baseRef: 'main', event: 'APPROVE' });
  await sweepGate(g.deps, REPO, T0);
  assert.equal(g.posts.at(-1)?.passed, true);
});

test('a failed lookup of where an approval was given waits and is tried again on the next pass', async () => {
  let fail = true;
  const f = fixture([pull(1, { verdicts: [approved('lee', 'sha1')] })]);
  f.deps.github.baseRefAt = async () => { if (fail) throw new Error('GitHub is down'); return 'main'; };
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, false);
  assert.doesNotMatch(f.summaries.at(-1)!, /could not tell/, 'a failed lookup says nothing about the approval');
  fail = false;
  await sweepGate(f.deps, REPO, T0 + 31 * MINUTE);
  assert.equal(f.posts.at(-1)?.passed, true);
});

test('a full recheck deletes observations older than 14 days', async () => {
  const f = fixture([pull(1)]);
  const day = 24 * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  f.observe(iso(T0 - 15 * day), 'sha1');
  f.observe(iso(T0 - 13 * day), 'sha1');
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0 - 14 * day).before, null);
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0 - 14 * day).after?.atMs, T0 - 13 * day);
});

test('an approval the gate saw given on another base does not count on main, even when the timeline says main', async () => {
  // On main now, and GitHub's timeline says main at the approval, but the gate saw feat-a on both sides of it.
  const f = fixture([pull(1, { verdicts: [approved('lee', 'sha1')] })]);
  f.around('sha1', 'feat-a', 'mb-feat');
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.ok(f.summaries.at(-1)!.includes(couldNotTell('lee')), f.summaries.at(-1));
});

test('an observation is stamped when the PR was read, not when the merge base came back', async () => {
  const f = fixture([pull(1)]);
  const { mergeBase } = f.deps.github;
  f.deps.github.mergeBase = async (repo, base, headSha) => { f.clock.at = T0 + 5 * MINUTE; return mergeBase(repo, base, headSha); };
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0 + MINUTE).before?.atMs, T0);
});

test('an approval whose observations were pruned still binds from the pair saved when both sides existed', async () => {
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on' });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha2', true]]);
  assert.equal(f.cursors.get(`gate-obs:${REPO}#2:${APPROVED_AT}`), JSON.stringify({ headSha: 'sha2', baseRef: 'feat-a', mergeBase: 'mb-tip-feat-a' }));
  // 15 days on: the full recheck deletes every observation around the approval, then judges the PR again.
  const later = T0 + 15 * 24 * 60 * MINUTE;
  f.clock.at = later;
  await sweepGate(f.deps, REPO, later);
  assert.equal(f.db.gateObservationsAround(REPO, 2, Date.parse(APPROVED_AT)).before, null, 'pruned');
  assert.equal(f.posts.length, 1, 'nothing new to post');
  assert.equal(decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null)?.verdict, 'pass');
  // Seen only before the approval so far: nothing is saved, since a later observation can still arrive.
  const g = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on' });
  g.clock.at = Date.parse('2026-11-10T10:00:00Z');
  await sweepGate(g.deps, REPO, T0);
  assert.equal(g.cursors.has(`gate-obs:${REPO}#2:${APPROVED_AT}`), false);
});

test("a queue commit waits when its PR's pass is for another branch", async () => {
  const f = fixture([pull(1, { baseRef: 'release', verdicts: [approved('lee', 'sha1')] }), pull(2)], { branches: ['release'] });
  f.around('sha1', 'release');
  f.queue.push({ number: 1, headSha: 'q-main', branch: 'main' }, { number: 1, headSha: 'q-release', branch: 'release' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', true], ['sha2', false], ['q-release', true], ['q-main', false]]);
});

test('an approval given while the PR sat on a base the gate does not judge does not count after it moves back', async () => {
  const p = pull(1);
  const f = fixture([p]);
  f.clock.at = Date.parse('2026-11-10T10:00:00Z');
  await sweepGate(f.deps, REPO, T0); // Seen on main.
  Object.assign(p, { baseRef: 'feat-a', updatedAt: '2026-11-10T10:01:00Z' });
  f.clock.at = Date.parse('2026-11-10T10:01:30Z');
  await sweepGate(f.deps, REPO, T0 + MINUTE); // On feat-a: not judged, so not seen.
  // Approved on feat-a, where the diff is only the PR's own change, then moved back with the same head and merge base.
  // The observations on both sides agree on main; GitHub's timeline says feat-a.
  Object.assign(p, { baseRef: 'main', baseAt: 'feat-a', updatedAt: '2026-11-10T10:03:00Z', verdicts: [approved('lee', 'sha1', '2026-11-10T10:02:00Z')] });
  f.clock.at = Date.parse('2026-11-10T10:03:30Z');
  await sweepGate(f.deps, REPO, T0 + 2 * MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.ok(f.summaries.at(-1)!.includes(couldNotTell('lee')), f.summaries.at(-1));
});

test("a second pass does not ask GitHub again where an approval was given or where Falcon's review started", async () => {
  const asked: string[] = [];
  const f = fixture([pull(1, { verdicts: [approved('lee', 'sha1'), approved(FALCON, 'sha1')] })]);
  f.deps.store.lastReview = () => ({ headSha: 'sha1', baseSha: 'tip-old', baseRef: 'main', event: 'APPROVE' });
  const { baseRefAt, mergeBase } = f.deps.github;
  f.deps.github.baseRefAt = async (repo, number, atMs) => { asked.push('baseRefAt'); return baseRefAt(repo, number, atMs); };
  f.deps.github.mergeBase = async (repo, baseSha, headSha) => { if (baseSha === 'tip-old') asked.push('mergeBase'); return mergeBase(repo, baseSha, headSha); };
  await sweepGate(f.deps, REPO, T0);
  await sweepGate(f.deps, REPO, T0 + 31 * MINUTE); // A full recheck judges the PR again.
  assert.deepEqual(asked, ['baseRefAt', 'mergeBase']);
  assert.equal(f.posts.at(-1)?.passed, true);
});

test('a move of the base tip while the PR is being read costs one more read', async () => {
  const f = fixture([pull(1, { approvers: ['lee'] })]);
  let reads = 0;
  f.hooks.onFiles = (x) => { if (reads++ === 0) x.baseSha = 'tip-main-2'; };
  await sweepGate(f.deps, REPO, T0);
  assert.equal(reads, 2);
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0).before?.baseSha, 'tip-main-2');
  assert.equal(f.posts.at(-1)?.passed, true);
});

test('an approval in the same second as a base change does not count, since the order inside a second is unknown', async () => {
  // GitHub's timeline, read by the real reader: away to feat-a, then back to main at 10:05:00.8. The approval came at
  // 10:05:00.2. GitHub gives both as 10:05:00.
  const nodes = [
    { __typename: 'BaseRefChangedEvent', createdAt: '2026-11-10T10:01:00Z', previousRefName: 'main', currentRefName: 'feat-a' },
    { __typename: 'BaseRefChangedEvent', createdAt: '2026-11-10T10:05:00Z', previousRefName: 'feat-a', currentRefName: 'main' },
  ];
  const timeline = new OctokitGitHub({ graphql: async () => ({ repository: { pullRequest: { baseRefName: 'main', timelineItems: { nodes } } } }) } as unknown as Octokit, null);
  const approval = [approved('lee', 'sha1', '2026-11-10T10:05:00Z')];
  // Seen on main before the trip and after it.
  const seen = fixture([pull(1, { verdicts: approval })]);
  seen.deps.github.baseRefAt = (repo, number, atMs) => timeline.baseRefAt(repo, number, atMs);
  seen.around('sha1');
  // Never seen: only the default-branch timeline rule could bind it.
  const unseen = fixture([pull(1, { verdicts: approval })]);
  unseen.deps.github.baseRefAt = (repo, number, atMs) => timeline.baseRefAt(repo, number, atMs);
  for (const f of [seen, unseen]) {
    await sweepGate(f.deps, REPO, T0);
    assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
    assert.ok(f.summaries.at(-1)!.includes(couldNotTell('lee')), f.summaries.at(-1));
  }
});

// Stack 7: PR 1 into main at the bottom, PR 2 on feat-a above it.
const inStack = (position: number): StackRef => ({ number: 7, baseRef: 'main', position });
const STACK_PASS = ' This PR is in a stack. The gate judged its own change against `feat-a`. The stack merges only when every PR below it also passes.';
const stackWait = (base: string) => ` The gate judges this PR on its own change against \`${base}\`.`;

test('off: a stacked PR is not judged', async () => {
  for (const stacks of [undefined, 'off'] as const) {
    const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), approvers: ['lee'] })], { stacks });
    assert.equal(await sweepGate(f.deps, REPO, T0), 0);
    assert.deepEqual(f.posts, []);
    assert.equal(f.db.gateObservationsAround(REPO, 2, T0).before, null);
  }
});

test('on: a stacked PR is judged on its own change and the pass names its base', async () => {
  const f = fixture([
    pull(1, { stack: inStack(1) }),
    pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] }),
    pull(3, { baseRef: 'br2', stack: inStack(3) }),
  ], { stacks: 'on' });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  f.queue.push({ number: 2, headSha: 'q-feat', branch: 'feat-a' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts, [
    { sha: 'sha1', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' },
    { sha: 'sha2', passed: true, title: 'Approved for its own change on feat-a' },
    { sha: 'sha3', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' },
  ], 'the queue of a stacked base is not read');
  assert.doesNotMatch(f.summaries[0]!, /stack|own change/, 'a PR into main keeps its copy');
  assert.ok(f.summaries[1]!.endsWith(STACK_PASS), f.summaries[1]);
  assert.ok(f.summaries[2]!.endsWith(stackWait('br2')), f.summaries[2]);
  const saved = decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null);
  assert.deepEqual(saved && [saved.baseRef, saved.mergeBase, saved.verdict], ['feat-a', 'mb-tip-feat-a', 'pass']);
});

test('shadow: a stacked PR is logged, not posted, and nothing is saved', async (t) => {
  let compared = 0;
  const f = fixture([
    pull(1, { stack: inStack(1) }),
    pull(2, { headSha: 'new2', baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'old2'), approved(FALCON, 'old2')] }),
  ], { stacks: 'shadow', sameChange: async () => { compared++; return true; } });
  // Every kind of lookup a real pass saves: where lee approved, the merge base of Falcon's review, the comparison.
  f.deps.store.lastReview = () => ({ headSha: 'old2', baseSha: 'tip-old', baseRef: 'feat-a', event: 'APPROVE' });
  f.around('old2', 'feat-a', 'mb-tip-feat-a', 2);
  const info = t.mock.method(f.deps.log, 'info');
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.map((x) => x.sha), ['sha1']);
  assert.equal(compared, 2, 'judged in full');
  const lines = info.mock.calls.map((c) => [c.arguments[1], (c.arguments[0] as { number?: number; verdict?: string }).number, (c.arguments[0] as { verdict?: string }).verdict]);
  assert.deepEqual(lines.filter(([msg]) => String(msg).startsWith('merge gate decided')), [['merge gate decided', 1, 'wait'], ['merge gate decided (shadow)', 2, 'pass']]);
  // The rollout compares these lines with GitHub, so they carry the base, the merge base and each older approval.
  const shadowLine = info.mock.calls.find((c) => c.arguments[1] === 'merge gate decided (shadow)')!.arguments[0] as Record<string, unknown>;
  assert.deepEqual([shadowLine['base'], shadowLine['mergeBase'], shadowLine['carried'], shadowLine['stale'], shadowLine['unbound']], ['feat-a', 'mb-tip-feat-a', [{ login: 'lee', sha: 'old2' }, { login: FALCON, sha: 'old2' }], [], []]);
  assert.deepEqual([...f.cursors.keys()].sort(), [`gate:${REPO}`, `gate:${REPO}#1`, `gate:${REPO}:full`], 'no lookup, cache entry or decision for PR 2');
  assert.equal(f.db.gateObservationsAround(REPO, 2, T0).after, null, 'no observation');
});

test('a push to the PR below judges the PRs above it in the same pass', async () => {
  // PR 1 was touched after PR 2, so after the first pass only R3 brings PR 2 back.
  const bottom = pull(1, { stack: inStack(1), updatedAt: '2026-11-10T10:06:00Z' });
  const top = pull(2, { baseRef: 'br1', stack: inStack(2), updatedAt: APPROVED_AT, verdicts: [approved('lee', 'sha2')] });
  const f = fixture([bottom, top], { stacks: 'on', sameChange: async () => false });
  f.around('sha2', 'br1', 'mb-tip-br1', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', false], ['sha2', true]]);
  // A push to PR 1 moves its branch, the base of PR 2. Only PR 1's update time moves.
  Object.assign(bottom, { headSha: 'sha1b', updatedAt: '2026-11-10T10:30:00Z' });
  top.baseSha = 'tip-br1-2';
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.slice(2).map((x) => [x.sha, x.passed]), [['sha1b', false], ['sha2', false]]);
  assert.match(f.summaries.at(-1)!, /lee approved sha2, but the change is different on this commit/);
});

test("a PR on another PR's branch without a GitHub stack is not judged", async () => {
  const f = fixture([pull(1), pull(2, { baseRef: 'br1', approvers: ['lee'] })], { stacks: 'on' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => x.sha), ['sha1']);
});

test('a PR that leaves its stack and moves to main with the same head waits', async () => {
  const p = pull(2, { baseRef: 'feat-a', baseAt: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] });
  const f = fixture([p], { stacks: 'on', sameChange: async () => false });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: true, title: 'Approved for its own change on feat-a' });
  Object.assign(p, { stack: null, baseRef: 'main', updatedAt: '2026-11-10T10:30:00Z' });
  // No longer requested: its saved decision keeps it judged.
  await sweepGate({ ...f.deps, requested: new Set() }, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.doesNotMatch(f.summaries.at(-1)!, /own change against/);
});

test("I6 on a stack: a person's approval with no observations does not count", async () => {
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.ok(f.summaries.at(-1)!.includes(couldNotTell('lee')), f.summaries.at(-1));
  assert.ok(f.summaries.at(-1)!.endsWith(stackWait('feat-a')), f.summaries.at(-1));
});

test('config: gate.stacks defaults to off and accepts shadow and on', () => {
  assert.equal(ConfigSchema.parse({}).gate.stacks, 'off');
  for (const stacks of ['shadow', 'on'] as const) assert.equal(ConfigSchema.parse({ gate: { stacks } }).gate.stacks, stacks);
  assert.throws(() => ConfigSchema.parse({ gate: { stacks: 'yes' } }));
});

const WITHDRAWN = { title: 'Waiting: stacked PRs are not judged now', summary: 'The gate does not judge stacked PRs now, so an earlier pass on this commit no longer counts.' };

test('on → off or shadow: a stacked PR that passed gets one wait and its decision becomes wait', async () => {
  for (const stacks of ['off', 'shadow'] as const) {
    const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on' });
    f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
    await sweepGate(f.deps, REPO, T0);
    assert.equal(f.posts.at(-1)?.passed, true);
    const keys = [...f.cursors.keys()].sort();
    f.clock.at = T0 + MINUTE;
    assert.equal(await sweepGate({ ...f.deps, stacks }, REPO, T0 + MINUTE), 1, stacks);
    assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: false, title: WITHDRAWN.title });
    assert.equal(f.summaries.at(-1), WITHDRAWN.summary);
    assert.equal(decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null)?.verdict, 'wait');
    assert.deepEqual([...f.cursors.keys()].sort(), keys, 'the decision only: no new cache entry');
    assert.equal(f.db.gateObservationsAround(REPO, 2, T0 + 1).after, null, 'no observation');
    assert.equal(await sweepGate({ ...f.deps, stacks }, REPO, T0 + 2 * MINUTE), 0, `${stacks}: withdrawn once`);
  }
});

test('a dry run does not withdraw a stacked pass', async () => {
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on' });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  const decision = f.cursors.get(`gate:${REPO}#2`);
  assert.equal(await sweepGate({ ...f.deps, stacks: 'off', dryRun: true }, REPO, T0 + MINUTE), 0);
  assert.equal(f.posts.length, 1);
  assert.equal(f.cursors.get(`gate:${REPO}#2`), decision);
});

test('after a switch to off, a force-push back to a commit that passed under on gets a wait on that commit', async () => {
  const p = pull(2, { headSha: 'h1', baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'h1')] });
  const f = fixture([p], { stacks: 'on' });
  f.around('h1', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'h1', passed: true, title: 'Approved for its own change on feat-a' });
  // A push under on: the gate judges h2, and the saved decision is h2's wait. h1 keeps its pass on GitHub.
  Object.assign(p, { headSha: 'h2', updatedAt: '2026-11-10T10:30:00Z' });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'h2', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  const off = { ...f.deps, stacks: 'off' as const };
  assert.equal(await sweepGate(off, REPO, T0 + 2 * MINUTE), 0, 'h2 already waits');
  Object.assign(p, { headSha: 'h1', updatedAt: '2026-11-10T10:40:00Z' });
  assert.equal(await sweepGate(off, REPO, T0 + 3 * MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'h1', passed: false, title: WITHDRAWN.title });
  assert.equal(await sweepGate(off, REPO, T0 + 4 * MINUTE), 0, 'no change, nothing posted');
});

test('a push between the last on pass and the first off pass: the new head waits, and so does the old one when it comes back', async () => {
  const p = pull(2, { headSha: 'h1', baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'h1')] });
  const f = fixture([p], { stacks: 'on' });
  f.around('h1', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts.at(-1)?.passed, true);
  const off = { ...f.deps, stacks: 'off' as const };
  p.headSha = 'h2';
  assert.equal(await sweepGate(off, REPO, T0 + MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'h2', passed: false, title: WITHDRAWN.title });
  assert.equal(await sweepGate(off, REPO, T0 + 2 * MINUTE), 0, 'no change, nothing posted');
  p.headSha = 'h1';
  assert.equal(await sweepGate(off, REPO, T0 + 3 * MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'h1', passed: false, title: WITHDRAWN.title });
});

test('a shadow pass does not judge the bottom PR of a stack when nothing changed', async () => {
  const f = fixture([pull(1, { stack: inStack(1) }), pull(2, { baseRef: 'br1', stack: inStack(2) })], { stacks: 'shadow' });
  await sweepGate(f.deps, REPO, T0);
  f.clock.at = T0 + MINUTE;
  await sweepGate(f.deps, REPO, T0 + MINUTE); // PR 2, the newest, is read again by `>=`; it did not change.
  assert.equal(f.db.gateObservationsAround(REPO, 1, T0 + MINUTE).before?.atMs, T0, 'PR 1 was not judged, so nothing was observed');
});

test('a switch of gate.stacks re-judges every PR at once', async () => {
  // PR 3 is the newest, so after the first pass PR 2 is judged again only on a full pass.
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), updatedAt: APPROVED_AT, verdicts: [approved('lee', 'sha2')] }), pull(3, { updatedAt: '2026-11-10T10:07:00Z' })], { stacks: 'on' });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  await sweepGate(f.deps, REPO, T0);
  await sweepGate({ ...f.deps, stacks: 'off' }, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: false, title: WITHDRAWN.title });
  await sweepGate(f.deps, REPO, T0 + 2 * MINUTE);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: true, title: 'Approved for its own change on feat-a' });
});

test('a stacked PR into a listed extra branch is judged as before under shadow, and is not withdrawn', async () => {
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'shadow', branches: ['feat-a'] });
  f.around('sha2', 'feat-a', 'mb-tip-feat-a', 2);
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: true, title: 'Approved by Launch Engineering or Falcon' });
  assert.doesNotMatch(f.summaries.at(-1)!, /stack/);
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 0);
  assert.equal(decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null)?.verdict, 'pass');
});

test('the merge base of the change now is read against the base branch, not a base tip GitHub has not moved yet', async () => {
  const f = fixture([pull(2, { baseRef: 'feat-a', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })], { stacks: 'on', sameChange: async () => false });
  // lee approved on merge base m1. Then feat-a was force-pushed: its tip now gives m2, but the PR still shows the old tip.
  f.around('sha2', 'feat-a', 'm1', 2);
  const bases: string[] = [];
  f.deps.github.mergeBase = async (_repo, base) => { bases.push(base); return base === 'heads/feat-a' ? 'm2' : 'm1'; };
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha2', passed: false, title: 'Waiting for Launch Engineering or Falcon to approve' });
  assert.equal(decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null)?.mergeBase, 'm2');
  assert.deepEqual(bases, ['heads/feat-a'], 'the branch is named as heads/<name>, so a tag of that name cannot stand in for it');
});

test('a pass with nothing changed reads no stacked PR, under on and under shadow; a push in the same second still does', async () => {
  for (const stacks of ['on', 'shadow'] as const) {
    // PR 1, at the bottom, is the newest, so `>=` reads it on every pass.
    const bottom = pull(1, { stack: inStack(1), updatedAt: '2026-11-10T10:06:00Z' });
    const f = fixture([bottom, pull(2, { baseRef: 'br1', stack: inStack(2) }), pull(3, { baseRef: 'br2', stack: inStack(3) })], { stacks });
    const reads: number[] = [];
    const { pullState } = f.deps.github;
    f.deps.github.pullState = async (repo, number) => { reads.push(number); return pullState(repo, number); };
    await sweepGate(f.deps, REPO, T0);
    reads.length = 0;
    await sweepGate(f.deps, REPO, T0 + MINUTE);
    assert.deepEqual([...new Set(reads)], [1], stacks);
    // A push to PR 1 in the second the gate last saw: the update time does not move, the head does.
    bottom.headSha = 'sha1b';
    reads.length = 0;
    await sweepGate(f.deps, REPO, T0 + 2 * MINUTE);
    assert.deepEqual([...new Set(reads)], [1, 2, 3], `${stacks}: the PRs above are judged again`);
  }
});

// A parent pushed in the same second as its last update, then the child's read fails: the next pass has nothing but the
// retry cursor to choose the child, and its queue commit must not pass on the child's decision for the old merge base.
async function failedChildFixture(stacks: 'on' = 'on', dryRun = false) {
  const bottom = pull(1, { stack: inStack(1), approvers: [FALCON], updatedAt: '2026-11-10T10:06:00Z' });
  const pulls = [bottom, pull(2, { baseRef: 'br1', stack: inStack(2), verdicts: [approved('lee', 'sha2')] })];
  const f = fixture(pulls, { stacks, dryRun });
  f.deps.github.stackMembers = membersOf(pulls);
  f.around('sha2', 'br1', 'mb-tip-br1', 2);
  f.queue.push({ number: 2, headSha: 'q2', branch: 'main' });
  const reads: number[] = [];
  const state = { down: false };
  const { pullState } = f.deps.github;
  f.deps.github.pullState = async (repo, number) => { reads.push(number); if (state.down && number === 2) throw new Error('GitHub is down'); return pullState(repo, number); };
  return { f, bottom, reads, state };
}

test('a child whose read failed is judged again on the next pass, and its queue commit waits until then', async () => {
  const { f, bottom, reads, state } = await failedChildFixture();
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.filter((x) => x.sha === 'q2').map((x) => x.passed), [true]);
  // Pass N: PR 1 is pushed inside the second of its update time, and PR 2's read throws.
  bottom.headSha = 'sha1b';
  state.down = true;
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.filter((x) => x.sha === 'q2').map((x) => x.passed), [true, false]);
  assert.deepEqual(JSON.parse(f.cursors.get(`gate-retry:${REPO}`) ?? 'null'), { prs: [2], stacks: [7] });
  // Pass N+1: PR 1 is no longer changed, and nothing else would choose PR 2. The cursor does, so PR 2 is read again
  // and its queue commit keeps waiting.
  reads.length = 0;
  await sweepGate(f.deps, REPO, T0 + 2 * MINUTE);
  assert.ok(reads.includes(2), 'PR 2 is read again');
  assert.deepEqual(f.posts.filter((x) => x.sha === 'q2').map((x) => x.passed), [true, false]);
  assert.ok(f.cursors.get(`gate-retry:${REPO}`), 'still carried while it fails');
  // Pass N+2: PR 2 reads fine, gets judged on the new merge base, the cursor clears and the commit passes.
  state.down = false;
  await sweepGate(f.deps, REPO, T0 + 3 * MINUTE);
  assert.equal(f.cursors.get(`gate-retry:${REPO}`), '');
  assert.deepEqual(f.posts.filter((x) => x.sha === 'q2').map((x) => x.passed), [true, false, true]);
  // Nothing is carried now, so a quiet pass reads no PR above the bottom.
  reads.length = 0;
  await sweepGate(f.deps, REPO, T0 + 4 * MINUTE);
  assert.deepEqual([...new Set(reads)], [1]);
});

test('a dry run writes no retry cursor', async () => {
  const { f, state } = await failedChildFixture('on', true);
  state.down = true;
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.cursors.has(`gate-retry:${REPO}`), false);
});

test('a fork PR in a stack is never judged as stacked', async () => {
  const f = fixture([pull(1, { stack: inStack(1) }), pull(2, { baseRef: 'br1', stack: inStack(2), fromFork: true, approvers: ['lee'] })], { stacks: 'on' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => x.sha), ['sha1']);
});

// Queue commits for a stack: PR 1 into main, PR 2 on br1, PR 3 on br2. One real sweep sets every cursor of the pass;
// then the decisions are overwritten by hand, and the later sweeps are incremental, so they leave them alone.
const settle = async (f: ReturnType<typeof fixture>, pulls: Pull[], states: Record<number, Partial<Parameters<typeof encodeState>[0]>> = {}) => {
  await sweepGate(f.deps, REPO, T0);
  // The incremental cursor sits after every update time (the newest PR itself is judged again at `>=`).
  f.cursors.set(`gate:${REPO}`, '2026-11-10T11:00:00Z');
  f.posts.length = 0;
  f.summaries.length = 0;
  for (const p of pulls) {
    const s = states[p.number];
    f.cursors.set(`gate:${REPO}#${p.number}`, encodeState({ headSha: p.headSha, baseRef: p.baseRef, mergeBase: 'mb', verdict: 'pass', detail: '', ...s }));
  }
};

async function queueStack(over: { states?: Record<number, Partial<Parameters<typeof encodeState>[0]>>; closed?: number[]; throws?: boolean; bottom?: Partial<Pull> } = {}) {
  const pulls = [1, 2, 3].map((n) => pull(n, { baseRef: n === 1 ? 'main' : `br${n - 1}`, stack: inStack(n), ...(n === 1 ? over.bottom : {}) }));
  const f = fixture(pulls, { stacks: 'on' });
  f.deps.github.stackMembers = async () => {
    if (over.throws) throw new Error('GitHub is down');
    return pulls.map((p, i) => ({ number: p.number, position: i + 1, open: !over.closed?.includes(p.number), baseRef: p.baseRef, headRef: `br${p.number}`, headSha: p.headSha }));
  };
  await settle(f, pulls, over.states);
  f.queue.push({ number: 3, headSha: 'q3', branch: 'main' });
  return f;
}

test('I1: a queue commit for the top of a stack waits while a PR below has no current pass', async () => {
  const f = await queueStack({ states: { 2: { verdict: 'wait' } } });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q3', false]]);
  assert.equal(f.summaries[0], 'Merge queue commit for #3. A PR in its stack has no current pass: #2.');
});

test('a queue commit for the top of a stack passes when the whole chain passes and closes on main', async () => {
  const f = await queueStack();
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q3', true]]);
});

test('a queue commit waits when a member below was pushed after its pass', async () => {
  const f = await queueStack({ states: { 1: { headSha: 'older' } } });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q3', false]]);
  assert.ok(f.summaries[0]!.endsWith('#1.'), f.summaries[0]);
});

test('a queue commit waits when a member below was closed without merging', async () => {
  // PR 2 is gone from the open members, so PR 3 no longer starts on a chain that closes on main.
  const f = await queueStack({ closed: [2] });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q3', false]]);
});

test('a PR alone: its queue commit passes only with a saved pass for the queue branch', async () => {
  const pulls = [pull(1), pull(2)];
  const f = fixture(pulls);
  await settle(f, pulls, { 2: { baseRef: 'release' } });
  f.queue.push({ number: 1, headSha: 'q1', branch: 'main' }, { number: 2, headSha: 'q2', branch: 'main' }, { number: 9, headSha: 'q9', branch: 'main' });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q1', true], ['q2', false], ['q9', false]], 'a PR missing from the listing waits');
});

test('a queue commit waits, and a pass it had stops, when the stack cannot be read; the rest of the queue is still posted', async () => {
  const pulls = [pull(1, { stack: inStack(1) }), pull(2)];
  const f = fixture(pulls, { stacks: 'on' });
  let asked = 0;
  let down = false;
  f.deps.github.stackMembers = async () => { asked++; if (down) throw new Error('GitHub is down'); return [{ number: 1, position: 1, open: true, baseRef: 'main', headRef: 'br1', headSha: 'sha1' }]; };
  await settle(f, pulls);
  f.queue.push({ number: 1, headSha: 'q1', branch: 'main' }, { number: 2, headSha: 'q2', branch: 'main' });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q1', true], ['q2', true]]);
  f.posts.length = 0;
  f.summaries.length = 0;
  down = true;
  f.cursors.delete(`gateq:${REPO}:q2`);
  asked = 0;
  await sweepGate(f.deps, REPO, T0 + 2 * MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q1', false], ['q2', true]], 'the commit that had passed now waits');
  assert.equal(f.summaries[0], "Merge queue commit for #1. It carries the decision on the pull request's own commit.");
  assert.equal(f.cursors.get(`gateq:${REPO}:q1`), 'false');
  assert.equal(asked, 1, 'a PR with no stack never asks for one');
});

// The members of a stack as GitHub lists them, bottom first, read live from the PRs.
const membersOf = (pulls: Pull[], closed: number[] = []) => async () => pulls.map((p, i) => ({ number: p.number, position: i + 1, open: !closed.includes(p.number), baseRef: p.baseRef, headRef: `br${p.number}`, headSha: p.headSha }));

test('a queue commit named after the bottom of a stack waits while a PR above it has no current pass', async () => {
  const top = pull(2, { baseRef: 'br1', stack: inStack(2), verdicts: [approved('lee', 'sha2')] });
  const pulls = [pull(1, { stack: inStack(1), approvers: [FALCON] }), top];
  const f = fixture(pulls, { stacks: 'on' });
  f.deps.github.stackMembers = membersOf(pulls);
  f.around('sha2', 'br1', 'mb-tip-br1', 2);
  // GitHub may name the merge group of the whole stack after its bottom PR.
  f.queue.push({ number: 1, headSha: 'q1', branch: 'main' });
  await sweepGate(f.deps, REPO, T0);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', true], ['sha2', true], ['q1', true]]);
  // lee asks for changes on PR 2. A review moves the PR's update time.
  Object.assign(top, { updatedAt: '2026-11-10T10:30:00Z', verdicts: [{ login: 'lee', state: 'CHANGES_REQUESTED', sha: 'sha2', submittedAt: '2026-11-10T10:30:00Z' }] });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.slice(3).map((x) => [x.sha, x.passed]), [['sha2', false], ['q1', false]]);
  assert.equal(f.summaries.at(-1), 'Merge queue commit for #1. A PR in its stack has no current pass: #2.');
});

test('off or shadow: the bottom PR of a stack passes its own queue commit while the PR above it is open and not judged', async () => {
  for (const stacks of [undefined, 'off', 'shadow'] as const) {
    const pulls = [pull(1, { stack: inStack(1), approvers: [FALCON] }), pull(2, { baseRef: 'br1', stack: inStack(2) })];
    const f = fixture(pulls, { stacks });
    f.deps.github.stackMembers = membersOf(pulls);
    f.queue.push({ number: 1, headSha: 'q1', branch: 'main' });
    await sweepGate(f.deps, REPO, T0);
    assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1', true], ['q1', true]], String(stacks));
    assert.equal(f.cursors.has(`gate:${REPO}#2`), false, `${stacks}: PR 2 has no saved decision`);
  }
});

test('a queue commit waits when its PR is not an open member of the stack GitHub lists', async () => {
  // GitHub lists PR 1 as merged and PR 2, retargeted to main, as the only open member. PR 2 has a pass on main.
  const pulls = [pull(1, { stack: inStack(1) }), pull(2, { baseRef: 'main', stack: inStack(2) })];
  const f = fixture(pulls, { stacks: 'on' });
  f.deps.github.stackMembers = membersOf(pulls, [1]);
  await settle(f, pulls);
  f.queue.push({ number: 1, headSha: 'q1', branch: 'main' });
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['q1', false]]);
});

test('off or shadow: a queue commit for the top of a stack waits, even with passes saved under on', async () => {
  for (const stacks of ['off', 'shadow'] as const) {
    const f = await queueStack({ bottom: { approvers: [FALCON] } });
    await sweepGate({ ...f.deps, stacks }, REPO, T0 + MINUTE);
    assert.deepEqual(f.posts.filter((x) => x.sha === 'q3').map((x) => x.passed), [false], stacks);
    assert.deepEqual(f.posts.filter((x) => x.sha === 'sha1').map((x) => x.passed), [true], `${stacks}: the bottom PR itself passes`);
  }
});

test('a queue commit waits when a PR of its stack fails to be judged again after its parent moved', async () => {
  const bottom = pull(1, { stack: inStack(1), approvers: [FALCON] });
  const top = pull(2, { baseRef: 'br1', stack: inStack(2) });
  const pulls = [bottom, top];
  const f = fixture(pulls, { stacks: 'on' });
  f.deps.github.stackMembers = membersOf(pulls);
  await settle(f, pulls);
  f.queue.push({ number: 2, headSha: 'q2', branch: 'main' });
  // A force-push to PR 1 moves the base of PR 2, and the read of PR 2 fails in the same pass. PR 2's saved pass is
  // for its head and base, but not for the base tip now.
  Object.assign(bottom, { headSha: 'sha1b', updatedAt: '2026-11-10T11:30:00Z' });
  top.files = ['boom'];
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts.map((x) => [x.sha, x.passed]), [['sha1b', true], ['q2', false]]);
});

test('shadow: a stacked pass that could not be withdrawn does not let its queue commit pass', async () => {
  const f = await queueStack({ bottom: { approvers: [FALCON] } });
  const { postGate } = f.deps.github;
  f.deps.github.postGate = async (repo, sha, passed, title, summary) => {
    if (title === WITHDRAWN.title) throw new Error('GitHub is down');
    return postGate(repo, sha, passed, title, summary);
  };
  await sweepGate({ ...f.deps, stacks: 'shadow' }, REPO, T0 + MINUTE);
  assert.equal(decodeState(f.cursors.get(`gate:${REPO}#2`) ?? null)?.verdict, 'pass', 'the old pass is still saved');
  assert.deepEqual(f.posts.filter((x) => x.sha === 'q3').map((x) => x.passed), [false]);
});

test('a dry run posts no queue commit and saves no queue cursor', async () => {
  const f = await queueStack();
  f.deps.dryRun = true;
  await sweepGate(f.deps, REPO, T0 + MINUTE);
  assert.deepEqual(f.posts, []);
  assert.equal(f.cursors.has(`gateq:${REPO}:q3`), false);
});
