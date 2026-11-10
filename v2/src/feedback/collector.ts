import type { Store } from '../queue/store.ts';
import type { FeedbackSignal, FindingOutcome } from '../types.ts';

/**
 * Feedback is anything a human does to a finding after it is posted. Signals are recorded with the finding's
 * stable id so the learning layer can reason about them later; nothing here changes reviewer behavior directly.
 */
export function classifyReply(text: string): FeedbackSignal {
  const t = text.toLowerCase();
  if (/\/falcon\s+wrong\b/.test(t) || /\b(not a bug|false positive|incorrect|wrong|intentional|by design|works as intended|disagree)\b/.test(t)) return 'reply_disagree';
  if (/\/falcon\s+ignore\b/.test(t)) return 'command_ignore';
  if (/\b(good catch|fixed|agreed|you're right|thanks|done|addressed)\b/.test(t)) return 'reply_agree';
  return 'reply_question';
}

export function recordReply(store: Store, commentId: number, actor: string, text: string, at: string): FindingOutcome | null {
  const finding = store.findingByComment(commentId);
  if (!finding) return null;
  const outcome: FindingOutcome = { findingId: finding.id, signal: classifyReply(text), actor, at, detail: text.slice(0, 2000) };
  return store.recordOutcome(outcome) ? outcome : null;
}

export function recordReaction(store: Store, commentId: number, actor: string, content: string, at: string): FindingOutcome | null {
  const finding = store.findingByComment(commentId);
  if (!finding) return null;
  const signal: FeedbackSignal | null = content === '+1' || content === 'heart' || content === 'hooray' ? 'thumbs_up' : content === '-1' || content === 'confused' ? 'thumbs_down' : null;
  if (!signal) return null;
  const outcome: FindingOutcome = { findingId: finding.id, signal, actor, at };
  return store.recordOutcome(outcome) ? outcome : null;
}

/** When a later head no longer contains the evidence line, the author most likely acted on the finding. */
export function recordLineChanged(store: Store, findingId: string, at: string): void {
  store.recordOutcome({ findingId, signal: 'line_changed_next_push', actor: 'system', at });
}

/** Merged with the finding still present: strong signal the team did not consider it material. */
export function recordMergedUnaddressed(store: Store, findingId: string, at: string): void {
  store.recordOutcome({ findingId, signal: 'merged_unaddressed', actor: 'system', at });
}

/** Parses `/falcon <verb> <finding-id>` commands from PR conversation comments. */
export function parseCommand(text: string): { verb: 'wrong' | 'ignore' | 'why' | 'review'; findingId?: string } | null {
  const m = text.match(/\/falcon\s+(wrong|ignore|why|review)(?:\s+([a-f0-9]{12}))?/i);
  if (!m) return null;
  const verb = m[1]!.toLowerCase() as 'wrong' | 'ignore' | 'why' | 'review';
  return m[2] ? { verb, findingId: m[2] } : { verb };
}
