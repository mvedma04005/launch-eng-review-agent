import type { PolicyPack } from '../policy/schema.ts';
import type { Anchors } from '../evidence/diff.ts';
import type { Finding, PullMeta, ReviewOutput, Verdict } from '../types.ts';

export const MARKER_PREFIX = '<!-- falcon-review:v2 ';
export const marker = (repo: string, number: number, sha: string) => `${MARKER_PREFIX}${repo}#${number}@${sha} -->`;
export const findingTag = (id: string) => `<!-- falcon-finding:${id} -->`;

export interface RenderedReview {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  verdict: Verdict;
  body: string;
  comments: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; findingId: string }>;
  checkConclusion: 'success' | 'neutral' | 'action_required';
  blocking: Finding[];
}

const sevLabel: Record<Finding['severity'], string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function decideVerdict(policy: PolicyPack, findings: Finding[]): { verdict: Verdict; blocking: Finding[] } {
  const blocking = findings.filter((f) => f.blocking && (!policy.verdict.verifyBlocking || f.verified?.real !== false));
  if (blocking.length) return { verdict: policy.verdict.mode === 'comment' ? 'comment' : 'request_changes', blocking };
  return { verdict: policy.verdict.mode === 'approve' ? 'approve' : 'comment', blocking };
}

export function renderReview(policy: PolicyPack, meta: PullMeta, output: ReviewOutput, anchors: Anchors, priorOpen: Map<string, Finding>): RenderedReview {
  const { verdict, blocking } = decideVerdict(policy, output.findings);
  const ordered = [...output.findings].sort((a, b) => Number(b.blocking) - Number(a.blocking) || sevRank(a) - sevRank(b));
  const comments: RenderedReview['comments'] = [];
  const bodyFindings: string[] = [];
  for (const f of ordered) {
    const still = priorOpen.has(f.fingerprint) ? ' · still open from an earlier head' : '';
    const verified = f.verified ? (f.verified.real ? '' : ` · verifier disagrees (${Math.round(f.verified.confidence * 100)}%): ${f.verified.reason}`) : '';
    const text = `**${f.blocking ? 'Blocking' : 'Non-blocking'} · ${sevLabel[f.severity]}${f.ruleId ? ` · ${f.ruleId}` : ''}** — ${f.title}${still}\n\n` +
      `Scenario: ${f.scenario}\n\nImpact: ${f.impact}\n\nEvidence: \`${f.evidence}\`\n\nFix: ${f.fix}${verified}\n\n` +
      `<sub>Finding \`${f.id}\`. React 👍/👎 or reply to teach the reviewer.</sub>\n${findingTag(f.id)}`;
    if (anchors.has(f.path, f.side, f.line)) comments.push({ path: f.path, line: f.line, side: f.side, body: text, findingId: f.id });
    else bodyFindings.push(`#### ${f.path}:${f.line}\n${text}`);
  }
  const headline = verdict === 'approve' ? 'Approved' : blocking.length ? `Changes requested — ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}` : 'Reviewed — no blocking findings';
  const lines = [
    `### Falcon review: ${headline}`,
    '',
    output.summary,
    '',
    output.findings.length ? `${output.findings.length} finding(s): ${countBy(output.findings)}.` : 'No findings.',
    ...(bodyFindings.length ? ['', ...bodyFindings] : []),
    ...(output.questions.length ? ['', '#### Questions for the author', ...output.questions.map((q) => `- ${q}`)] : []),
    '',
    `<sub>Reviewed head \`${meta.headSha.slice(0, 12)}\` against policy \`${policy.name}\`. Lenses: ${output.lenses.join(', ')}. Tests were not executed; CI is reported separately. Reply \`/falcon wrong <finding-id>\` or \`/falcon why <finding-id>\` on any finding.</sub>`,
    marker(meta.repo, meta.number, meta.headSha),
  ];
  const event: RenderedReview['event'] = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  return { event, verdict, body: lines.join('\n'), comments, checkConclusion: blocking.length ? 'action_required' : verdict === 'approve' ? 'success' : 'neutral', blocking };
}

function sevRank(f: Finding): number { return ['critical', 'high', 'medium', 'low', 'info'].indexOf(f.severity); }
function countBy(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
}
