import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepGate, type GateDeps, type GatePort } from './gate.ts';
import { log } from './log.ts';

const REPO = 'acme/demo';
const FALCON = 'falcon-review[bot]';
const CODEOWNERS = '* @acme/team\n/merlin/ @pep\n';
const PACK = 'version: 1\nname: repo\nteam: { members: [lee] }\n';

interface Pull { number: number; headSha: string; baseRef: string; updatedAt: string; files: string[]; approvers: string[] }
const pull = (number: number, over: Partial<Pull> = {}): Pull => ({ number, headSha: `sha${number}`, baseRef: 'main', updatedAt: `2026-11-10T10:00:0${number}Z`, files: ['Orbit/a.py'], approvers: [], ...over });

function fixture(pulls: Pull[], over: Partial<GateDeps> = {}, files: Record<string, string> = { '.github/CODEOWNERS': CODEOWNERS, '.falcon/policy.yaml': PACK }) {
  const posts: Array<{ sha: string; passed: boolean; title: string }> = [];
  const cursors = new Map<string, string>();
  const github: GatePort = {
    openPulls: async (_repo, since) => pulls.filter((p) => p.updatedAt >= since).map((p) => ({ ...p, defaultBranch: 'main' })),
    changedPaths: async (_repo, number) => { const p = pulls.find((x) => x.number === number)!; if (p.files[0] === 'boom') throw new Error('GitHub is down'); return p.files; },
    approvers: async (_repo, number) => pulls.find((x) => x.number === number)!.approvers,
    fileAtRef: async (_repo, ref, path) => (ref === 'main' ? files[path] ?? null : null),
    postGate: async (_repo, sha, passed, title) => { posts.push({ sha, passed, title }); },
  };
  const deps: GateDeps = { github, store: { cursor: (k) => cursors.get(k) ?? null, setCursor: (k, v) => { cursors.set(k, v); } }, log, teamOwner: '@acme/team', falcon: FALCON, repoPack: '.falcon/policy.yaml', dryRun: false, ...over };
  return { deps, posts, cursors };
}

test('the gate waits, passes on a Falcon approval, and waits again when the approval goes', async () => {
  const p = pull(1);
  const f = fixture([p]);
  assert.equal(await sweepGate(f.deps, REPO), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: false, title: 'Waiting for an owner or Falcon to approve' });
  assert.equal(await sweepGate(f.deps, REPO), 0, 'nothing changed, nothing posted');

  p.approvers = [FALCON];
  p.updatedAt = '2026-11-10T10:05:00Z';
  assert.equal(await sweepGate(f.deps, REPO), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1', passed: true, title: 'Approved by an owner or Falcon' });

  p.approvers = [];
  p.headSha = 'sha1b'; // A push: the approval was on the older commit.
  p.updatedAt = '2026-11-10T10:06:00Z';
  assert.equal(await sweepGate(f.deps, REPO), 1);
  assert.deepEqual(f.posts.at(-1), { sha: 'sha1b', passed: false, title: 'Waiting for an owner or Falcon to approve' });
});

test('an approval in the same second as the cursor is still seen', async () => {
  const p = pull(1);
  const f = fixture([p]);
  await sweepGate(f.deps, REPO);
  p.approvers = ['lee']; // updatedAt unchanged.
  assert.equal(await sweepGate(f.deps, REPO), 1);
  assert.equal(f.posts.at(-1)!.passed, true);
});

test('owners and the team list come from the default branch; without a pack only Falcon and named owners count', async () => {
  const f = fixture([pull(1, { approvers: ['lee'] }), pull(2, { files: ['merlin/a.js'], approvers: ['pep'] }), pull(3, { approvers: [FALCON] })], {}, { '.github/CODEOWNERS': CODEOWNERS });
  await sweepGate(f.deps, REPO);
  assert.deepEqual(f.posts.map((p) => [p.sha, p.passed]), [['sha1', false], ['sha2', true], ['sha3', true]]);
});

test('a PR into another branch is skipped, and one failing PR does not stop the rest', async () => {
  const f = fixture([pull(1, { baseRef: 'stack/base' }), pull(2, { files: ['boom'] }), pull(3, { approvers: ['lee'] })]);
  assert.equal(await sweepGate(f.deps, REPO), 1);
  assert.deepEqual(f.posts, [{ sha: 'sha3', passed: true, title: 'Approved by an owner or Falcon' }]);
  assert.equal(f.cursors.get(`gate:${REPO}`), undefined, 'the cursor stays so the failed PR is read again');
  assert.equal(await sweepGate(f.deps, REPO), 0, 'the PR already posted is not posted twice');
});

test('dry run and an unknown Falcon login never post a pass', async () => {
  const dry = fixture([pull(1, { approvers: [FALCON] })], { dryRun: true });
  assert.equal(await sweepGate(dry.deps, REPO), 0);
  assert.deepEqual(dry.posts, []);
  const anon = fixture([pull(1, { approvers: [FALCON] })], { falcon: null });
  await sweepGate(anon.deps, REPO);
  assert.equal(anon.posts[0]!.passed, false);
});
