import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { minimatch } from './glob.ts';
import { PolicyPackSchema, type PolicyPack, type Rule } from './schema.ts';
import type { Finding, Severity } from '../types.ts';

export function parsePolicy(text: string, source: string): PolicyPack {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new Error(`Policy ${source} is not valid YAML: ${(error as Error).message}`);
  }
  const parsed = PolicyPackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Policy ${source} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const ids = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (ids.has(rule.id)) throw new Error(`Policy ${source} defines rule ${rule.id} twice`);
    ids.add(rule.id);
  }
  return parsed.data;
}

export function loadPolicyFile(path: string): PolicyPack {
  return parsePolicy(readFileSync(path, 'utf8'), path);
}

const MODE_RANK = { comment: 0, request_changes: 1, approve: 2 } as const;

/**
 * Repository packs refine the engine pack: rules with the same id replace the base rule, scalars from the
 * overlay win, list fields are concatenated. Verdict authority is capped: an overlay may choose any mode up to
 * the base pack's `maxMode` and may not raise the ceiling itself, so whether a repository's bot can block or
 * approve merges stays an operator decision made in the central pack.
 */
export function mergePolicies(base: PolicyPack, overlay: PolicyPack): PolicyPack {
  const rules = new Map<string, Rule>(base.rules.map((r) => [r.id, r]));
  for (const rule of overlay.rules) rules.set(rule.id, rule);
  const mode = MODE_RANK[overlay.verdict.mode] <= MODE_RANK[base.verdict.maxMode] ? overlay.verdict.mode : base.verdict.maxMode;
  return PolicyPackSchema.parse({
    ...base,
    ...overlay,
    name: `${base.name}+${overlay.name}`,
    scope: { include: overlay.scope.include, exclude: [...base.scope.exclude, ...overlay.scope.exclude] },
    verdict: { ...base.verdict, ...overlay.verdict, mode, maxMode: base.verdict.maxMode },
    lenses: overlay.lenses.length ? overlay.lenses : base.lenses,
    budgets: { ...base.budgets, ...overlay.budgets },
    context: {
      instructionFiles: [...new Set([...base.context.instructionFiles, ...overlay.context.instructionFiles])],
      required: [...new Set([...base.context.required, ...overlay.context.required])],
    },
    standards: [...base.standards, ...overlay.standards],
    rules: [...rules.values()],
    suppressions: [...base.suppressions, ...overlay.suppressions],
    feedback: { ...base.feedback, ...overlay.feedback },
  });
}

export function isTeamMember(policy: PolicyPack, login: string): boolean {
  const l = login.toLowerCase();
  return policy.team.members.some((m) => m.toLowerCase() === l);
}

export function overrideBy(policy: PolicyPack, author: string, approvers: string[]): string | null {
  return approvers.find((a) => a.toLowerCase() !== author.toLowerCase() && isTeamMember(policy, a)) ?? null;
}

export function inScope(policy: PolicyPack, path: string): boolean {
  return policy.scope.include.some((g) => minimatch(path, g)) && !policy.scope.exclude.some((g) => minimatch(path, g));
}

export function rulesFor(policy: PolicyPack, path: string): Rule[] {
  return policy.rules.filter((r) => r.enabled && r.paths.some((g) => minimatch(path, g)));
}

export function isSuppressed(policy: PolicyPack, finding: Pick<Finding, 'ruleId' | 'path'>): string | null {
  for (const s of policy.suppressions) {
    if (finding.ruleId === s.rule && s.paths.some((g) => minimatch(finding.path, g))) return s.reason;
  }
  return null;
}

export function blocks(policy: PolicyPack, severity: Severity): boolean {
  return policy.verdict.blockOn.includes(severity);
}

/** Deterministic post-processing the model cannot override: suppressions, scope, blocking derived from severity. */
export function applyPolicy(policy: PolicyPack, findings: Finding[]): { kept: Finding[]; dropped: Array<{ finding: Finding; reason: string }> } {
  const kept: Finding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  for (const finding of findings) {
    if (!inScope(policy, finding.path)) { dropped.push({ finding, reason: 'path out of policy scope' }); continue; }
    const suppressed = isSuppressed(policy, finding);
    if (suppressed) { dropped.push({ finding, reason: `suppressed: ${suppressed}` }); continue; }
    kept.push({ ...finding, blocking: blocks(policy, finding.severity) });
  }
  return { kept, dropped };
}
