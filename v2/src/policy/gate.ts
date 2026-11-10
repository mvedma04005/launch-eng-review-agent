import { minimatch } from './glob.ts';

/** Files that decide who may merge. Falcon's own approval never covers a change to them. */
const GATE_FILES = ['.falcon/**', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export interface GateInput {
  /** Every path the PR changes, old names of renamed files included. */
  files: string[];
  /** CODEOWNERS text from the default branch. */
  codeowners: string;
  /** The CODEOWNERS entry Falcon stands in for, e.g. `@ROKT/launch-engineering`. */
  teamOwner: string;
  /** Logins of that team, from the policy pack. */
  team: string[];
  /** Logins whose latest verdict on the current commit is an approval. */
  approvers: string[];
  /** Falcon's own login, or null when it is unknown; then its approval counts for nothing. */
  falcon: string | null;
}

/** `pass`: every file is covered. `wait`: some file is not. `unknown`: only another team's membership is in doubt. */
export interface GateVerdict { verdict: 'pass' | 'wait' | 'unknown'; uncovered: string[] }

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
 * The merge gate's rule: every changed file needs an approval, on the current commit, from one of its
 * CODEOWNERS owners. Where the team is an owner, Falcon's approval counts too, except on the gate's own files.
 */
export function gateVerdict(input: GateInput): GateVerdict {
  const lower = (s: string) => s.toLowerCase();
  const teamOwner = lower(input.teamOwner);
  const team = new Set(input.team.map(lower));
  const falcon = input.falcon ? lower(input.falcon) : null;
  const approvers = input.approvers.map(lower);
  const falconApproved = falcon !== null && approvers.includes(falcon);
  const people = approvers.filter((a) => a !== falcon);
  const wait: string[] = [];
  const unknown: string[] = [];
  for (const path of input.files) {
    const owners = ownersOf(path, input.codeowners);
    const gateFile = GATE_FILES.some((g) => minimatch(path, g));
    if (owners.includes(teamOwner) && (people.some((p) => team.has(p)) || (falconApproved && !gateFile))) continue;
    if (owners.some((o) => !o.includes('/') && people.includes(o.replace(/^@/, '')))) continue;
    // Falcon's App cannot read team membership, so a person's approval on another team's file stays unknown.
    const otherTeam = owners.some((o) => o.includes('/') && o !== teamOwner);
    (otherTeam && people.some((p) => !team.has(p)) ? unknown : wait).push(path);
  }
  if (wait.length || !input.files.length) return { verdict: 'wait', uncovered: wait };
  return unknown.length ? { verdict: 'unknown', uncovered: unknown } : { verdict: 'pass', uncovered: [] };
}
