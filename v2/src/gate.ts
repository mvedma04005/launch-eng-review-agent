import { createHash } from 'node:crypto';
import { agreeingPair, approvalOutcome, bindFromObservations, bindFromTimeline, decodeState, encodeState, queueChain, type Binding, type ChainMember } from './gate-binding.ts';
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
  openPulls(repo: string): Promise<Array<{ number: number; headSha: string; headRef: string; baseRef: string; defaultBranch: string; updatedAt: string; author: string; fromFork: boolean; stack: StackRef | null }>>;
  /** One PR's head, base and update time, read fresh. */
  pullState(repo: string, number: number): Promise<{ headSha: string; baseRef: string; baseSha: string; updatedAt: string; open: boolean }>;
  /** Every path the PR changes, or null when GitHub's list may be cut short. */
  changedPaths(repo: string, number: number): Promise<string[] | null>;
  /** Each reviewer's latest verdict on any commit, with its time. A person's comment keeps their verdict; the bot's comment replaces its own. */
  latestVerdicts(repo: string, number: number): Promise<Array<{ login: string; state: string; sha: string; submittedAt: string }>>;
  /** The newest commit both `base` (a commit, or a branch at its tip now) and `headSha` descend from. */
  mergeBase(repo: string, base: string, headSha: string): Promise<string>;
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
  /**
   * PRs in a GitHub stack on the default branch: `on` judges and posts, `shadow` judges and only logs, `off` (default)
   * skips them. `shadow` and `off` post one thing for them: a wait that withdraws a pass left from `on`.
   */
  stacks?: 'off' | 'shadow' | 'on' | undefined;
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

/** R5: a stacked PR's check says it was judged on its own change against its direct base, not against the default branch. */
function forStack({ title, summary }: { title: string; summary: string }, passed: boolean, base: string): { title: string; summary: string } {
  if (passed) return { title: `Approved for its own change on ${base}`, summary: `${summary} This PR is in a stack. The gate judged its own change against \`${base}\`. The stack merges only when every PR below it also passes.` };
  return { title, summary: `${summary} The gate judges this PR on its own change against \`${base}\`.` };
}

/** The PRs a failed pass left to judge again, and the stacks they belong to. */
function parseRetry(raw: string | null): { prs: number[]; stacks: number[] } {
  try {
    const v = JSON.parse(raw || 'null') as { prs?: unknown; stacks?: unknown } | null;
    const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : []);
    return { prs: nums(v?.prs), stacks: nums(v?.stacks) };
  } catch {
    // ponytail: only this code writes the cursor, so an unreadable one is treated as empty; it is rewritten at the next failure.
    return { prs: [], stacks: [] };
  }
}

/**
 * Reads one PR, its files and its reviewers' verdicts, then the PR again. GitHub lists the files of "the PR now", so they
 * belong to the commit only if nothing about the PR moved in between. Tries twice; `steady` says whether it held. `at`
 * is the time of the second read, when the PR was last seen as it is. A steady read also gets the merge base the PR's
 * own change starts from.
 */
async function readPull(github: GatePort, repo: string, number: number, clock: () => number) {
  for (let attempt = 0; ; attempt++) {
    const before = await github.pullState(repo, number);
    const files = await github.changedPaths(repo, number);
    // Read inside the window: a review moves the update time, so a verdict given during the read makes it unsteady.
    const verdicts = await github.latestVerdicts(repo, number);
    const after = await github.pullState(repo, number);
    // Taken now, not after the merge-base call: an observation must not claim a time the gate did not see the PR at.
    const at = clock();
    // shortcut: two pushes inside one second of the update time go unseen; read the files with the compare API,
    // pinned to the commit, if that window ever matters.
    const steady = after.headSha === before.headSha && after.baseRef === before.baseRef && after.baseSha === before.baseSha && after.updatedAt === before.updatedAt;
    // Against the base branch, not `baseSha`: GitHub can show an old base tip for a while after a push to the base.
    // `heads/` names the branch: a tag of the same name could be pointed at an old commit by anyone who can push tags.
    if (steady || attempt === 1) return { ...after, files, verdicts, steady, at, mergeBase: steady ? await github.mergeBase(repo, `heads/${after.baseRef}`, after.headSha) : '' };
  }
}

/**
 * Sorts each approval by the change it was given on (spec R2). Eligible: Falcon, and team members other than the author
 * who are not bots. `direct`: bound to the head, base and merge base now. `carried` or `stale`: bound to another change,
 * then compared. `unbound`: a person's approval that nothing places on a change. The comparison runs git, so it runs
 * only when the direct approvals are not `enough`; then the others are neither compared nor named, as before.
 */
async function countApprovals(deps: GateDeps, repo: string, pr: { number: number; author: string; defaultBranch: string }, read: Awaited<ReturnType<typeof readPull>>, team: string[], rules: string, governs: (path: string) => boolean, enough: (approvers: string[]) => boolean, readOnly: boolean): Promise<Counted> {
  const lower = (s: string) => s.toLowerCase();
  // GitHub's answers about the past never change, so each is asked once. A read-only pass saves nothing.
  const remember = async (key: string, ask: () => Promise<string>) => {
    const known = deps.store.cursor(key);
    if (known !== null) return known;
    const answer = await ask();
    if (!readOnly) deps.store.setCursor(key, answer);
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
    // What the gate saw on both sides of a person's approval, when the two sides agree.
    let pair: Binding | null = null;
    try {
      if (falcon) {
        // The saved review speaks for this approval only when it is of the approved commit or of the head now.
        if (last?.event === 'APPROVE' && (last.headSha === v.sha || last.headSha === read.headSha)) {
          const { headSha, baseSha, baseRef } = last;
          binding = { headSha, baseRef, mergeBase: await remember(`gate-mb:${repo}:${baseSha}:${headSha}`, () => deps.github.mergeBase(repo, baseSha, headSha)) };
        }
      } else if (timed) {
        // Observations are only added at the current time, so once both sides exist the pair never changes. It is saved
        // then, and outlives the 14-day prune. A missing side is not saved: a later observation can still arrive.
        const pairKey = `gate-obs:${repo}#${pr.number}:${v.submittedAt}`;
        const saved = deps.store.cursor(pairKey);
        pair = saved !== null ? JSON.parse(saved) as Binding : agreeingPair(deps.store.gateObservationsAround?.(repo, pr.number, at) ?? { before: null, after: null });
        if (saved === null && pair && !readOnly) deps.store.setCursor(pairKey, JSON.stringify(pair));
        binding = bindFromObservations(pair, v.sha, read.headSha, await baseAt());
      }
      // Nothing better: an approval of this head, given on the default branch and still on it, binds to the change now.
      // The default branch only moves forward, so the PR's own change can only have shrunk since. Not when the gate saw
      // the PR on another base on both sides of the approval: the timeline and the gate disagree, so it waits.
      if (!binding && timed && v.sha === read.headSha && read.baseRef === pr.defaultBranch && (!pair || pair.baseRef === pr.defaultBranch)) {
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
          if (!readOnly) deps.store.setCursor(key, same);
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
 * One pass over the open PRs into the default branch, and with `stacks` the PRs of GitHub stacks on it (only those
 * requested in Chat, unless `requested` is null). It judges the ones that changed since the last pass, and
 * all of them when the rules changed or half an hour has gone by, and posts the check when the decision differs
 * from the last one posted. Returns the number of checks posted.
 */
export async function sweepGate(deps: GateDeps, repo: string, now = Date.now()): Promise<number> {
  const { github, store, log } = deps;
  const requested = deps.requested;
  const extra = deps.branches ?? [];
  const stacks = deps.stacks ?? 'off';
  const judgedBase = (baseRef: string, defaultBranch: string) => baseRef === defaultBranch || extra.includes(baseRef);
  // R1: GitHub holds the PR in a stack on the default branch. A PR on another PR's branch without one is never judged,
  // and neither is a PR from a fork, even in a stack.
  type Listed = { baseRef: string; defaultBranch: string; fromFork: boolean; stack: StackRef | null };
  const inStack = (p: Listed) => !p.fromFork && p.stack?.baseRef === p.defaultBranch && !judgedBase(p.baseRef, p.defaultBranch);
  const stacked = (p: Listed) => stacks !== 'off' && inStack(p);
  const listed = await github.openPulls(repo);
  let posted = 0;
  // PRs whose judgment or withdrawal failed in this pass. Their saved decision may be an old pass, so the queue chain
  // does not trust it.
  const broken = new Set<number>();
  // PRs that failed in an earlier pass and have not been judged without error since: see `retryKey` below.
  const retryKey = `gate-retry:${repo}`;
  const carried = parseRetry(store.cursor(retryKey));
  const unresolved = new Set(carried.prs);
  // A required check must not keep a pass the gate no longer stands behind. With stacks off or in shadow, a stacked
  // PR the gate judged before gets a wait on its head when its saved decision is a pass, and again on every new head:
  // a push back to an older commit must not bring back the pass that commit got under `on`. The decision only:
  // nothing is read, observed or cached. A PR the gate never judged has no pass to withdraw.
  if (stacks !== 'on' && !deps.dryRun) {
    for (const p of listed.filter(inStack)) {
      const key = `gate:${repo}#${p.number}`;
      unresolved.delete(p.number);
      const saved = decodeState(store.cursor(key));
      if (!saved || (saved.verdict !== 'pass' && saved.headSha === p.headSha)) continue;
      try {
        await github.postGate(repo, p.headSha, false, 'Waiting: stacked PRs are not judged now', 'The gate does not judge stacked PRs now, so an earlier pass on this commit no longer counts.');
        // No merge base and a detail no judged state has, so a later real decision always posts.
        store.setCursor(key, encodeState({ headSha: p.headSha, baseRef: p.baseRef, mergeBase: '', verdict: 'wait', detail: 'withdrawn' }));
        posted++;
      } catch (error) {
        // The saved pass stays, so the next pass tries again.
        broken.add(p.number);
        log.warn({ err: error, repo, number: p.number }, 'merge gate could not withdraw a stacked pass');
      }
    }
  }
  // A PR that already has a check keeps being judged, so a pass is withdrawn even after the PR leaves the list.
  const open = listed.filter((p) => (judgedBase(p.baseRef, p.defaultBranch) || stacked(p)) && (!requested || requested.has(p.number) || store.cursor(`gate:${repo}#${p.number}`) !== null));
  if (!open.length) return posted;
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
  // The `stacks` mode too: a switch re-judges every PR at once, so a return to `on` replaces each withdrawal straight away.
  const rules = createHash('sha256').update(['v3', pack ?? '', deps.falcon ?? '', stacks].join('\0')).digest('hex');
  const fullKey = `gate:${repo}:full`;
  const [lastRules, lastAt] = (store.cursor(fullKey) ?? ':0').split(':');
  const full = lastRules !== rules || now - Number(lastAt) >= FULL_RECHECK_MS;
  const clock = () => deps.now?.() ?? Date.now();
  if (full && !deps.dryRun) store.pruneGateObservations?.(clock() - OBSERVATION_RETENTION_MS);
  const cursorKey = `gate:${repo}`;
  const since = full ? '' : store.cursor(cursorKey) ?? '';
  // `>=`: a review can land in the same second as the newest PR already seen.
  // A request in Chat does not move a PR's update time, so a PR never judged before is always judged. Not a stacked PR
  // in shadow: shadow saves no decision, so it would be read on every pass. A full pass judges it.
  const saved = (p: { number: number }) => store.cursor(`gate:${repo}#${p.number}`);
  const chosen = open.filter((p) => p.updatedAt >= since || carried.prs.includes(p.number) || (saved(p) === null && !(stacks === 'shadow' && stacked(p))));
  // R3: a push to a PR moves the base of the PR above it, but not that PR's update time, so the stacked PRs of a stack
  // are judged together. The bottom PR has no parent in the stack: its own update time is enough. Only a PR that really
  // changed moves its stack: a newer update time, or a head its saved decision is not for. A PR chosen only by `>=` or
  // for a missing decision does not, or every pass would read the whole stack. A failed pass leaves `since` where it
  // was, so the stack of a changed PR is judged again on the next pass.
  const changed = (p: { number: number; headSha: string; updatedAt: string }) => {
    const head = decodeState(saved(p))?.headSha;
    return p.updatedAt > since || (head !== undefined && head !== p.headSha);
  };
  const touched = new Set([...carried.stacks, ...chosen.filter(changed).flatMap((p) => (stacks !== 'off' && p.stack ? [p.stack.number] : []))]);
  const pulls = open.filter((p) => chosen.includes(p) || (p.stack !== null && stacked(p) && touched.has(p.stack.number)));

  let failed = false;
  let newest = since;
  for (const p of pulls) {
    try {
      const read = await readPull(github, repo, p.number, clock);
      // Put back in `broken` by the catch below if posting the decision fails.
      unresolved.delete(p.number);
      const asStack = stacked(p);
      // Closed or retargeted since it was listed. A PR listed in a stack is judged on whatever base it has now.
      if (!read.open || (!judgedBase(read.baseRef, branch) && !asStack)) continue;
      // I5: shadow writes nothing for a stacked PR, as a dry run writes nothing at all.
      const shadow = asStack && stacks === 'shadow';
      const readOnly = deps.dryRun || shadow;
      // Recorded before the approvals are counted, so an approval given just now has an observation after it.
      if (read.steady && !readOnly) store.observeGate?.({ repo, number: p.number, atMs: read.at, headSha: read.headSha, baseRef: read.baseRef, baseSha: read.baseSha, mergeBase: read.mergeBase });
      // A PR that will not hold still gets a wait, never a skip: an old pass must not survive because the PR keeps moving.
      let result: GateVerdict = { verdict: 'wait', uncovered: [] };
      let counted: Counted = { direct: [], carried: [], stale: [], unbound: [], others: [] };
      if (read.steady && read.files !== null) {
        const files = read.files;
        const judge = (approvers: string[]) => gateVerdict({ files, team, humanPaths, approvers, falcon: deps.falcon });
        counted = await countApprovals(deps, repo, p, read, team, rules, governedBy(files, deps.repoPack, context), (approvers) => judge(approvers).verdict === 'pass', readOnly);
        result = judge([...counted.direct, ...counted.carried.map((c) => c.login)]);
      }
      const approvers = [...counted.direct, ...counted.others].sort();
      const older = [...counted.carried.map((c) => c.login), ...counted.stale.map((c) => `-${c.login}`), ...counted.unbound.map((l) => `?${l}`)].join(',');
      // R3: the decision is for this head on this base. `moved` never equals a judged state, so the next pass posts the real verdict.
      const state = encodeState({ headSha: read.headSha, baseRef: read.baseRef, mergeBase: read.mergeBase, verdict: read.steady ? result.verdict : 'moved', detail: read.steady ? `${approvers.join(',')}:${result.uncovered.length}${older ? `:${older}` : ''}` : '' });
      const key = `gate:${repo}#${p.number}`;
      if (store.cursor(key) !== state) {
        const outside = approvers.filter((a) => a.toLowerCase() !== deps.falcon?.toLowerCase() && !team.some((t) => t.toLowerCase() === a.toLowerCase()));
        const copy = describe(result, approvers, outside, read.files === null, !read.steady, counted.carried, counted.stale, counted.unbound);
        const { title, summary } = asStack && read.baseRef !== branch ? forStack(copy, result.verdict === 'pass', read.baseRef) : copy;
        // The base, the merge base and each older approval, so a shadow line can be checked against GitHub.
        log.info({ repo, number: p.number, head: read.headSha, base: read.baseRef, mergeBase: read.mergeBase, verdict: result.verdict, steady: read.steady, approvers, carried: counted.carried, stale: counted.stale, unbound: counted.unbound, dryRun: deps.dryRun }, shadow ? 'merge gate decided (shadow)' : 'merge gate decided');
        if (!readOnly) {
          await github.postGate(repo, read.headSha, result.verdict === 'pass', title, summary);
          store.setCursor(key, state);
          posted++;
        }
      }
      if (p.updatedAt > newest) newest = p.updatedAt;
    } catch (error) {
      failed = true;
      broken.add(p.number);
      log.warn({ err: error, repo, number: p.number }, 'merge gate failed for one PR');
    }
  }
  // Queue commits. GitHub tests a queued PR on a commit of its own, and that commit needs the check too. For a PR alone
  // it carries the decision on the PR's own commit: GitHub only queues a PR whose own commit passed, and a push to the
  // PR takes it out of the queue. GitHub queues a stack as one group and may name it after any member, so with stacks
  // on the commit of a stacked PR may carry the whole open stack, and every open PR of the stack must pass. With stacks
  // off or in shadow the chain stops at the entry, so a stack still merges one PR at a time: GitHub requires the check
  // on every PR of a merge group, and no PR above the bottom has a current pass then.
  // Only the default branch and the extra branches: a stacked PR is queued on the stack's base, never on its own.
  for (const base of new Set(open.filter((p) => judgedBase(p.baseRef, p.defaultBranch)).map((p) => p.baseRef))) {
    try {
      for (const entry of await github.queueEntries(repo, base)) {
        // R4: the commit passes only when every open member of its chain passes now. An entry whose PR is not listed,
        // is not an open member of its stack, or whose stack cannot be read, waits: this check is required.
        const row = open.find((p) => p.number === entry.number);
        let chain: ReturnType<typeof queueChain> = { passed: false, blocker: entry.number };
        if (row) {
          try {
            const members: ChainMember[] = row.stack
              ? (await github.stackMembers(repo, entry.number)).filter((m) => m.open).map(({ number, position, baseRef, headRef, headSha }) => ({ number, position, baseRef, headRef, headSha }))
              : [{ number: row.number, position: 1, baseRef: row.baseRef, headRef: row.headRef, headSha: row.headSha }];
            const states = new Map(members.map((m) => [m.number, broken.has(m.number) || unresolved.has(m.number) ? null : decodeState(store.cursor(`gate:${repo}#${m.number}`))] as const));
            // With stacks on, the chain runs to the top open member: the highest position, whatever order GitHub lists
            // them in. Otherwise it runs to the entry.
            if (members.some((m) => m.number === entry.number)) {
              const top = row.stack && stacks === 'on' ? members.reduce((a, b) => (b.position > a.position ? b : a)).number : entry.number;
              chain = queueChain(top, members, states, base);
            }
          } catch (error) {
            // Fail closed: the commit gets a wait, so a pass posted earlier on it does not stay.
            log.warn({ err: error, repo, number: entry.number }, 'merge gate could not read the stack for a queue commit; it waits');
          }
        }
        const passed = chain.passed;
        // ponytail: one cursor per queue commit, never removed; prune by age if the table ever matters.
        const key = `gateq:${repo}:${entry.headSha}`;
        if (store.cursor(key) === String(passed)) continue;
        log.info({ repo, number: entry.number, head: entry.headSha, passed, dryRun: deps.dryRun }, 'merge gate decided for a queue commit');
        if (deps.dryRun) continue;
        await github.postGate(repo, entry.headSha, passed, passed ? 'Approved by Launch Engineering or Falcon' : 'Waiting for Launch Engineering or Falcon to approve', chain.passed || chain.blocker === entry.number ? `Merge queue commit for #${entry.number}. It carries the decision on the pull request's own commit.` : `Merge queue commit for #${entry.number}. A PR in its stack has no current pass: #${chain.blocker}.`);
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
  // A failed PR is judged again with its stack until a pass reads it without error, even when `since` has moved on:
  // a push inside the same second of the update time leaves nothing else to choose it, and its child would keep a pass
  // for the old merge base. The cursor is cleared once nothing is left. A dry run saves nothing.
  if (!deps.dryRun && (broken.size || unresolved.size || carried.prs.length || carried.stacks.length)) {
    const prs = [...new Set([...broken, ...unresolved])].sort((a, b) => a - b);
    const stackNumbers = [...new Set(prs.flatMap((n) => listed.find((l) => l.number === n)?.stack?.number ?? []))].sort((a, b) => a - b);
    store.setCursor(retryKey, prs.length ? JSON.stringify({ prs, stacks: stackNumbers }) : '');
  }
  if (!failed && !deps.dryRun) {
    store.setCursor(cursorKey, newest);
    if (full) store.setCursor(fullKey, `${rules}:${now}`);
  }
  return posted;
}
