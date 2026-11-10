import type { Octokit } from '@octokit/rest';
import type { PullMeta } from '../types.ts';
import { MARKER_PREFIX, type RenderedReview } from './render.ts';

export type CiState = 'none' | 'pending' | 'success' | 'failure';
export type CheckConclusion = RenderedReview['checkConclusion'];
export type Publishable = Pick<RenderedReview, 'event' | 'body' | 'comments'>;
export const CHECK_NAME = 'Falcon review';

/** Minimal GitHub surface the engine needs; a fake implements this in tests. */
export interface GitHubPort {
  pull(repo: string, number: number): Promise<PullMeta>;
  ci(repo: string, sha: string): Promise<CiState>;
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

  async ci(repo: string, sha: string): Promise<CiState> {
    const r = split(repo);
    const [combined, checks] = await Promise.all([
      this.octokit.repos.getCombinedStatusForRef({ ...r, ref: sha }),
      this.octokit.paginate(this.octokit.checks.listForRef, { ...r, ref: sha, filter: 'latest', per_page: 100 }),
    ]);
    const runs = checks.filter((c) => c.name !== CHECK_NAME);
    const statuses = combined.data.statuses;
    if (!runs.length && !statuses.length) return 'none';
    if (runs.some((c) => c.status !== 'completed') || (combined.data.state === 'pending' && statuses.length)) return 'pending';
    if (runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(c.conclusion ?? '')) || combined.data.state === 'failure') return 'failure';
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
