import { createHash } from 'node:crypto';
import type { Logger } from './log.ts';
import { gateVerdict, type GateVerdict } from './policy/gate.ts';
import { parsePolicy } from './policy/load.ts';

/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
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
  fileAtRef(repo: string, ref: string, path: string): Promise<string | null>;
  postGate(repo: string, headSha: string, passed: boolean, title: string, summary: string): Promise<void>;
}

export interface GateDeps {
  github: GatePort;
  store: { cursor(key: string): string | null; setCursor(key: string, value: string): void };
  log: Logger;
  /** The CODEOWNERS entry Falcon stands in for. */
  teamOwner: string;
  /** Falcon's own login, or null when it is unknown. */
  falcon: string | null;
  /** Path of the repository's policy pack, which holds the team list. */
  repoPack: string;
  /** The PRs requested in Chat: the gate judges no others. Null: it judges every open PR into the default branch. */
  requested: Set<number> | null;
  dryRun: boolean;
}

function describe({ verdict, uncovered }: GateVerdict, approvers: string[], tooMany: boolean, moved: boolean): { title: string; summary: string } {
  const who = approvers.length ? `Approved on this commit by ${approvers.join(', ')}.` : 'Nobody has approved this commit yet.';
  const list = uncovered.slice(0, 10).map((f) => `\`${f}\``).join(', ') + (uncovered.length > 10 ? ` and ${uncovered.length - 10} more` : '');
  if (verdict === 'pass') return { title: 'Approved by an owner or Falcon', summary: `${who} A team member or Falcon approved, and every file that names its owners has one of them.` };
  if (moved) return { title: 'Waiting: the PR changed while it was being checked', summary: 'The PR was pushed to or edited during the check. It is checked again on the next pass.' };
  if (tooMany) return { title: 'Waiting: too many files to check', summary: 'This PR changes more files than GitHub lists, so the list of files may be incomplete. Split the PR.' };
  return { title: 'Waiting for an owner or Falcon to approve', summary: `${who} Still needs an approval from a team member or Falcon, or from a named owner, for: ${list || 'this change'}.` };
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
 * One pass over the open PRs into the default branch (only those requested in Chat, unless `requested` is null). It judges the ones that changed since the last pass, and
 * all of them when the rules changed or half an hour has gone by, and posts the check when the decision differs
 * from the last one posted. Returns the number of checks posted.
 */
export async function sweepGate(deps: GateDeps, repo: string, now = Date.now()): Promise<number> {
  const { github, store, log } = deps;
  const requested = deps.requested;
  // A PR that already has a check keeps being judged, so a pass is withdrawn even after the PR leaves the list.
  const open = (await github.openPulls(repo)).filter((p) => p.baseRef === p.defaultBranch && (!requested || requested.has(p.number) || store.cursor(`gate:${repo}#${p.number}`) !== null));
  if (!open.length) return 0;
  // Owners and the team list come from the default branch, never from the PR being judged.
  const branch = open[0]!.defaultBranch;
  let codeowners = '';
  for (const path of CODEOWNERS_PATHS) {
    const text = await github.fileAtRef(repo, branch, path);
    if (text !== null) { codeowners = text; break; }
  }
  const pack = await github.fileAtRef(repo, branch, deps.repoPack);
  let team: string[] = [];
  try {
    if (pack !== null) team = parsePolicy(pack, deps.repoPack).team.members;
  } catch (error) {
    log.warn({ err: error, repo }, 'merge gate: the policy pack is invalid, so no team member counts');
  }

  // A pass must not outlive the rule that gave it: a change to CODEOWNERS, the pack or the team entry re-judges every PR.
  const rules = createHash('sha256').update([codeowners, pack ?? '', deps.teamOwner, deps.falcon ?? ''].join('\0')).digest('hex');
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
      if (!read.open || read.baseRef !== branch) continue; // Closed or retargeted since it was listed.
      // A PR that will not hold still gets a wait, never a skip: an old pass must not survive because the PR keeps moving.
      const result: GateVerdict = !read.steady || read.files === null ? { verdict: 'wait', uncovered: [] } : gateVerdict({ files: read.files, codeowners, team, approvers: read.approvers, falcon: deps.falcon });
      // `moved` never equals a judged state, so the next pass posts the real verdict.
      const state = read.steady ? `${read.headSha}:${result.verdict}:${read.approvers.join(',')}:${result.uncovered.length}` : `${read.headSha}:moved`;
      const key = `gate:${repo}#${p.number}`;
      if (store.cursor(key) !== state) {
        const { title, summary } = describe(result, read.approvers, read.files === null, !read.steady);
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
  // After a failure the cursors stay, so the next pass judges the same PRs again; the ones already posted are skipped.
  // A dry run posts nothing, so it must not mark anything as seen either.
  if (!failed && !deps.dryRun) {
    store.setCursor(cursorKey, newest);
    if (full) store.setCursor(fullKey, `${rules}:${now}`);
  }
  return posted;
}
