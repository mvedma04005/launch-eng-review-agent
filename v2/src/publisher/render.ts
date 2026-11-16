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
  /** A team member's approval lifted blocking findings. */
  overridden: boolean;
  /** Why a comment-only review is not an approval, and what the author does next. Null on an approval, a change request or an override. */
  notApproved: { title: string; why: string; next: string } | null;
  /** The Chat reply under the headline: what is open and the next step. The reviewer's own prose stays in the full review. */
  brief: string;
}

// P0 and P1 block (the pack's blockOn). P2 and P3 hold the approval (holdOn). Only a nit lets the bot approve.
// A late finding is the exception: it is shown and never holds.
const holds = (policy: PolicyPack, f: Finding) => policy.verdict.holdOn.includes(f.severity) && !f.late;

/**
 * Marks the late findings of a re-review: a P3 on a line that `changedSince` (the diff from the last reviewed commit,
 * with no context lines) did not touch. The reviewer read that line in an earlier round and passed it, so a new demand
 * there moves the goalpost. A finding caused by a fix sits on a changed line and holds as before.
 *
 * Nothing is late while a finding that held in the last review (`lastRound`) still sits on a line the author did not
 * touch: that review is not answered yet. The check is on the line and not on the finding's text, because the reviewer
 * rewords the same problem and often cites another line for it the next time.
 */
export function markLate(findings: Finding[], changedSince: Anchors, lastRound: Iterable<Finding>): void {
  const unanswered = [...lastRound].some((p) => !p.late && p.severity !== 'info' && p.side === 'RIGHT' && !changedSince.has(p.path, 'LEFT', p.line));
  for (const f of findings) f.late = !unanswered && f.severity === 'low' && !f.blocking && f.side === 'RIGHT' && !changedSince.has(f.path, 'RIGHT', f.line);
}

const sevLabel: Record<Finding['severity'], string> = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3', info: 'Nit' };

export function decideVerdict(policy: PolicyPack, findings: Finding[], confidence: ReviewOutput['confidence'] = 'high', override: string | null = null): { verdict: Verdict; blocking: Finding[]; overridden: boolean } {
  const severe = findings.filter((f) => f.blocking || policy.verdict.blockOn.includes(f.severity));
  const blocking = severe.filter((f) => f.blocking && (!policy.verdict.verifyBlocking || f.verified?.real !== false));
  if (override && blocking.length) return { verdict: 'comment', blocking: [], overridden: true };
  // A reviewer that is not sure may ask, never decide: medium confidence is comment-only whatever the policy allows.
  if (confidence === 'medium') return { verdict: 'comment', blocking, overridden: false };
  if (blocking.length) return { verdict: policy.verdict.mode === 'comment' ? 'comment' : 'request_changes', blocking, overridden: false };
  // A blocking-severity finding the verifier disputes is a human's call: it neither blocks nor lets the PR be approved.
  if (severe.length) return { verdict: 'comment', blocking, overridden: false };
  // A finding that holds (P2 by default) does not block, but the bot does not approve over an open problem.
  if (findings.some((f) => holds(policy, f))) return { verdict: 'comment', blocking, overridden: false };
  return { verdict: policy.verdict.mode === 'approve' ? 'approve' : 'comment', blocking, overridden: false };
}

export function renderReview(policy: PolicyPack, meta: PullMeta, output: ReviewOutput, anchors: Anchors, priorOpen: Map<string, Finding>, override: string | null = null): RenderedReview {
  const { verdict, blocking, overridden } = decideVerdict(policy, output.findings, output.confidence, override);
  const disputed = output.findings.filter((f) => f.blocking).length - blocking.length;
  const held = output.findings.filter((f) => holds(policy, f)).length;
  const late = output.findings.filter((f) => f.late).length;
  const ordered = [...output.findings].sort((a, b) => Number(b.blocking) - Number(a.blocking) || sevRank(a) - sevRank(b));
  const comments: RenderedReview['comments'] = [];
  const bodyFindings: string[] = [];
  for (const f of ordered) {
    const still = priorOpen.has(f.fingerprint) ? ' · still open from an earlier head' : '';
    const verified = f.verified ? (f.verified.real ? '' : ` · verifier disagrees (${Math.round(f.verified.confidence * 100)}%): ${f.verified.reason}`) : '';
    const text = `**${f.blocking ? 'Blocking' : f.late ? 'Late finding, does not hold approval' : holds(policy, f) ? 'Holds approval' : 'Non-blocking'} · ${sevLabel[f.severity]}${f.ruleId ? ` · ${f.ruleId}` : ''}** — ${f.title}${still}\n\n` +
      `Scenario: ${f.scenario}\n\nImpact: ${f.impact}\n\nEvidence: \`${f.evidence}\`\n\nFix: ${f.fix}${verified}\n\n` +
      `<sub>Finding \`${f.id}\`. React 👍/👎 or reply to teach the reviewer.</sub>\n${findingTag(f.id)}`;
    if (anchors.has(f.path, f.side, f.line)) comments.push({ path: f.path, line: f.line, side: f.side, body: text, findingId: f.id });
    else bodyFindings.push(`#### ${f.path}:${f.line}\n${text}`);
  }
  const headline = verdict === 'approve' ? `Approved${late ? ` — ${plural(late, 'late finding')} open` : ''}`
    : overridden ? `Blocking findings overridden by @${override}`
    : output.confidence === 'medium' ? `Comments only (medium confidence)${blocking.length ? `, ${blocking.length} finding${blocking.length === 1 ? '' : 's'} need a decision` : ''}`
    : blocking.length ? `Changes requested — ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}`
    : disputed > 0 ? `Comments only — ${disputed} blocking finding${disputed === 1 ? '' : 's'} disputed by the verifier; a human decides`
    : held > 0 ? `Comments only — ${held} finding${held === 1 ? '' : 's'} to fix before Falcon approves`
    : 'Reviewed — no blocking findings';
  const notApproved = verdict === 'comment' && !overridden ? whyNotApproved(policy, output, blocking.length, output.findings.filter((f) => f.blocking || policy.verdict.blockOn.includes(f.severity)).length - blocking.length) : null;
  const notice = verdict === 'comment' ? ' This comment-only review does not withdraw earlier approvals or change requests.' : '';
  const lines = [
    `### Falcon review: ${headline}`,
    ...(overridden ? ['', `Blocking findings overridden by @${override}'s approval.`] : []),
    ...(notApproved ? ['', `**Why Falcon did not approve:** ${notApproved.why}`] : []),
    ...(late ? ['', `**Late finding:** ${LATE}`] : []),
    '',
    output.summary,
    '',
    output.findings.length ? `${output.findings.length} finding(s): ${countBy(output.findings)}.` : 'No findings.',
    ...(bodyFindings.length ? ['', ...bodyFindings] : []),
    ...(output.risks?.length ? ['', '#### What I tried to break', ...output.risks.map((r) => `- ${r.held ? '**Found:**' : 'Ruled out:'} ${oneLine(r.risk)} ${oneLine(r.checked)}`)] : []),
    ...(output.questions.length ? ['', '#### Questions for the author', ...output.questions.map((q) => `- ${q}`)] : []),
    '',
    `<sub>Reviewed head \`${meta.headSha.slice(0, 12)}\` against policy \`${policy.name}\` with ${output.confidence} confidence. Lenses: ${output.lenses.join(', ')}. Tests were not executed; CI is reported separately.${notice} Reply \`/falcon wrong <finding-id>\` or \`/falcon why <finding-id>\` on any finding.</sub>`,
    marker(meta.repo, meta.number, meta.headSha),
  ];
  // Built from the findings, not from the reviewer's summary: a summary that says "nothing blocks" under a reason that
  // says "fix it" reads as two verdicts.
  const open = ordered.filter((f) => f.severity !== 'info');
  const nits = ordered.length - open.length;
  const brief = [
    overridden ? `Blocking findings overridden by @${override}'s approval.` : '',
    open.length ? [...open.slice(0, 5).map((f) => `• ${sevLabel[f.severity]}${f.late ? ' (late)' : ''} · ${f.path}:${f.line} — ${oneLine(f.title)}`), ...(open.length > 5 ? [`• ${open.length - 5} more in the full review`] : [])].join('\n')
      : nits ? `${plural(nits, 'nit')} in the full review. None needs a fix.` : 'No findings.',
    notApproved && output.questions.length ? ['Questions for the author:', ...output.questions.slice(0, 3).map((q) => `• ${oneLine(q).slice(0, 300)}`)].join('\n') : '',
    late ? `Late: ${LATE}` : '',
    notApproved ? `To merge: ${notApproved.next}.` : verdict === 'request_changes' ? `To merge: fix ${open.length - late === 1 ? 'it' : 'them'} and post the PR link again.` : '',
  ].filter(Boolean).join('\n\n');
  const event: RenderedReview['event'] = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  return { event, verdict, body: lines.join('\n'), comments, checkConclusion: blocking.length && output.confidence === 'high' ? 'action_required' : verdict === 'approve' ? 'success' : 'neutral', blocking, overridden, notApproved, brief };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const LATE = 'found after the first review, on a line that has not changed since the last reviewed commit. Falcon shows a late finding and does not hold the approval for it. Fix it here or in a follow-up.';
/** One cause, the first that applies, in the order decideVerdict tests them; then the step that gets the PR merged. */
function whyNotApproved(policy: PolicyPack, output: ReviewOutput, blocking: number, unsettled: number): { title: string; why: string; next: string } {
  const held = output.findings.filter((f) => holds(policy, f));
  const person = 'ask a Launch Engineering member to approve this commit';
  // In comment mode Falcon never approves this PR, so a fix and a new request do not help: only a person does.
  const fix = (n: number) => policy.verdict.mode === 'comment' ? person : `fix ${n === 1 ? 'it' : 'them'} and post the PR link again, or ${person}`;
  const ranks = policy.verdict.holdOn.map((s) => sevLabel[s]).join(' or ');
  const [title, cause, next] =
    output.confidence === 'medium' ? ['Falcon is not sure (medium confidence)', 'Falcon is not sure enough about this change to decide (medium confidence), so a person decides.', person]
    : blocking ? [`${plural(blocking, 'blocking finding')}`, `${plural(blocking, 'blocking finding')} ${blocking === 1 ? 'is' : 'are'} open.`, fix(blocking)]
    // Blocking severity, but not a confirmed blocker: the checker disputes it, or the reviewer did not mark it blocking.
    : unsettled ? [`${plural(unsettled, 'serious finding')} not confirmed; a person decides`, `${plural(unsettled, 'finding')} of blocking severity ${unsettled === 1 ? 'is' : 'are'} open but not confirmed as a blocker, so a person decides.`, person]
    : held.length && policy.verdict.mode !== 'comment' ? [`${plural(held.length, 'finding')} to fix (${countBy(held)})`, `${plural(held.length, 'finding')} (${countBy(held)}) ${held.length === 1 ? 'is' : 'are'} open. A ${ranks} finding holds Falcon's approval in this repository, and acknowledging a finding does not close it.`, fix(held.length)]
    : ["needs a person's approval", `this repository keeps this PR for a person's approval, so Falcon only comments${held.length ? `; ${plural(held.length, 'finding')} (${countBy(held)}) ${held.length === 1 ? 'is' : 'are'} also open` : ''}.`, person];
  return { title: `Not approved: ${title}`, why: `${cause[0]!.toUpperCase()}${cause.slice(1)} To merge: ${next}.`, next };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
function sevRank(f: Finding): number { return ['critical', 'high', 'medium', 'low', 'info'].indexOf(f.severity); }
function countBy(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(sevLabel[f.severity], (counts.get(sevLabel[f.severity]) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
}
