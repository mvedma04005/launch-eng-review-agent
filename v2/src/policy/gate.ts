import { minimatch } from './glob.ts';

/** Files that decide who may merge. Falcon's own approval never covers a change to them. */
const GATE_FILES = ['.falcon/**', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export const isGateFile = (path: string): boolean => GATE_FILES.some((g) => minimatch(path, g));

export interface GateInput {
  /** Every path the PR changes, old names of renamed files included. */
  files: string[];
  /** CODEOWNERS text from the default branch. */
  codeowners: string;
  /** Logins of the team, from the policy pack. */
  team: string[];
  /** Logins whose latest verdict on the current commit is an approval. */
  approvers: string[];
  /** Falcon's own login, or null when it is unknown; then its approval counts for nothing. */
  falcon: string | null;
}

/** `pass`: every file is covered. `wait`: `uncovered` lists the files that still need an approval. */
export interface GateVerdict { verdict: 'pass' | 'wait'; uncovered: string[] }

/** A CODEOWNERS pattern as the globs that match the same paths. */
function ownerGlobs(pattern: string): string[] {
  // shortcut: no escaped spaces, `\#` or `{` in patterns; handle them if a CODEOWNERS file starts to use them.
  const body = pattern.replace(/^\/+|\/+$/g, '');
  const base = (pattern.replace(/\/+$/, '').includes('/') ? '' : '**/') + body; // No slash inside: any depth.
  if (pattern.endsWith('/')) return [`${base}/**`]; // A directory: its contents.
  if (body.endsWith('/*')) return [base]; // Direct children only.
  return [base, `${base}/**`]; // Anything else also covers what is under it.
}

/** Owners of one path, lower-cased. GitHub uses the last line that matches. */
export function ownersOf(path: string, codeowners: string): string[] {
  let found: string[] = [];
  for (const line of codeowners.split(/\r?\n/)) {
    const [pattern, ...owners] = line.split('#')[0]!.trim().split(/\s+/);
    if (pattern && ownerGlobs(pattern).some((g) => minimatch(path, g))) found = owners.map((o) => o.toLowerCase());
  }
  return found;
}

/**
 * The merge gate's rule, the same for every path: an approval on the current commit from a team member or from
 * Falcon. Two limits. Falcon never covers the gate's own files. And where CODEOWNERS names people, not a team
 * one of those people must approve as well: the team or Falcon does not replace them.
 */
export function gateVerdict(input: GateInput): GateVerdict {
  const lower = (s: string) => s.toLowerCase();
  const team = new Set(input.team.map(lower));
  const falcon = input.falcon ? lower(input.falcon) : null;
  const approvers = input.approvers.map(lower);
  const falconApproved = falcon !== null && approvers.includes(falcon);
  const people = approvers.filter((a) => a !== falcon && !a.endsWith('[bot]'));
  const teamApproved = people.some((p) => team.has(p));
  const uncovered = input.files.filter((path) => {
    if (!teamApproved && (!falconApproved || isGateFile(path))) return true;
    const owners = ownersOf(path, input.codeowners);
    const named = owners.length > 0 && owners.every((o) => !o.includes('/'));
    return named && !owners.some((o) => people.includes(o.replace(/^@/, '')));
  });
  return { verdict: uncovered.length || !input.files.length ? 'wait' : 'pass', uncovered };
}
