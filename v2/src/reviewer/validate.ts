import { createHash } from 'node:crypto';
import type { Anchors } from '../evidence/diff.ts';
import type { Worktree } from '../evidence/git.ts';
import type { Finding } from '../types.ts';
import type { ReviewSubmission } from './schema.ts';

export interface ValidationContext {
  worktree: Worktree;
  anchors: Anchors;
  /** Read a file at the merge base (for LEFT anchors); null when absent. */
  baseRead: (path: string) => Promise<string | null>;
  changedFiles: string[];
  maxFileBytes: number;
}

export interface ValidationResult { findings: Finding[]; errors: string[] }

/**
 * The host, not the model, decides what counts as a verified finding: the cited file and line must exist at the
 * cited commit and the quoted evidence must appear on that line. Findings that fail are returned as errors so
 * the model can correct them; nothing unverifiable is ever published.
 */
export async function validateSubmission(sub: ReviewSubmission, ctx: ValidationContext): Promise<ValidationResult> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const changed = new Set(ctx.changedFiles);
  const missing = ctx.changedFiles.filter((f) => !sub.reviewed_files.includes(f));
  if (missing.length) errors.push(`reviewed_files omits ${missing.length} changed file(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}. Inspect them or state why they need no review.`);
  const seen = new Set<string>();
  for (const [i, f] of sub.findings.entries()) {
    const where = `finding[${i}] ${f.path}:${f.line}`;
    if (/<!--/.test(f.title + f.scenario + f.impact + f.evidence + f.fix)) { errors.push(`${where}: HTML comments are not allowed.`); continue; }
    let text: string | null = null;
    try {
      text = f.side === 'RIGHT' ? (ctx.worktree.exists(f.path) ? ctx.worktree.readText(f.path, ctx.maxFileBytes) : null) : await ctx.baseRead(f.path);
    } catch (error) {
      errors.push(`${where}: ${(error as Error).message}`); continue;
    }
    if (text === null) { errors.push(`${where}: file does not exist on side ${f.side}.`); continue; }
    const lines = text.split('\n');
    if (f.line > lines.length) { errors.push(`${where}: file has ${lines.length} lines.`); continue; }
    const actual = lines[f.line - 1]!;
    if (!actual.trim().includes(f.evidence.trim()) || !f.evidence.trim()) { errors.push(`${where}: evidence not found on that line. Line reads: ${JSON.stringify(actual.slice(0, 200))}`); continue; }
    if (f.side === 'LEFT' && !ctx.anchors.has(f.path, 'LEFT', f.line)) { errors.push(`${where}: LEFT anchors must be deleted lines in the diff; cite the RIGHT side or a deleted line.`); continue; }
    if (!changed.has(f.path) && f.side === 'RIGHT') {
      // A finding in an unchanged file is allowed (a change can break a caller), but it renders in the body, not inline.
    }
    const fingerprint = createHash('sha256').update(`${f.rule_id ?? ''}|${f.path}|${f.evidence.replace(/\s+/g, ' ').trim()}|${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`).digest('hex');
    if (seen.has(fingerprint)) { errors.push(`${where}: duplicate of an earlier finding.`); continue; }
    seen.add(fingerprint);
    findings.push({
      id: fingerprint.slice(0, 12), ruleId: f.rule_id, severity: f.severity, blocking: false, path: f.path, line: f.line, side: f.side,
      title: f.title.trim(), scenario: f.scenario.trim(), impact: f.impact.trim(), evidence: f.evidence.trim(), fix: f.fix.trim(), fingerprint,
    });
  }
  return { findings, errors };
}
