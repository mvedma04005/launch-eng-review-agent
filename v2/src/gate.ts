import type { Logger } from './log.ts';
import { gateVerdict, type GateVerdict } from './policy/gate.ts';
import { parsePolicy } from './policy/load.ts';

/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
/** GitHub lists at most this many files for a PR; at the cap the list may be cut short, so the gate waits. */
const MAX_FILES = 3000;

/** The GitHub surface the merge gate needs; a fake implements this in tests. */
export interface GatePort {
  openPulls(repo: string, since: string): Promise<Array<{ number: number; headSha: string; baseRef: string; defaultBranch: string; updatedAt: string }>>;
  changedPaths(repo: string, number: number): Promise<string[]>;
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
  dryRun: boolean;
}

function describe({ verdict, uncovered }: GateVerdict, approvers: string[], tooMany: boolean): { title: string; summary: string } {
  const who = approvers.length ? `Approved on this commit by ${approvers.join(', ')}.` : 'Nobody has approved this commit yet.';
  const list = uncovered.slice(0, 10).map((f) => `\`${f}\``).join(', ') + (uncovered.length > 10 ? ` and ${uncovered.length - 10} more` : '');
  if (verdict === 'pass') return { title: 'Approved by an owner or Falcon', summary: `${who} Every changed file has an approval from one of its owners.` };
  if (tooMany) return { title: 'Waiting: too many files to check', summary: `This PR changes ${MAX_FILES} files or more, so the list of files may be incomplete. Split the PR.` };
  if (verdict === 'unknown') return { title: 'Waiting: cannot confirm the approver is an owner', summary: `${who} These files have an owner team whose members Falcon cannot read: ${list}.` };
  return { title: 'Waiting for an owner or Falcon to approve', summary: `${who} No owner approval covers: ${list || 'this change'}.` };
}

/**
 * One pass over the open PRs that changed since the last pass. For each PR into the default branch it decides the
 * merge gate from GitHub state and posts the check when the decision differs from the last one posted.
 * Returns the number of checks posted.
 */
export async function sweepGate(deps: GateDeps, repo: string): Promise<number> {
  const { github, store, log } = deps;
  const cursorKey = `gate:${repo}`;
  const since = store.cursor(cursorKey) ?? '';
  // `openPulls` includes PRs updated in the same second as the cursor: a review can land in that second.
  const pulls = (await github.openPulls(repo, since)).filter((p) => p.baseRef === p.defaultBranch);
  if (!pulls.length) return 0;
  // Owners and the team list come from the default branch, never from the PR being judged.
  const branch = pulls[0]!.defaultBranch;
  let codeowners = '';
  for (const path of CODEOWNERS_PATHS) {
    const text = await github.fileAtRef(repo, branch, path);
    if (text !== null) { codeowners = text; break; }
  }
  const pack = await github.fileAtRef(repo, branch, deps.repoPack);
  const team = pack === null ? [] : parsePolicy(pack, deps.repoPack).team.members;

  let posted = 0;
  let failed = false;
  let newest = since;
  for (const p of pulls) {
    try {
      const files = await github.changedPaths(repo, p.number);
      const approvers = (await github.approvers(repo, p.number, p.headSha)).sort();
      const tooMany = files.length >= MAX_FILES;
      const result: GateVerdict = tooMany ? { verdict: 'wait', uncovered: [] } : gateVerdict({ files, codeowners, teamOwner: deps.teamOwner, team, approvers, falcon: deps.falcon });
      const state = `${p.headSha}:${result.verdict}:${approvers.join(',')}:${result.uncovered.length}`;
      const key = `gate:${repo}#${p.number}`;
      if (store.cursor(key) !== state) {
        const { title, summary } = describe(result, approvers, tooMany);
        log.info({ repo, number: p.number, head: p.headSha, verdict: result.verdict, approvers, dryRun: deps.dryRun }, 'merge gate decided');
        if (!deps.dryRun) {
          await github.postGate(repo, p.headSha, result.verdict === 'pass', title, summary);
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
  // After a failure the cursor stays, so the next pass lists the same PRs again; the ones already posted are skipped.
  if (!failed) store.setCursor(cursorKey, newest);
  return posted;
}
