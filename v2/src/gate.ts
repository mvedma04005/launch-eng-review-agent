import { createHash } from 'node:crypto';
import { approvalOutcome, bindFromObservations, bindFromTimeline, decodeState, encodeState, type Binding } from './gate-binding.ts';
import type { Logger } from './log.ts';
import { gateVerdict, governedBy, type GateVerdict } from './policy/gate.ts';
import { parsePolicy } from './policy/load.ts';
import type { GateObservation } from './types.ts';

/** Every open PR is judged again this often, in case a change did not move its update time. */
const FULL_RECHECK_MS = 30 * 60_000;
/** How long observations are kept. An approval older than this binds only through GitHub's timeline, or not at all. */
const OBSERVATION_RETENTION_MS = 14 * 24 * 3_600_000;

export type StackRef = { number: number; baseRef: string; position: number };

/** The GitHub surface the merge gate needs; a fake implements this in tests. */
export interface GatePort {
  openPulls(repo: string): Promise<Array<{ number: number; headSha: string; headRef: string; baseRef: string; defaultBranch: string; updatedAt: string; author: string; stack: StackRef | null }>>;
  /** One PR's head, base and update time, read fresh. */
  pullState(repo: string, number: number): Promise<{ headSha: string; baseRef: string; baseSha: string; updatedAt: string; open: boolean }>;
  /** Every path the PR changes, or null when GitHub's list may be cut short. */
  changedPaths(repo: string, number: number): Promise<string[] | null>;
  /** Each reviewer's latest verdict on any commit, with its time. A person's comment keeps their verdict; the bot's comment replaces its own. */
  latestVerdicts(repo: string, number: number): Promise<Array<{ login: string; state: string; sha: string; submittedAt: string }>>;
  /** The newest commit both `baseSha` and `headSha` descend from. */
  mergeBase(repo: string, baseSha: string, headSha: string): Promise<string>;
  /** The base branch the PR had at `atMs`. */
  baseRefAt(repo: string, number: number, atMs: number): Promise<string>;
  /** The PRs in this PR's stack, bottom first; empty when it is in none. */
  stackMembers(repo: string, number: number): Promise<Array<{ number: number; position: number; open: boolean; baseRef: string; headRef: string; headSha: string }>>;
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
    /** Falcon's latest review of a PR on any commit except `excludeHead`, with the base it saved. Absent: Falcon's approval binds only as a person's does on the default branch. */
    lastReview?(repo: string, number: number, excludeHead: string): { headSha: string; baseSha: string; baseRef: string; event: string } | null;
    /** Records what the gate saw of a PR at one moment. Absent: no person's approval binds from observations. */
    observeGate?(o: GateObservation): void;
    gateObservationsAround?(repo: string, number: number, atMs: number): { before: GateObservation | null; after: GateObservation | null };
    pruneGateObservations?(beforeMs: number): number;
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
   * is the merge base `oldSha` was approved on; `mergeBase` is the one the gate read for `headSha`, used as is. Absent:
   * only approvals of the change as it is now count. Throws when it cannot tell.
   */
  sameChange?: (number: number, oldSha: string, headSha: string, governs: (path: string) => boolean, oldBase?: string, baseRef?: string, mergeBase?: string) => Promise<boolean>;
  /** The time an observation is recorded at. Default: `Date.now`. */
  now?: (() => number) | undefined;
}

type Older = Array<{ login: string; sha: string }>;
/** `others` approved this commit but are not eligible: they are named in the check and never counted. */
type Counted = { direct: string[]; carried: Older; stale: Older; unbound: string[]; others: string[] };

function describe({ verdict, uncovered }: GateVerdict, approvers: string[], outside: string[], tooMany: boolean, moved: boolean, carried: Older = [], stale: Older = [], unbound: string[] = []): { title: string; summary: string } {
  // An approval GitHub shows but the gate does not count is the first thing an author asks about.
  const notCounted = outside.length ? ` ${outside.join(' and ')} ${outside.length === 1 ? 'is' : 'are'} not in the team list of the policy file, so ${outside.length === 1 ? 'that' : 'their'} approval does not count here.` : '';
  const short = (sha: string) => sha.slice(0, 12);
  // An approval of an earlier commit is named with that commit, so nobody reads it as an approval of this one.
  const earlier = carried.map((c) => ` Approved by ${c.login} on ${short(c.sha)}, an earlier commit with the same change.`).join('')
    + stale.map((c) => ` ${c.login} approved ${short(c.sha)}, but the change is different on this commit, so that approval does not count here. Approve this commit again.`).join('')
    + unbound.map((login) => ` ${login} approved, but Falcon could not tell which change that approval was for, so it does not count here. Approve this commit again.`).join('');
  const who = (approvers.length ? `Approved on this commit by ${approvers.join(', ')}.${notCounted}` : carried.length ? '' : 'Nobody has approved this commit yet.') + earlier;
  const list = uncovered.slice(0, 10).map((f) => `\`${f}\``).join(', ') + (uncovered.length > 10 ? ` and ${uncovered.length - 10} more` : '');
  if (verdict === 'pass') return { title: 'Approved by Launch Engineering or Falcon', summary: `${who.trim()} A team member or Falcon approved ${carried.length && !approvers.length ? 'this change' : 'this commit'}.` };
  if (moved) return { title: 'Waiting: the PR changed while it was being checked', summary: 'The PR was pushed to or edited during the check. It is checked again on the next pass.' };
  if (tooMany) return { title: 'Waiting: too many files to check', summary: 'This PR changes more files than GitHub lists, so the list of files may be incomplete. Split the PR.' };
  return { title: 'Waiting for Launch Engineering or Falcon to approve', summary: `${who.trim()} Still needs an approval from a team member, or from Falcon where Falcon may approve, for: ${list || 'this change'}.` };
}

/**
 * Reads one PR, its files and its reviewers' verdicts, then the PR again. GitHub lists the files of "the PR now", so they
 * belong to the commit only if nothing about the PR moved in between. Tries twice; `steady` says whether it held. A
 * steady read also gets the merge base the PR's own change starts from.
 */
async function readPull(github: GatePort, repo: string, number: number) {
  for (let attempt = 0; ; attempt++) {
    const before = await github.pullState(repo, number);
    const files = await github.changedPaths(repo, number);
    // Read inside the window: a review moves the update time, so a verdict given during the read makes it unsteady.
    const verdicts = await github.latestVerdicts(repo, number);
    const after = await github.pullState(repo, number);
    // shortcut: two pushes inside one second of the update time go unseen; read the files with the compare API,
    // pinned to the commit, if that window ever matters.
    const steady = after.headSha === before.headSha && after.baseRef === before.baseRef && after.baseSha === before.baseSha && after.updatedAt === before.updatedAt;
    if (steady || attempt === 1) return { ...after, files, verdicts, steady, mergeBase: steady ? await github.mergeBase(repo, after.baseSha, after.headSha) : '' };
  }
}

/**
 * Sorts each approval by the change it was given on (spec R2). Eligible: Falcon, and team members other than the author
 * who are not bots. `direct`: bound to the head, base and merge base now. `carried` or `stale`: bound to another change,
 * then compared. `unbound`: a person's approval that nothing places on a change. The comparison runs git, so it runs
 * only when the direct approvals are not `enough`; then the others are neither compared nor named, as before.
 */
async function countApprovals(deps: GateDeps, repo: string, pr: { number: number; author: string; defaultBranch: string }, read: Awaited<ReturnType<typeof readPull>>, team: string[], rules: string, governs: (path: string) => boolean, enough: (approvers: string[]) => boolean): Promise<Counted> {
  const lower = (s: string) => s.toLowerCase();
  // GitHub's answers about the past never change, so each is asked once. A dry run saves nothing.
  const remember = async (key: string, ask: () => Promise<string>) => {
    const known = deps.store.cursor(key);
    if (known !== null) return known;
    const answer = await ask();
    if (!deps.dryRun) deps.store.setCursor(key, answer);
    return answer;
  };
  const members = new Set(team.map(lower));
  const current: Binding = { headSha: read.headSha, baseRef: read.baseRef, mergeBase: read.mergeBase };
  // The head and base tip Falcon reviewed, saved with its review.
  const last = deps.store.lastReview?.(repo, pr.number, '') ?? null;
  const direct: string[] = [];
  const unbound: string[] = [];
  const others: string[] = [];
  const pending: Array<{ login: string; binding: Binding }> = [];
  for (const v of read.verdicts) {
    const l = lower(v.login);
    // GitHub refuses a self-approval; this does not rely on it.
    if (v.state !== 'APPROVED' || l === lower(pr.author)) continue;
    const falcon = l === deps.falcon?.toLowerCase();
    if (!falcon && (l.endsWith('[bot]') || !members.has(l))) {
      if (v.sha === read.headSha) others.push(v.login);
      continue;
    }
    const at = Date.parse(v.submittedAt);
    // A time that does not parse places the approval nowhere: only Falcon's saved review can bind it.
    const timed = !Number.isNaN(at);
    // The base branch GitHub's timeline gives for the moment of the approval, asked at most once.
    let base: string | undefined;
    const baseAt = async () => base ??= await remember(`gate-baseat:${repo}#${pr.number}:${v.submittedAt}`, () => deps.github.baseRefAt(repo, pr.number, at));
    let binding: Binding | null = null;
    try {
      if (falcon) {
        // The saved review speaks for this approval only when it is of the approved commit or of the head now.
        if (last?.event === 'APPROVE' && (last.headSha === v.sha || last.headSha === read.headSha)) {
          const { headSha, baseSha, baseRef } = last;
          binding = { headSha, baseRef, mergeBase: await remember(`gate-mb:${repo}:${baseSha}:${headSha}`, () => deps.github.mergeBase(repo, baseSha, headSha)) };
        }
      } else if (timed) {
        binding = bindFromObservations(deps.store.gateObservationsAround?.(repo, pr.number, at) ?? { before: null, after: null }, v.sha, read.headSha, await baseAt());
      }
      // Nothing better: an approval of this head, given on the default branch and still on it, binds to the change now.
      // The default branch only moves forward, so the PR's own change can only have shrunk since.
      if (!binding && timed && v.sha === read.headSha && read.baseRef === pr.defaultBranch) {
        binding = bindFromTimeline(await baseAt(), v.sha, current, [pr.defaultBranch]);
      }
    } catch (error) {
      // Not counted and not named, so the PR waits; the next pass looks again.
      deps.log.info({ repo, number: pr.number, login: v.login, err: String(error) }, 'merge gate: could not look up which change an approval was for');
      continue;
    }
    if (binding && approvalOutcome(binding, current) === 'direct') direct.push(v.login);
    else if (binding) pending.push({ login: v.login, binding });
    // R5 names a person's approval it cannot place. Falcon's simply does not count.
    else if (!falcon) unbound.push(v.login);
  }
  if (enough(direct)) return { direct, carried: [], stale: [], unbound: [], others };
  const carried: Older = [];
  const stale: Older = [];
  const compare = deps.sameChange;
  if (compare) {
    for (const { login, binding } of pending) {
      // I4: the PR, the binding, the change now and the rules. A move of any of them compares again.
      // ponytail: one cursor per key, never removed; prune by age if the table ever matters.
      const key = `gate-carry:${repo}#${pr.number}:${binding.headSha}:${binding.baseRef}:${binding.mergeBase}:${read.headSha}:${read.baseRef}:${read.mergeBase}:${rules}`;
      let same = deps.store.cursor(key);
      if (same === null) {
        try {
          // The merge base stands in for the old base tip: the merge base of a merge base and its head is itself.
          same = String(await compare(pr.number, binding.headSha, read.headSha, governs, binding.mergeBase, read.baseRef, read.mergeBase));
          if (!deps.dryRun) deps.store.setCursor(key, same);
        } catch (error) {
          // A comparison that fails is not saved and counts for nothing.
          deps.log.info({ repo, number: pr.number, old: binding.headSha, head: read.headSha, err: String(error) }, 'merge gate: could not compare with an older approval');
          continue;
        }
      }
      (same === 'true' ? carried : stale).push({ login, sha: binding.headSha });
    }
  }
  return { direct, carried, stale, unbound, others };
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

  // A pass must not outlive the rule that gave it: a change to the pack re-judges every PR. `v3` marks the rule
  // itself (an approval counts only for the change it was given on), so the first pass after this change re-judges
  // every PR once.
  const rules = createHash('sha256').update(['v3', pack ?? '', deps.falcon ?? ''].join('\0')).digest('hex');
  const fullKey = `gate:${repo}:full`;
  const [lastRules, lastAt] = (store.cursor(fullKey) ?? ':0').split(':');
  const full = lastRules !== rules || now - Number(lastAt) >= FULL_RECHECK_MS;
  const clock = () => deps.now?.() ?? Date.now();
  if (full && !deps.dryRun) store.pruneGateObservations?.(clock() - OBSERVATION_RETENTION_MS);
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
      const read = await readPull(github, repo, p.number);
      if (!read.open || (read.baseRef !== branch && !extra.includes(read.baseRef))) continue; // Closed or retargeted since it was listed.
      // Recorded before the approvals are counted, so an approval given just now has an observation after it.
      if (read.steady && !deps.dryRun) store.observeGate?.({ repo, number: p.number, atMs: clock(), headSha: read.headSha, baseRef: read.baseRef, baseSha: read.baseSha, mergeBase: read.mergeBase });
      // A PR that will not hold still gets a wait, never a skip: an old pass must not survive because the PR keeps moving.
      let result: GateVerdict = { verdict: 'wait', uncovered: [] };
      let counted: Counted = { direct: [], carried: [], stale: [], unbound: [], others: [] };
      if (read.steady && read.files !== null) {
        const files = read.files;
        const judge = (approvers: string[]) => gateVerdict({ files, team, humanPaths, approvers, falcon: deps.falcon });
        counted = await countApprovals(deps, repo, p, read, team, rules, governedBy(files, deps.repoPack, context), (approvers) => judge(approvers).verdict === 'pass');
        result = judge([...counted.direct, ...counted.carried.map((c) => c.login)]);
      }
      const approvers = [...counted.direct, ...counted.others].sort();
      const older = [...counted.carried.map((c) => c.login), ...counted.stale.map((c) => `-${c.login}`), ...counted.unbound.map((l) => `?${l}`)].join(',');
      // R3: the decision is for this head on this base. `moved` never equals a judged state, so the next pass posts the real verdict.
      const state = encodeState({ headSha: read.headSha, baseRef: read.baseRef, mergeBase: read.mergeBase, verdict: read.steady ? result.verdict : 'moved', detail: read.steady ? `${approvers.join(',')}:${result.uncovered.length}${older ? `:${older}` : ''}` : '' });
      const key = `gate:${repo}#${p.number}`;
      if (store.cursor(key) !== state) {
        const outside = approvers.filter((a) => a.toLowerCase() !== deps.falcon?.toLowerCase() && !team.some((t) => t.toLowerCase() === a.toLowerCase()));
        const { title, summary } = describe(result, approvers, outside, read.files === null, !read.steady, counted.carried, counted.stale, counted.unbound);
        log.info({ repo, number: p.number, head: read.headSha, verdict: result.verdict, steady: read.steady, approvers, dryRun: deps.dryRun }, 'merge gate decided');
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
        const saved = decodeState(store.cursor(`gate:${repo}#${entry.number}`));
        // A pass judged on another base branch says nothing about this queue's branch.
        const passed = saved?.verdict === 'pass' && saved.baseRef === base;
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
