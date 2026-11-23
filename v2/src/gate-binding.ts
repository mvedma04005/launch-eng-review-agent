// Pure rules for the Merge gate: which change an approval belongs to, and when a
// merge queue commit may pass. No I/O here, so every rule is easy to test.
import type { GateObservation } from './types.ts';

export interface Binding { headSha: string; baseRef: string; mergeBase: string }
export type Current = Binding;

// An approval binds only if the head, base and merge base were the same on both sides of it, and GitHub's
// timeline puts the approval on that base. The gate does not observe a PR while it sits on a base it does not
// judge, so two agreeing observations can hide a trip away and back; the timeline sees it.
// ponytail: sampling gap. If the base is rewritten and rewritten back between two observations
// and an approval lands inside that gap, it can bind to the wrong merge base. A faster poll shrinks the gap.
export function bindFromObservations(
  around: { before: GateObservation | null; after: GateObservation | null },
  reviewSha: string,
  currentHead: string,
  baseRefAtSubmit: string,
): Binding | null {
  const { before, after } = around;
  if (!before || !after) return null;
  if (before.headSha !== after.headSha || before.baseRef !== after.baseRef || before.mergeBase !== after.mergeBase) return null;
  if (baseRefAtSubmit !== before.baseRef) return null;
  // GitHub re-points a review to the new head on a same-diff push, so the current head is also fine.
  if (reviewSha !== before.headSha && reviewSha !== currentHead) return null;
  return { headSha: before.headSha, baseRef: before.baseRef, mergeBase: before.mergeBase };
}

// With no observations, trust the timeline only for an approval given on a protected base of the current head.
export function bindFromTimeline(
  baseRefAtSubmit: string,
  reviewSha: string,
  current: Current,
  protectedBases: string[],
): Binding | null {
  if (!protectedBases.includes(baseRefAtSubmit)) return null;
  if (current.baseRef !== baseRefAtSubmit || reviewSha !== current.headSha) return null;
  return current;
}

export function approvalOutcome(binding: Binding | null, current: Current): 'direct' | 'compare' | 'stale' {
  if (!binding) return 'stale';
  const same = binding.headSha === current.headSha && binding.baseRef === current.baseRef && binding.mergeBase === current.mergeBase;
  return same ? 'direct' : 'compare';
}

export interface GateState { headSha: string; baseRef: string; mergeBase: string; verdict: 'pass' | 'wait' | 'moved'; detail: string }

export function encodeState(s: GateState): string {
  return JSON.stringify(s);
}

// Anything that is not the full JSON shape (null, an old colon value, junk) is no state.
export function decodeState(value: string | null): GateState | null {
  if (value === null) return null;
  try {
    const v = JSON.parse(value) as Partial<GateState> | null;
    if (!v || typeof v !== 'object') return null;
    const { headSha, baseRef, mergeBase, verdict, detail } = v;
    if (typeof headSha !== 'string' || typeof baseRef !== 'string' || typeof mergeBase !== 'string' || typeof detail !== 'string') return null;
    if (verdict !== 'pass' && verdict !== 'wait' && verdict !== 'moved') return null;
    return { headSha, baseRef, mergeBase, verdict, detail };
  } catch {
    return null;
  }
}

export interface ChainMember { number: number; position: number; baseRef: string; headRef: string; headSha: string }

// A queue commit passes only if every open PR from the stack base up to the entry has a saved
// pass for its current head, and the chain starts on the queue branch and links head to base.
export function queueChain(
  entry: number,
  members: ChainMember[],
  states: Map<number, GateState | null>,
  queueBranch: string,
): { passed: true } | { passed: false; blocker: number } {
  const top = members.find((m) => m.number === entry);
  if (!top) return { passed: false, blocker: entry };
  const chain = members.filter((m) => m.position <= top.position).sort((a, b) => a.position - b.position);
  // A non-finite position (bad GitHub JSON) leaves the entry out of the chain; never pass on that.
  if (chain.at(-1) !== top) return { passed: false, blocker: entry };
  let expectedBase = queueBranch;
  for (const m of chain) {
    const s = states.get(m.number);
    const ok = s?.verdict === 'pass' && s.headSha === m.headSha && s.baseRef === m.baseRef && m.baseRef === expectedBase;
    if (!ok) return { passed: false, blocker: m.number };
    expectedBase = m.headRef;
  }
  return { passed: true };
}
