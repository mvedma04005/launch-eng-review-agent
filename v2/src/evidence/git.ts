import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseUnifiedDiff, type Anchors } from './diff.ts';

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

export function checkSha(sha: string): string {
  if (!SHA.test(sha)) throw new Error('A full 40-hex commit SHA is required.');
  return sha;
}

async function git(args: string[], cwd?: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...extraEnv },
  });
  return stdout;
}

/**
 * One bare mirror per repository, fetched incrementally. All evidence is read from a detached worktree at the PR
 * head, so the review never observes a moving ref and the model reads files with ordinary filesystem tools.
 */
export class Mirror {
  readonly root: string;
  readonly repo: string;
  readonly cloneUrl: string;
  readonly tokenProvider: (() => Promise<string>) | undefined;
  constructor(root: string, repo: string, cloneUrl: string, tokenProvider?: () => Promise<string>) {
    this.root = root; this.repo = repo; this.cloneUrl = cloneUrl; this.tokenProvider = tokenProvider;
  }

  get path(): string { return join(this.root, 'mirrors', ...this.repo.split('/')) + '.git'; }

  private async authEnv(): Promise<Record<string, string>> {
    if (!this.tokenProvider) return {};
    const token = await this.tokenProvider();
    const header = 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
    // Pass the credential through git config, never on the command line.
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: header };
  }

  async ensure(): Promise<void> {
    if (existsSync(join(this.path, 'HEAD'))) return;
    // Reviews run in parallel processes: clone to a private directory and rename it into place, so no worker
    // ever sees a half-written mirror and a lost race costs one spare clone, not a failed job.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(this.path + '.tmp-');
    try {
      await git(['clone', '--bare', '--quiet', this.cloneUrl, tmp], undefined, await this.authEnv());
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(join(this.path, 'HEAD'))) throw error; // not a lost race: a real clone failure
    }
  }

  /** Fetch the PR head and base refs; verify the expected SHAs are present. */
  async fetchPull(number: number, headSha: string, baseRef: string, baseSha: string): Promise<void> {
    checkSha(headSha); checkSha(baseSha);
    if (!/^[\w./-]+$/.test(baseRef)) throw new Error('Unsupported base ref name.');
    await this.ensure();
    // Both refs are per pull request. A base ref shared by every PR on the same branch made parallel fetches
    // fail with "cannot lock ref".
    await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${number}/head:refs/falcon/pull/${number}/head`, `+refs/heads/${baseRef}:refs/falcon/pull/${number}/base`], this.path, await this.authEnv());
    for (const sha of [headSha, baseSha]) {
      await git(['cat-file', '-e', `${sha}^{commit}`], this.path).catch(() => { throw new Error(`Commit ${sha} is not reachable after fetch; the PR may have moved.`); });
    }
  }

  /** Fetch the tip of a branch into a per-PR ref and return its SHA. */
  async fetchBranchTip(number: number, branch: string): Promise<string> {
    if (!/^[\w./-]+$/.test(branch)) throw new Error('Unsupported branch name.');
    await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/falcon/pull/${number}/default`], this.path, await this.authEnv());
    return checkSha((await git(['rev-parse', `refs/falcon/pull/${number}/default^{commit}`], this.path)).trim());
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return checkSha((await git(['merge-base', checkSha(a), checkSha(b)], this.path)).trim());
  }

  async diff(baseSha: string, headSha: string): Promise<Anchors> {
    const text = await git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--unified=3', `${checkSha(baseSha)}..${checkSha(headSha)}`], this.path);
    return parseUnifiedDiff(text);
  }

  async worktree(headSha: string, dir: string): Promise<Worktree> {
    checkSha(headSha);
    mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
    // A review that was killed mid-run (a daemon restart) leaves its checkout behind. `worktree add` then refuses the
    // folder, and every retry of that job fails. Clear what is left first.
    await this.removeWorktree(dir);
    rmSync(dir, { recursive: true, force: true });
    await git(['worktree', 'add', '--detach', '--quiet', dir, headSha], this.path);
    return new Worktree(this, dir, headSha);
  }

  async removeWorktree(dir: string): Promise<void> {
    await git(['worktree', 'remove', '--force', dir], this.path).catch(() => undefined);
    await git(['worktree', 'prune'], this.path).catch(() => undefined);
  }
}

/** Read-only view of the repository at one commit. Every path is confined to the checkout. */
export class Worktree {
  readonly root: string;
  readonly mirror: Mirror;
  readonly sha: string;
  constructor(mirror: Mirror, dir: string, sha: string) { this.mirror = mirror; this.sha = sha; this.root = realpathSync(dir); }

  /** Resolve a repository-relative path, refusing traversal and symlink escapes. */
  resolve(path: string): string {
    if (path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid repository path.');
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('Path escapes the repository.');
    const real = existsSync(full) ? realpathSync(full) : full;
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error('Symlink escapes the repository.');
    return real;
  }

  exists(path: string): boolean { return existsSync(this.resolve(path)); }

  readText(path: string, maxBytes: number): string {
    const full = this.resolve(path);
    const st = statSync(full);
    if (!st.isFile()) throw new Error('Not a regular file.');
    if (st.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
    const buf = readFileSync(full);
    if (buf.includes(0)) throw new Error('Binary file.');
    return buf.toString('utf8');
  }

  async listDir(path: string): Promise<string[]> {
    const args = ['ls-tree', '--name-only', this.sha];
    if (path && path !== '.') args.push(path.replace(/\/?$/, '/'));
    const out = await git(args, this.root);
    return out.split('\n').filter(Boolean);
  }

  async grep(pattern: string, globs: string[], maxResults: number): Promise<string[]> {
    const args = ['grep', '-n', '-I', '--no-color', '-E', '-e', pattern, this.sha, '--', ...(globs.length ? globs : ['.'])];
    const out = await git(args, this.root).catch((e: { code?: number }) => (e.code === 1 ? '' : Promise.reject(e)));
    // Output lines look like `<sha>:<path>:<line>:<text>`; strip the sha.
    return out.split('\n').filter(Boolean).map((l) => l.replace(/^[0-9a-f]{40}:/, '')).slice(0, maxResults);
  }

  async log(path: string, limit: number): Promise<string> {
    return git(['log', `--max-count=${Math.min(limit, 50)}`, '--date=short', '--format=%h %ad %an: %s', this.sha, '--', path], this.root);
  }

  async blame(path: string, line: number): Promise<string> {
    return git(['blame', '-L', `${line},${line}`, '--date=short', this.sha, '--', path], this.root);
  }
}
