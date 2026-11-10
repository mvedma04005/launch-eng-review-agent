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

interface Pull { number: number; headSha: string; baseRef: string; updatedAt: string; author: string; files: string[] | null; approvers: string[] }
const pull = (number: number, over: Partial<Pull> = {}): Pull => ({ number, headSha: `sha${number}`, baseRef: 'main', updatedAt: `2026-11-10T10:00:0${number}Z`, author: 'sam', files: ['Orbit/a.py'], approvers: [], ...over });

function fixture(pulls: Pull[], over: Partial<GateDeps> = {}, files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, '.falcon/policy.yaml': PACK }) {
  const posts: Array<{ sha: string; passed: boolean; title: string }> = [];
  const cursors = new Map<string, string>();
  const hooks: { onFiles?: (p: Pull) => void } = {};
  const find = (number: number) => pulls.find((x) => x.number === number)!;
  const github: GatePort = {
    openPulls: async () => pulls.map((p) => ({ ...p, defaultBranch: 'main' })),
    pullState: async (_repo, number) => ({ ...find(number), open: true }),
    changedPaths: async (_repo, number) => {
      const p = find(number);
      if (p.files?.[0] === 'boom') throw new Error('GitHub is down');
      hooks.onFiles?.(p);
      return p.files;
    },
    approvers: async (_repo, number) => find(number).approvers,
    fileAtRef: async (_repo, ref, path) => (ref === 'main' ? files[path] ?? null : null),
    postGate: async (_repo, sha, passed, title) => { posts.push({ sha, passed, title }); },
  };
  const deps: GateDeps = { github, store: { cursor: (k) => cursors.get(k) ?? null, setCursor: (k, v) => { cursors.set(k, v); } }, log, teamOwner: '@acme/team', falcon: FALCON, repoPack: '.falcon/policy.yaml', dryRun: false, ...over };
  return { deps, posts, cursors, files, hooks };
}

test('the gate waits, passes on a Falcon approval, and waits again when the approval goes', async () => {
  const p = pull(1);
  const f = fixture([p]);
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for an owner or Falcon to approve' });
  assert.equal(await sweepGate(f.deps, REPO, T0), 0, 'nothing changed, nothing posted');

  p.approvers = [FALCON];
  p.updatedAt = '2026-11-10T10:05:00Z';
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by an owner or Falcon' });

  p.approvers = [];
  p.headSha = 'sha1b'; // A push: the approval was on the older commit.
  p.updatedAt = '2026-11-10T10:06:00Z';
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1b', passed: false, title: 'Waiting for an owner or Falcon to approve' });
});

test('an approval in the same second as the cursor is still seen', async () => {
  const p = pull(1);
  const f = fixture([p]);
  await sweepGate(f.deps, REPO, T0);
  p.approvers = ['lee']; // updatedAt unchanged.
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.equal(f.posts.at(-1)!.passed, true);
});

test('without a pack, or with an invalid one, only Falcon and named owners count', async () => {
  for (const pack of [undefined, 'version: [not, a, pack']) {
    const files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, ...(pack ? { '.falcon/policy.yaml': pack } : {}) };
    const f = fixture([pull(1, { approvers: ['lee'] }), pull(2, { files: ['merlin/a.js'], approvers: ['pep'] }), pull(3, { approvers: [FALCON] })], {}, files);
    await sweepGate(f.deps, REPO, T0);
    assert.deepEqual(f.posts.map((p) => [p.sha, p.passed]), [['sha1', false], ['sha2', true], ['sha3', true]]);
  }
});

test('a PR into another branch is skipped, and one failing PR does not stop the rest', async () => {
  const f = fixture([pull(1, { baseRef: 'stack/base' }), pull(2, { files: ['boom'] }), pull(3, { approvers: ['lee'] })]);
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha3', passed: true, title: 'Approved by an owner or Falcon' }]);
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

test('a PR that moves while it is being read is judged on the next pass, not on mixed state', async () => {
  // Commit sha1 changes a merlin file too. The author pushes a commit without it while the pass is reading files.
  const p = pull(1, { files: ['Orbit/a.py', 'merlin/a.js'], approvers: [FALCON] });
  const f = fixture([p]);
  f.hooks.onFiles = (x) => { x.files = ['Orbit/a.py']; x.headSha = 'sha1b'; x.updatedAt = '2026-11-10T10:09:00Z'; };
  assert.equal(await sweepGate(f.deps, REPO, T0), 0, 'the files of the new commit are not judged against the old commit');
  delete f.hooks.onFiles;
  p.approvers = [];
  assert.equal(await sweepGate(f.deps, REPO, T0), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha1b', passed: false, title: 'Waiting for an owner or Falcon to approve' }]);
});

test('a pass does not outlive a change to the rules on the default branch', async () => {
  const f = fixture([pull(1, { approvers: ['lee'] }), pull(2)]);
  await sweepGate(f.deps, REPO, T0);
  assert.equal(f.posts[0]!.passed, true);
  f.files['.falcon/policy.yaml'] = 'version: 1\nname: repo\nteam: { members: [kim] }\n'; // lee leaves the team; PR 1 is not touched.
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for an owner or Falcon to approve' });
});

test('every open PR is judged again after half an hour, so a silent change is still caught', async () => {
  const p = pull(1, { approvers: ['lee'] });
  const f = fixture([p, pull(2)]);
  await sweepGate(f.deps, REPO, T0);
  p.approvers = []; // Withdrawn without moving the PR's update time.
  assert.equal(await sweepGate(f.deps, REPO, T0 + MINUTE), 0);
  assert.equal(await sweepGate(f.deps, REPO, T0 + 31 * MINUTE), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for an owner or Falcon to approve' });
});
