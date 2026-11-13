import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepGate, type GateDeps, type GatePort } from './gate.ts';
import { log } from './log.ts';

const REPO = 'acme/demo';
const FALCON = 'falcon-review[bot]';
const CODEOWNERS = '* @acme/team\n/merlin/ @pep\n';
const PACK = 'version: 1\nname: repo\nteam: { members: [lee] }\n';
const T0 = Date.parse('2026-11-10T12:00:00Z');
const MINUTE = 60_000;

interface Pull { number: number; headSha: string; baseRef: string; updatedAt: string; author: string; files: string[] | null; approvers: string[]; open?: boolean }
const pull = (number: number, over: Partial<Pull> = {}): Pull => ({ number, headSha: `sha${number}`, baseRef: 'main', updatedAt: `2026-11-10T10:00:0${number}Z`, author: 'sam', files: ['Orbit/a.py'], approvers: [], ...over });

function fixture(pulls: Pull[], over: Partial<GateDeps> = {}, files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, '.falcon/policy.yaml': PACK }) {
  const posts: Array<{ sha: string; passed: boolean; title: string }> = [];
  const summaries: string[] = [];
  const cursors = new Map<string, string>();
  const hooks: { onFiles?: (p: Pull) => void } = {};
  const queue: Array<{ number: number; headSha: string; branch: string }> = [];
  const find = (number: number) => pulls.find((x) => x.number === number)!;
  const github: GatePort = {
    openPulls: async () => pulls.map((p) => ({ ...p, defaultBranch: 'main' })),
    pullState: async (_repo, number) => ({ ...find(number), open: find(number).open ?? true }),
    changedPaths: async (_repo, number) => {
      const p = find(number);
      if (p.files?.[0] === 'boom') throw new Error('GitHub is down');
      hooks.onFiles?.(p);
      return p.files;
    },
    approvers: async (_repo, number) => find(number).approvers,
    fileAtRef: async (_repo, ref, path) => (ref === 'main' ? files[path] ?? null : null),
    postGate: async (_repo, sha, passed, title, summary) => { posts.push({ sha, passed, title }); summaries.push(summary); },
    queueEntries: async (_repo, branch) => queue.filter((e) => e.branch === branch),
  };
  const deps: GateDeps = { github, store: { cursor: (k) => cursors.get(k) ?? null, setCursor: (k, v) => { cursors.set(k, v); } }, log, falcon: FALCON, repoPack: '.falcon/policy.yaml', requested: new Set(pulls.map((p) => p.number)), dryRun: false, ...over };
  return { deps, posts, summaries, cursors, files, hooks, queue };
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
  const f = fixture([pull(1, { baseRef: 'queue-trial', approvers: ['lee'] }), pull(2, { baseRef: 'stack/base', approvers: ['lee'] })], { branches: ['queue-trial'] });
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
