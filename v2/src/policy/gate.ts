import { basename, dirname } from 'node:path';
import { minimatch } from './glob.ts';

/** Files that decide who may merge. Falcon's own approval never covers a change to them. */
const GATE_FILES = ['.falcon/**', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export const isGateFile = (path: string): boolean => GATE_FILES.some((g) => minimatch(path, g));

/**
 * Whether a change on the base branch touches something the PR's review depended on: the PR's own files, the policy
 * pack, the gate's files, required context, or an instruction file in a folder above a PR file. Such a base change
 * means an approval of the same diff no longer carries over.
 */
export function governedBy(prPaths: string[], packPath: string, context: { required: string[]; instructionFiles: string[] }): (path: string) => boolean {
  return (p) => prPaths.includes(p) || p === packPath || isGateFile(p) || context.required.includes(p)
    || (context.instructionFiles.includes(basename(p)) && prPaths.some((f) => dirname(p) === '.' || f.startsWith(`${dirname(p)}/`)));
}

export interface GateInput {
  /** Every path the PR changes, old names of renamed files included. */
  files: string[];
  /** Logins of the team, from the policy pack. */
  team: string[];
  /** Globs from the pack's verdict.commentOnly: paths a person must approve. Falcon's approval never covers them. */
  humanPaths?: string[];
  /** Logins whose latest verdict on the current commit is an approval. */
  approvers: string[];
  /** Falcon's own login, or null when it is unknown; then its approval counts for nothing. */
  falcon: string | null;
}

/** `pass`: every file is covered. `wait`: `uncovered` lists the files that still need an approval. */
export interface GateVerdict { verdict: 'pass' | 'wait'; uncovered: string[] }

/**
 * The merge gate's rule, the same for every path: an approval on the current commit from a team member or from
 * Falcon. One limit: Falcon never covers the gate's own files or the pack's comment-only paths; a team member does.
 * CODEOWNERS plays no part: nobody else's approval is needed, and nobody else's approval is enough.
 */
export function gateVerdict(input: GateInput): GateVerdict {
  const lower = (s: string) => s.toLowerCase();
  const team = new Set(input.team.map(lower));
  const falcon = input.falcon ? lower(input.falcon) : null;
  const approvers = input.approvers.map(lower);
  const falconApproved = falcon !== null && approvers.includes(falcon);
  // A bot is never a person: no bot login counts as a team member.
  const teamApproved = approvers.some((a) => a !== falcon && !a.endsWith('[bot]') && team.has(a));
  const humanPaths = input.humanPaths ?? [];
  // Falcon only comments on the pack's comment-only paths, but an approval it gave before the list changed is still
  // on the PR. The gate must not count it there.
  const uncovered = teamApproved ? [] : input.files.filter((path) => !falconApproved || isGateFile(path) || humanPaths.some((g) => minimatch(path, g)));
  return { verdict: uncovered.length || !input.files.length ? 'wait' : 'pass', uncovered };
}
