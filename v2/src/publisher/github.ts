import type { Octokit } from '@octokit/rest';
import type { PullMeta } from '../types.ts';
import { MARKER_PREFIX, type RenderedReview } from './render.ts';

export type CiState = 'none' | 'pending' | 'success' | 'failure';
export type CheckConclusion = RenderedReview['checkConclusion'];
export type Publishable = Pick<RenderedReview, 'event' | 'body' | 'comments'>;
export const CHECK_NAME = 'Falcon review';
/** The second check: passes only when the PR's owners or Falcon approved the current commit. */
export const GATE_NAME = 'Merge gate';

/** Minimal GitHub surface the engine needs; a fake implements this in tests. */
export interface GitHubPort {
  pull(repo: string, number: number): Promise<PullMeta>;
  /** `stalledAfterMs`: a check pending for longer than this is stalled, not running, and holds nothing up. */
  ci(repo: string, sha: string, stalledAfterMs?: number): Promise<CiState>;
  /** Reviews already posted by this engine at the given head (identified by marker). */
  ownReviews(repo: string, number: number, headSha: string): Promise<Array<{ id: number; htmlUrl: string }>>;
  /** Logins whose latest review on exactly this head is an approval. */
  approvers(repo: string, number: number, headSha: string): Promise<string[]>;
  /** Posts one commit-anchored review. Falls back to a body-only review if inline anchors are rejected. */
  postReview(repo: string, number: number, headSha: string, review: Publishable): Promise<{ id: number; htmlUrl: string; inlineDropped: boolean; commentIds: Map<string, number> }>;
  /** Shows "in progress" on the PR while the review runs. Returns the check-run id, or null when checks are unavailable. */
  startCheckRun(repo: string, headSha: string, summary: string): Promise<number | null>;
  /** Completes the check run started earlier, or creates a completed one when none exists. */
  completeCheckRun(repo: string, headSha: string, id: number | null, conclusion: CheckConclusion, title: string, summary: string, detailsUrl: string | null): Promise<number | null>;
  fileAtRef(repo: string, ref: string, path: string): Promise<string | null>;
}

const split = (repo: string) => { const [owner, name] = repo.split('/'); if (!owner || !name) throw new Error('repo must be owner/name'); return { owner, repo: name }; };
const status = (error: unknown) => (error as { status?: number }).status;

export class OctokitGitHub implements GitHubPort {
  private readonly octokit: Octokit;
  private readonly botLogin: string | null;
  constructor(octokit: Octokit, botLogin: string | null) { this.octokit = octokit; this.botLogin = botLogin; }

  async pull(repo: string, number: number): Promise<PullMeta> {
    const { data } = await this.octokit.pulls.get({ ...split(repo), pull_number: number });
    return {
      repo, number, title: data.title, body: data.body ?? '', author: data.user?.login ?? 'unknown', authorType: data.user?.type ?? 'User',
      draft: Boolean(data.draft), state: data.state as 'open' | 'closed', merged: Boolean(data.merged_at), headSha: data.head.sha, baseSha: data.base.sha,
      baseRef: data.base.ref, defaultBranch: data.base.repo.default_branch, headRef: data.head.ref, changedFiles: data.changed_files, additions: data.additions, deletions: data.deletions,
      labels: data.labels.map((l) => l.name), htmlUrl: data.html_url, cloneUrl: data.base.repo.clone_url,
    };
  }

  async ci(repo: string, sha: string, stalledAfterMs = Infinity): Promise<CiState> {
    const r = split(repo);
    const [combined, checks] = await Promise.all([
      this.octokit.repos.getCombinedStatusForRef({ ...r, ref: sha }),
      this.octokit.paginate(this.octokit.checks.listForRef, { ...r, ref: sha, filter: 'latest', per_page: 100 }),
    ]);
    // The merge gate waits on approvals, not on CI: counting it would defer every unapproved PR forever.
    const runs = checks.filter((c) => c.name !== CHECK_NAME && c.name !== GATE_NAME);
    const statuses = combined.data.statuses;
    if (!runs.length && !statuses.length) return 'none';
    // A check that has sat pending for a long time is stalled, not running: a blocked build step waits for a person.
    const cutoff = Date.now() - stalledAfterMs;
    const live = (since: string | null | undefined) => !since || Date.parse(since) > cutoff;
    if (runs.some((c) => c.status !== 'completed' && live(c.started_at)) || statuses.some((s) => s.state === 'pending' && live(s.updated_at))) return 'pending';
    if (runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(c.conclusion ?? '')) || statuses.some((s) => s.state === 'failure' || s.state === 'error')) return 'failure';
    return 'success';
  }

  async ownReviews(repo: string, number: number, headSha: string) {
    const rows = await this.octokit.paginate(this.octokit.pulls.listReviews, { ...split(repo), pull_number: number, per_page: 100 });
    return rows
      .filter((r) => (r.body ?? '').includes(`${MARKER_PREFIX}${repo}#${number}@${headSha} -->`) && (!this.botLogin || r.user?.login === this.botLogin))
      .map((r) => ({ id: r.id, htmlUrl: r.html_url }));
  }

  async approvers(repo: string, number: number, headSha: string) {
    const rows = await this.octokit.paginate(this.octokit.pulls.listReviews, { ...split(repo), pull_number: number, per_page: 100 });
    const latest = new Map<string, string>();
    // Reviews arrive oldest first; a comment never changes a verdict, and an approval on an older head does not count.
    for (const r of rows) if (r.user && r.commit_id === headSha && r.state !== 'COMMENTED') latest.set(r.user.login, r.state);
    return [...latest].filter(([, state]) => state === 'APPROVED').map(([login]) => login);
  }

  /** People whose latest verdict, on any commit, is an approval of an older commit than `headSha`. A dismissed approval is not one. */
  async olderApprovals(repo: string, number: number, headSha: string) {
    const rows = await this.octokit.paginate(this.octokit.pulls.listReviews, { ...split(repo), pull_number: number, per_page: 100 });
    const latest = new Map<string, { state: string; sha: string }>();
    // A person's comment never changes their verdict. Falcon's comment-only review is its verdict on that commit, so a
    // later one ends Falcon's older approval.
    for (const r of rows) if (r.user && r.commit_id && r.state !== 'PENDING' && (r.state !== 'COMMENTED' || r.user.login === this.botLogin)) latest.set(r.user.login, { state: r.state, sha: r.commit_id });
    return [...latest].filter(([, v]) => v.state === 'APPROVED' && v.sha !== headSha).map(([login, v]) => ({ login, sha: v.sha }));
  }

  async postReview(repo: string, number: number, headSha: string, review: Publishable) {
    const r = split(repo);
    const base = { ...r, pull_number: number, commit_id: headSha, event: review.event, body: review.body };
    let inlineDropped = false;
    let data;
    try {
      ({ data } = await this.octokit.pulls.createReview({ ...base, comments: review.comments.map(({ path, line, side, body }) => ({ path, line, side, body })) }));
    } catch (error) {
      if (status(error) !== 422 || !review.comments.length) throw error;
      // GitHub rejected an inline anchor. Never lose a finished review over a position: post it body-only.
      inlineDropped = true;
      const appendix = review.comments.map((c) => `#### ${c.path}:${c.line}\n${c.body}`).join('\n\n');
      ({ data } = await this.octokit.pulls.createReview({ ...base, body: review.body.replace(/\n<!-- falcon-review:v2 /, `\n\n${appendix}\n\n<!-- falcon-review:v2 `) }));
    }
    const commentIds = new Map<string, number>();
    if (!inlineDropped && review.comments.length) {
      const comments = await this.octokit.paginate(this.octokit.pulls.listCommentsForReview, { ...r, pull_number: number, review_id: data.id, per_page: 100 });
      for (const c of comments) {
        const tag = c.body.match(/<!-- falcon-finding:([a-f0-9]{12}) -->/);
        if (tag?.[1]) commentIds.set(tag[1], c.id);
      }
    }
    return { id: data.id, htmlUrl: data.html_url, inlineDropped, commentIds };
  }

  async startCheckRun(repo: string, headSha: string, summary: string): Promise<number | null> {
    try {
      const { data } = await this.octokit.checks.create({ ...split(repo), name: CHECK_NAME, head_sha: headSha, status: 'in_progress', started_at: new Date().toISOString(), output: { title: 'Review in progress', summary } });
      return data.id;
    } catch (error) {
      // Check runs need a GitHub App with checks:write; token-mode dry runs simply skip them.
      if (status(error) === 403) return null;
      throw error;
    }
  }

  async completeCheckRun(repo: string, headSha: string, id: number | null, conclusion: CheckConclusion, title: string, summary: string, detailsUrl: string | null): Promise<number | null> {
    const r = split(repo);
    const output = { title, summary };
    try {
      if (id !== null) {
        const { data } = await this.octokit.checks.update({ ...r, check_run_id: id, status: 'completed', conclusion, completed_at: new Date().toISOString(), output, ...(detailsUrl ? { details_url: detailsUrl } : {}) });
        return data.id;
      }
      const { data } = await this.octokit.checks.create({ ...r, name: CHECK_NAME, head_sha: headSha, status: 'completed', conclusion, output, ...(detailsUrl ? { details_url: detailsUrl } : {}) });
      return data.id;
    } catch (error) {
      if (status(error) === 403) return null;
      throw error;
    }
  }

  /** Every open PR, with its head branch, its place in a stack, and whether it comes from a fork. */
  async openPulls(repo: string) {
    const rows = await this.octokit.paginate(this.octokit.pulls.list, { ...split(repo), state: 'open', per_page: 100 });
    return rows.map((p) => {
      // Octokit's types do not declare `stack`, so it is read through a narrow cast.
      const s = (p as { stack?: { base: { ref: string }; number: number; position: number } | null }).stack;
      // A deleted head repository (null) counts as a fork: nothing shows it is this repository.
      const fromFork = p.head.repo?.full_name !== p.base.repo.full_name;
      return { number: p.number, headSha: p.head.sha, headRef: p.head.ref, baseRef: p.base.ref, defaultBranch: p.base.repo.default_branch, updatedAt: p.updated_at, author: p.user?.login ?? '', fromFork, stack: s ? { number: s.number, baseRef: s.base.ref, position: s.position } : null };
    });
  }

  /** One PR's head, base and update time, read fresh. */
  async pullState(repo: string, number: number) {
    const { data } = await this.octokit.pulls.get({ ...split(repo), pull_number: number });
    return { headSha: data.head.sha, baseRef: data.base.ref, baseSha: data.base.sha, updatedAt: data.updated_at, open: data.state === 'open' };
  }

  /**
   * Each reviewer's latest verdict on any commit, with its time. A person's comment never changes their verdict; the
   * bot's comment-only review is its verdict on that commit, so it replaces the bot's older approval.
   */
  async latestVerdicts(repo: string, number: number) {
    const rows = await this.octokit.paginate(this.octokit.pulls.listReviews, { ...split(repo), pull_number: number, per_page: 100 });
    const latest = new Map<string, { login: string; state: string; sha: string; submittedAt: string }>();
    for (const r of rows) if (r.user && r.commit_id && r.state !== 'PENDING' && (r.state !== 'COMMENTED' || r.user.login === this.botLogin)) latest.set(r.user.login, { login: r.user.login, state: r.state, sha: r.commit_id, submittedAt: r.submitted_at ?? '' });
    return [...latest.values()];
  }

  /** The newest commit both `base` (a commit, or `heads/<branch>` at its tip now) and `headSha` descend from. */
  async mergeBase(repo: string, base: string, headSha: string): Promise<string> {
    // Octokit encodes the whole `basehead`, so a branch name with a slash is passed as it is.
    const { data } = await this.octokit.repos.compareCommitsWithBasehead({ ...split(repo), basehead: `${base}...${headSha}`, per_page: 1 });
    return data.merge_base_commit.sha;
  }

  /** The base branch the PR had at `atMs`, from its base-change events. */
  async baseRefAt(repo: string, number: number, atMs: number): Promise<string> {
    const { owner, repo: name } = split(repo);
    const data = await this.octokit.graphql<{ repository: { pullRequest: { baseRefName: string; timelineItems: { nodes: Array<{ createdAt: string; previousRefName?: string; currentRefName?: string; oldBase?: string; newBase?: string }> } } } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { baseRefName timelineItems(first: 100, itemTypes: [BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]) { nodes { __typename ... on BaseRefChangedEvent { createdAt previousRefName currentRefName } ... on AutomaticBaseChangeSucceededEvent { createdAt oldBase newBase } } } } } }`,
      { owner, name, number });
    const pr = data.repository.pullRequest;
    // ponytail: reads the first 100 events. At that cap the history may be cut short, so the answer is '' (no branch
    // matches it, so no approval binds). Page the timeline if a PR is ever retargeted that often.
    if (pr.timelineItems.nodes.length >= 100) return '';
    const events = pr.timelineItems.nodes.map((e) => ({ at: Date.parse(e.createdAt), from: e.previousRefName ?? e.oldBase ?? '', to: e.currentRefName ?? e.newBase ?? '' })).sort((a, b) => a.at - b.at);
    // GitHub gives whole seconds, so a base change in the second of `atMs` may be just before it or just after it. That
    // base is unknown: '' binds nothing. An event with no readable time is unknown too.
    const second = Math.floor(atMs / 1000);
    if (events.some((e) => Number.isNaN(e.at) || Math.floor(e.at / 1000) === second)) return '';
    const before = events.filter((e) => e.at <= atMs).at(-1);
    if (before) return before.to;
    return events[0]?.from || pr.baseRefName;
  }

  /** The PRs in this PR's stack, bottom first. Empty when the PR is in no stack. */
  async stackMembers(repo: string, number: number) {
    const { owner, repo: name } = split(repo);
    const data = await this.octokit.graphql<{ repository: { pullRequest: { stack: { entries: { nodes: Array<{ position: number; pullRequest: { number: number; state: string; baseRefName: string; headRefName: string; headRefOid: string } }> } } | null } } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { stack { entries(first: 50) { nodes { position pullRequest { number state baseRefName headRefName headRefOid } } } } } } }`,
      { owner, name, number });
    const stack = data.repository.pullRequest.stack;
    if (!stack) return [];
    // ponytail: the first 50 entries. A cut-off list leaves members out, and the queue chain then fails closed.
    return stack.entries.nodes.map((n) => ({ number: n.pullRequest.number, position: n.position, open: n.pullRequest.state === 'OPEN', baseRef: n.pullRequest.baseRefName, headRef: n.pullRequest.headRefName, headSha: n.pullRequest.headRefOid })).sort((a, b) => a.position - b.position);
  }

  /** Every path the PR changes, old names of renamed files included. Null at GitHub's cap of 3000 files, where the list may be cut short. */
  async changedPaths(repo: string, number: number): Promise<string[] | null> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, { ...split(repo), pull_number: number, per_page: 100 });
    if (files.length >= 3000) return null;
    return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  }

  /** Posts the merge gate on a commit. A new run each time: GitHub reads the latest run of a name, so a withdrawn pass needs no edit of the old run. */
  async postGate(repo: string, headSha: string, passed: boolean, title: string, summary: string): Promise<void> {
    await this.octokit.checks.create({ ...split(repo), name: GATE_NAME, head_sha: headSha, output: { title, summary }, ...(passed ? { status: 'completed' as const, conclusion: 'success' as const } : { status: 'in_progress' as const, started_at: new Date().toISOString() }) });
  }

  /**
   * The merge queue of a branch, read from the temporary branches GitHub makes for it
   * (`gh-readonly-queue/<base>/pr-<number>-<sha>`), so it needs no permission beyond reading the repository.
   */
  async queueEntries(repo: string, branch: string): Promise<Array<{ number: number; headSha: string }>> {
    const refs = await this.octokit.paginate(this.octokit.git.listMatchingRefs, { ...split(repo), ref: `heads/gh-readonly-queue/${branch}/`, per_page: 100 });
    return refs.flatMap((r) => {
      const number = /\/pr-(\d+)-[0-9a-f]+$/.exec(r.ref)?.[1];
      return number ? [{ number: Number(number), headSha: r.object.sha }] : [];
    });
  }

  async fileAtRef(repo: string, ref: string, path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({ ...split(repo), ref, path });
      if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64') return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
  }
}
