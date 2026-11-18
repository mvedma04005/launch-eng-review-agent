import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff } from './diff.ts';
import { Mirror } from './git.ts';
import { validateSubmission } from '../reviewer/validate.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('unified diff parser yields RIGHT anchors for added/context lines and LEFT only for deletions', () => {
  const diff = `diff --git a/app/h.py b/app/h.py
index 1..2 100644
--- a/app/h.py
+++ b/app/h.py
@@ -1,3 +1,4 @@
 import os
-return user
+return user.name
+log(user)
 done
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
  const anchors = parseUnifiedDiff(diff);
  assert.deepEqual(anchors.files.map((f) => [f.path, f.status, f.binary]), [['app/h.py', 'modified', false], ['new.txt', 'renamed', false], ['img.png', 'modified', true]]);
  assert.equal(anchors.files[0]!.additions, 2);
  assert.equal(anchors.files[0]!.deletions, 1);
  assert.ok(anchors.has('app/h.py', 'RIGHT', 1), 'context line');
  assert.ok(anchors.has('app/h.py', 'RIGHT', 2), 'added line');
  assert.ok(anchors.has('app/h.py', 'RIGHT', 3));
  assert.ok(anchors.has('app/h.py', 'LEFT', 2), 'deleted line');
  assert.ok(!anchors.has('app/h.py', 'LEFT', 1), 'context lines are not LEFT anchors');
  assert.ok(!anchors.has('app/h.py', 'RIGHT', 9));
});

test('workers that set up the mirror at the same time all succeed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'falcon-race-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'base');
  const mirror = () => new Mirror(join(root, 'state'), 'acme/demo', origin);
  await Promise.all([mirror().ensure(), mirror().ensure(), mirror().ensure()]);
  assert.ok(existsSync(join(mirror().path, 'HEAD')));
  assert.deepEqual(readdirSync(join(root, 'state', 'mirrors', 'acme')), ['demo.git'], 'no spare clones left behind');
});

test('mirror + worktree: fetch, merge base, diff, confined reads, grep, and host-side finding validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'falcon-evidence-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'handler.py'), 'import os\nreturn user\ndone\n');
  writeFileSync(join(origin, 'secret.txt'), 'outside\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(origin, 'handler.py'), 'import os\nreturn user.name\nlog(user)\ndone\n');
  symlinkSync('/etc/hosts', join(origin, 'escape')); // exists on macOS and Linux; /etc/hostname is Linux-only
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'change');
  const headSha = git(origin, 'rev-parse', 'HEAD');
  // Simulate GitHub's refs/pull/N/head.
  git(origin, 'update-ref', 'refs/pull/7/head', headSha);
  git(origin, 'checkout', '-q', 'main');

  const mirror = new Mirror(join(root, 'state'), 'acme/demo', origin);
  await mirror.fetchPull(7, headSha, 'main', baseSha);
  assert.equal(await mirror.mergeBase(baseSha, headSha), baseSha);
  assert.equal(git(mirror.path, 'rev-parse', 'refs/falcon/pull/7/base'), baseSha, 'the base is fetched into a ref owned by this PR');
  assert.throws(() => git(mirror.path, 'rev-parse', '--verify', '--quiet', 'refs/falcon/base/main'), 'no ref is shared between PRs');
  const anchors = await mirror.diff(baseSha, headSha);
  assert.deepEqual(anchors.files.map((f) => f.path).sort(), ['escape', 'handler.py']);
  const wt = await mirror.worktree(headSha, join(root, 'wt', 'job1'));
  try {
    assert.equal(wt.readText('handler.py', 10_000).split('\n')[1], 'return user.name');
    // A checkout left behind by a killed review does not block the next attempt at the same folder.
    const again = await mirror.worktree(headSha, join(root, 'wt', 'job1'));
    assert.equal(again.readText('handler.py', 10_000).split('\n')[1], 'return user.name');
    assert.throws(() => wt.readText('../origin/secret.txt', 10_000), /Invalid repository path|escapes/);
    assert.throws(() => wt.readText('escape', 10_000), /escapes|Not a regular file/);
    assert.deepEqual(await wt.grep('user\\.name', [], 10), ['handler.py:2:return user.name']);
    assert.deepEqual(await wt.listDir(''), ['escape', 'handler.py', 'secret.txt']);

    const baseRead = async (path: string) => (path === 'handler.py' ? 'import os\nreturn user\ndone\n' : null);
    const result = await validateSubmission({
      summary: 'ok', confidence: 'high', reviewed_files: ['handler.py'], lenses_completed: ['correctness'], questions: [], risks: [{ risk: 'null user', held: true, checked: 'handler.py' }, { risk: 'bad import', held: false, checked: 'handler.py' }],
      findings: [
        { severity: 'high', path: 'handler.py', side: 'RIGHT', line: 2, title: 'Null user crashes', scenario: 's', impact: 'i', evidence: 'user.name', fix: 'guard' },
        { severity: 'low', path: 'handler.py', side: 'RIGHT', line: 2, title: 'Wrong quote', scenario: 's', impact: 'i', evidence: 'does-not-exist', fix: 'f' },
        { severity: 'low', path: 'handler.py', side: 'LEFT', line: 1, title: 'Context as LEFT', scenario: 's', impact: 'i', evidence: 'import os', fix: 'f' },
        { severity: 'low', path: 'handler.py', side: 'LEFT', line: 2, title: 'Deleted line', scenario: 's', impact: 'i', evidence: 'return user', fix: 'f' },
        { severity: 'low', path: 'missing.py', side: 'RIGHT', line: 1, title: 'No file', scenario: 's', impact: 'i', evidence: 'x', fix: 'f' },
      ],
    }, { worktree: wt, anchors, baseRead, changedFiles: ['handler.py'], maxFileBytes: 100_000 });
    assert.deepEqual(result.findings.map((f) => f.title), ['Null user crashes', 'Deleted line']);
    assert.equal(result.errors.length, 3);
    assert.match(result.errors[0]!, /evidence not found/);
    assert.match(result.errors[1]!, /LEFT anchors must be deleted lines/);
    assert.match(result.errors[2]!, /does not exist/);
    assert.equal(result.findings[0]!.id.length, 12);
  } finally {
    await mirror.removeWorktree(join(root, 'wt', 'job1'));
  }
});

test('a diff header that cannot be read fails the review instead of hiding the file', () => {
  // git quotes a name that holds a quote, a backslash or a control character; the plain header pattern does not match it.
  const quoted = 'diff --git "a/infra/x\\ty.tf" "b/infra/x\\ty.tf"\nnew file mode 100644\n--- /dev/null\n+++ "b/infra/x\\ty.tf"\n@@ -0,0 +1 @@\n+x\n';
  assert.throws(() => parseUnifiedDiff(quoted), /Cannot read a changed file's name/);
});

test('a rebase that keeps the change keeps its fingerprint, and the old head is fetched by SHA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'falcon-rebase-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(join(origin, 'app.py'), 'a = 1\nb = 2\n');
  writeFileSync(join(origin, 'other.py'), 'x = 1\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'base');
  const base1 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(origin, 'app.py'), 'a = 1\nb = 3\n');
  git(origin, 'commit', '-q', '-am', 'change');
  const head1 = git(origin, 'rev-parse', 'HEAD');
  // main moves on a file the PR does not touch, then the PR is rebased onto it: the old head is no longer on any ref.
  git(origin, 'checkout', '-q', 'main');
  writeFileSync(join(origin, 'other.py'), 'x = 2\n');
  git(origin, 'commit', '-q', '-am', 'main moves');
  const base2 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'feature');
  git(origin, 'rebase', '-q', 'main');
  const head2 = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'app.py'), 'a = 1\nb = 4\n');
  git(origin, 'commit', '-q', '-am', 'more');
  const head3 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/7/head', head2);
  git(origin, 'checkout', '-q', 'main');

  // file:// so the clone fetches like a remote does; a plain path copies every object, the old head included.
  const mirror = new Mirror(join(root, 'state'), 'acme/demo', `file://${origin}`);
  await mirror.fetchPull(7, head2, 'main', base2);
  assert.throws(() => git(mirror.path, 'cat-file', '-e', `${head1}^{commit}`), 'the old head is not in a fresh mirror');
  await mirror.fetchCommit(head1);
  await mirror.fetchCommit(head3);
  await assert.rejects(mirror.fetchCommit('0'.repeat(40)), 'a commit GitHub does not have fails, so the caller reviews in full');

  const before = await mirror.patchId(base1, head1);
  assert.ok(before, 'a change has a fingerprint');
  assert.equal(await mirror.patchId(base2, head2), before, 'the rebased change has the same fingerprint');
  assert.notEqual(await mirror.patchId(base2, head3), before, 'a changed diff has a different fingerprint');
  assert.equal(await mirror.patchId(base2, base2), null, 'an empty diff has no fingerprint');
  assert.deepEqual(await mirror.changedFiles(base1, base2), ['other.py'], 'what main changed between the two bases');
});
