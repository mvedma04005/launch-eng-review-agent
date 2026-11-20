import { createHash } from 'node:crypto';
import type { Logger } from './log.ts';
import { gateVerdict, governedBy, type GateVerdict } from './policy/gate.ts';
import { parsePolicy } from './policy/load.ts';

/** Every open PR is judged again this often, in case a change did not move its update time. */
const FULL_RECHECK_MS = 30 * 60_000;

/** The GitHub surface the merge gate needs; a fake implements this in tests. */
export interface GatePort {
  openPulls(repo: string): Promise<Array<{ number: number; headSha: string; baseRef: string; defaultBranch: string; updatedAt: string; author: string }>>;
  /** One PR's head, base and update time, read fresh. */
  pullState(repo: string, number: number): Promise<{ headSha: string; baseRef: string; updatedAt: string; open: boolean }>;
  /** Every path the PR changes, or null when GitHub's list may be cut short. */
  changedPaths(repo: string, number: number): Promise<string[] | null>;
  approvers(repo: string, number: number, headSha: string): Promise<string[]>;
  /** People whose latest verdict is an approval of a commit older than `headSha`, with that commit. */
  olderApprovals(repo: string, number: number, headSha: string): Promise<Array<{ login: string; sha: string }>>;
  fileAtRef(repo: string, ref: string, path: string): Promise<string | null>;
  postGate(repo: string, headSha: string, passed: boolean, title: string, summary: string): Promise<void>;
  /** The merge queue of a branch: each queued PR with the commit GitHub tests it on. Empty when the branch has no queue. */
  queueEntries(repo: string, branch: string): Promise<Array<{ number: number; headSha: string }>>;
}

export interface GateDeps {
  github: GatePort;
  store: {
    cursor(key: string): string | null;
    setCursor(key: string, value: string): void;
    /** Falcon's latest review of a PR on any commit except `excludeHead`, with the base it saved. Absent: Falcon's own approvals never carry. */
    lastReview?(repo: string, number: number, excludeHead: string): { headSha: string; baseSha: string; event: string } | null;
  };
  log: Logger;
  /** Falcon's own login, or null when it is unknown. */
  falcon: string | null;
  /** Path of the repository's policy pack, which holds the team list. */
  repoPack: string;
  /** The PRs requested in Chat: the gate judges no others. Null: it judges every open PR into the default branch. */
  requested: Set<number> | null;
  /** Base branches judged besides the default branch. */
  branches?: string[];
  dryRun: boolean;
  /**
   * Whether `headSha` carries the same change as `oldSha` and the base did not move anything `governs` names. `oldBase`
   * is the base `oldSha` was approved on, when known. Absent: only approvals on the current commit count. Throws when it
   * cannot tell.
   */
  sameChange?: (number: number, oldSha: string, headSha: string, governs: (path: string) => boolean, oldBase?: string) => Promise<boolean>;
}

type Older = Array<{ login: string; sha: string }>;

function describe({ verdict, uncovered }: GateVerdict, approvers: string[], outside: string[], tooMany: boolean, moved: boolean, carried: Older = [], stale: Older = []): { title: string; summary: string } {
  // An approval GitHub shows but the gate does not count is the first thing an author asks about.
  const notCounted = outside.length ? ` ${outside.join(' and ')} ${outside.length === 1 ? 'is' : 'are'} not in the team list of the policy file, so ${outside.length === 1 ? 'that' : 'their'} approval does not count here.` : '';
  const short = (sha: string) => sha.slice(0, 12);
  // An approval of an earlier commit is named with that commit, so nobody reads it as an approval of this one.
  const earlier = carried.map((c) => ` Approved by ${c.login} on ${short(c.sha)}, an earlier commit with the same change.`).join('')
    + stale.map((c) => ` ${c.login} approved ${short(c.sha)}, but the change is different on this commit, so that approval does not count here. Approve this commit again.`).join('');
  const who = (approvers.length ? `Approved on this commit by ${approvers.join(', ')}.${notCounted}` : carried.length ? '' : 'Nobody has approved this commit yet.') + earlier;
  const list = uncovered.slice(0, 10).map((f) => `\`${f}\``).join(', ') + (uncovered.length > 10 ? ` and ${uncovered.length - 10} more` : '');
  if (verdict === 'pass') return { title: 'Approved by Launch Engineering or Falcon', summary: `${who.trim()} A team member or Falcon approved ${carried.length && !approvers.length ? 'this change' : 'this commit'}.` };
  if (moved) return { title: 'Waiting: the PR changed while it was being checked', summary: 'The PR was pushed to or edited during the check. It is checked again on the next pass.' };
  if (tooMany) return { title: 'Waiting: too many files to check', summary: 'This PR changes more files than GitHub lists, so the list of files may be incomplete. Split the PR.' };
  return { title: 'Waiting for Launch Engineering or Falcon to approve', summary: `${who.trim()} Still needs an approval from a team member, or from Falcon where Falcon may approve, for: ${list || 'this change'}.` };
}

/**
 * Reads one PR, its files and its approvals, then the PR again. GitHub lists the files of "the PR now", so they
 * belong to the commit only if nothing about the PR moved in between. Tries twice; `steady` says whether it held.
 */
async function readPull(github: GatePort, repo: string, number: number, author: string) {
  for (let attempt = 0; ; attempt++) {
    const before = await github.pullState(repo, number);
    const files = await github.changedPaths(repo, number);
    // GitHub refuses a self-approval; this does not rely on it.
    const approvers = (await github.approvers(repo, number, before.headSha)).filter((a) => a.toLowerCase() !== author.toLowerCase()).sort();
    const after = await github.pullState(repo, number);
    // shortcut: two pushes inside one second of the update time go unseen; read the files with the compare API,
    // pinned to the commit, if that window ever matters.
    const steady = after.headSha === before.headSha && after.baseRef === before.baseRef && after.updatedAt === before.updatedAt;
    if (steady || attempt === 1) return { ...after, files, approvers, steady };
  }
}

/**
 * Team members, other than the author, and Falcon, whose latest verdict approves an older commit that carries the same
 * change as `headSha`. Each answer is saved per pair of commits and base branch, so a retarget compares again. A
 * comparison that fails counts as not the same and is not saved.
 */
async function carriedApprovals(deps: GateDeps, repo: string, number: number, headSha: string, baseRef: string, author: string, team: string[], governs: (path: string) => boolean): Promise<{ carried: Older; stale: Older }> {
  const lower = (s: string) => s.toLowerCase();
  const members = new Set(team.map(lower));
  const carried: Older = [];
  const stale: Older = [];
  // GitHub lists Falcon only while its latest review on any commit is that approval: a later comment-only review ends
  // it. The store gives the base Falcon reviewed against, which is the branch below for a stacked PR; with no record
  // of that exact review, nothing carries.
  const last = deps.store.lastReview?.(repo, number, '') ?? null;
  for (const { login, sha } of await deps.github.olderApprovals(repo, number, headSha)) {
    const l = lower(login);
    const falcon = l === deps.falcon?.toLowerCase();
    if (falcon ? !(last?.event === 'APPROVE' && last.headSha === sha) : l === lower(author) || l.endsWith('[bot]') || !members.has(l)) continue;
    const base = falcon ? last!.baseSha : undefined;
    // ponytail: one cursor per pair of commits, base branch and saved base, never removed; prune by age if the table ever matters.
    const key = `gate-carry:${repo}:${sha}:${headSha}:${baseRef}${base ? `:${base}` : ''}`;
    let same = deps.store.cursor(key);
    if (same === null) {
      try {
        same = String(await deps.sameChange!(number, sha, headSha, governs, base));
        deps.store.setCursor(key, same);
      } catch (error) {
        deps.log.info({ repo, number, old: sha, head: headSha, err: String(error) }, 'merge gate: could not compare with an older approval');
        continue;
      }
    }
    (same === 'true' ? carried : stale).push({ login, sha });
  }
  return { carried, stale };
}

/**
 * One pass over the open PRs into the default branch (only those requested in Chat, unless `requested` is null). It judges the ones that changed since the last pass, and
 * all of them when the rules changed or half an hour has gone by, and posts the check when the decision differs
 * from the last one posted. Returns the number of checks posted.
 */
export async function sweepGate(deps: GateDeps, repo: string, now = Date.now()): Promise<number> {
  const { github, store, log } = deps;
  const requested = deps.requested;
  const extra = deps.branches ?? [];
  // A PR that already has a check keeps being judged, so a pass is withdrawn even after the PR leaves the list.
  const open = (await github.openPulls(repo)).filter((p) => (p.baseRef === p.defaultBranch || extra.includes(p.baseRef)) && (!requested || requested.has(p.number) || store.cursor(`gate:${repo}#${p.number}`) !== null));
  if (!open.length) return 0;
  // The team list and the person-only paths come from the default branch, never from the PR being judged.
  const branch = open[0]!.defaultBranch;
  const pack = await github.fileAtRef(repo, branch, deps.repoPack);
  let team: string[] = [];
  let humanPaths: string[] = [];
  let context = { required: [] as string[], instructionFiles: [] as string[] };
  try {
    // ponytail: the repository pack only; a comment-only list in the engine's central pack is not read here.
    if (pack !== null) { const parsed = parsePolicy(pack, deps.repoPack); team = parsed.team.members; humanPaths = parsed.verdict.commentOnly; context = parsed.context; }
  } catch (error) {
    log.warn({ err: error, repo }, 'merge gate: the policy pack is invalid, so no team member counts');
  }

  // A pass must not outlive the rule that gave it: a change to the pack re-judges every PR. `v2` marks the rule
  // itself (CODEOWNERS no longer counts), so the first pass after this change re-judges every PR once.
  const rules = createHash('sha256').update(['v2', pack ?? '', deps.falcon ?? ''].join('\0')).digest('hex');
  const fullKey = `gate:${repo}:full`;
  const [lastRules, lastAt] = (store.cursor(fullKey) ?? ':0').split(':');
  const full = lastRules !== rules || now - Number(lastAt) >= FULL_RECHECK_MS;
  const cursorKey = `gate:${repo}`;
  const since = full ? '' : store.cursor(cursorKey) ?? '';
  // `>=`: a review can land in the same second as the newest PR already seen.
  // A request in Chat does not move a PR's update time, so a PR never judged before is always judged.
  const pulls = open.filter((p) => p.updatedAt >= since || store.cursor(`gate:${repo}#${p.number}`) === null);

  let posted = 0;
  let failed = false;
  let newest = since;
  for (const p of pulls) {
    try {
      const read = await readPull(github, repo, p.number, p.author);
      if (!read.open || (read.baseRef !== branch && !extra.includes(read.baseRef))) continue; // Closed or retargeted since it was listed.
      // A PR that will not hold still gets a wait, never a skip: an old pass must not survive because the PR keeps moving.
      let result: GateVerdict = !read.steady || read.files === null ? { verdict: 'wait', uncovered: [] } : gateVerdict({ files: read.files, team, humanPaths, approvers: read.approvers, falcon: deps.falcon });
      // A team member's approval of an older commit counts when that commit carries the same change. Checked only
      // when the gate would wait, because the comparison runs git.
      let older: { carried: Older; stale: Older } = { carried: [], stale: [] };
      if (result.verdict === 'wait' && read.steady && read.files !== null && deps.sameChange) {
        older = await carriedApprovals(deps, repo, p.number, read.headSha, read.baseRef, p.author, team, governedBy(read.files, deps.repoPack, context));
        if (older.carried.length) result = gateVerdict({ files: read.files, team, humanPaths, approvers: [...read.approvers, ...older.carried.map((c) => c.login)], falcon: deps.falcon });
      }
      // `moved` never equals a judged state, so the next pass posts the real verdict.
      const olderState = [...older.carried, ...older.stale.map((c) => ({ ...c, login: `-${c.login}` }))].map((c) => c.login).join(',');
      const state = read.steady ? `${read.headSha}:${result.verdict}:${read.approvers.join(',')}:${result.uncovered.length}${olderState ? `:${olderState}` : ''}` : `${read.headSha}:moved`;
      const key = `gate:${repo}#${p.number}`;
      if (store.cursor(key) !== state) {
        const outside = read.approvers.filter((a) => a.toLowerCase() !== deps.falcon?.toLowerCase() && !team.some((t) => t.toLowerCase() === a.toLowerCase()));
        const { title, summary } = describe(result, read.approvers, outside, read.files === null, !read.steady, older.carried, older.stale);
        log.info({ repo, number: p.number, head: read.headSha, verdict: result.verdict, steady: read.steady, approvers: read.approvers, dryRun: deps.dryRun }, 'merge gate decided');
        if (!deps.dryRun) {
          await github.postGate(repo, read.headSha, result.verdict === 'pass', title, summary);
          store.setCursor(key, state);
          posted++;
        }
      }
      if (p.updatedAt > newest) newest = p.updatedAt;
    } catch (error) {
      failed = true;
      log.warn({ err: error, repo, number: p.number }, 'merge gate failed for one PR');
    }
  }
  // Queue commits. GitHub tests a queued PR on a commit of its own, and that commit needs the check too. It
  // carries the decision on the PR's own commit: GitHub only queues a PR whose own commit passed, and a push
  // to the PR takes it out of the queue.
  for (const base of new Set(open.map((p) => p.baseRef))) {
    try {
      for (const entry of await github.queueEntries(repo, base)) {
        const passed = (store.cursor(`gate:${repo}#${entry.number}`) ?? '').split(':')[1] === 'pass';
        // ponytail: one cursor per queue commit, never removed; prune by age if the table ever matters.
        const key = `gateq:${repo}:${entry.headSha}`;
        if (store.cursor(key) === String(passed)) continue;
        log.info({ repo, number: entry.number, head: entry.headSha, passed, dryRun: deps.dryRun }, 'merge gate decided for a queue commit');
        if (deps.dryRun) continue;
        await github.postGate(repo, entry.headSha, passed, passed ? 'Approved by Launch Engineering or Falcon' : 'Waiting for Launch Engineering or Falcon to approve', `Merge queue commit for #${entry.number}. It carries the decision on the pull request's own commit.`);
        store.setCursor(key, String(passed));
        posted++;
      }
    } catch (error) {
      failed = true;
      log.warn({ err: error, repo, base }, 'merge gate failed for the merge queue');
    }
  }
  // After a failure the cursors stay, so the next pass judges the same PRs again; the ones already posted are skipped.
  // A dry run posts nothing, so it must not mark anything as seen either.
  if (!failed && !deps.dryRun) {
    store.setCursor(cursorKey, newest);
    if (full) store.setCursor(fullKey, `${rules}:${now}`);
  }
  return posted;
}
