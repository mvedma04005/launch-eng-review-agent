import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GateObservation } from './types.ts';
import {
  approvalOutcome, bindFromObservations, bindFromTimeline, decodeState, encodeState, queueChain,
  type ChainMember, type GateState,
} from './gate-binding.ts';

const obs = (o: Partial<GateObservation> = {}): GateObservation => ({
  repo: 'acme/demo', number: 1, atMs: 1, headSha: 'h1', baseRef: 'main', baseSha: 'b1', mergeBase: 'm1', ...o,
});
const around = (b: Partial<GateObservation> = {}, a: Partial<GateObservation> = {}) => ({ before: obs(b), after: obs(a) });

test('bindFromObservations: the same head, base and merge base on both sides binds', () => {
  assert.deepEqual(bindFromObservations(around(), 'h1', 'h1'), { headSha: 'h1', baseRef: 'main', mergeBase: 'm1' });
});

test('bindFromObservations: a base or merge base change between the two sides does not bind', () => {
  assert.equal(bindFromObservations(around({}, { headSha: 'h2' }), 'h1', 'h1'), null);
  assert.equal(bindFromObservations(around({}, { baseRef: 'feat-a' }), 'h1', 'h1'), null);
  assert.equal(bindFromObservations(around({}, { mergeBase: 'm2' }), 'h1', 'h1'), null);
});

test('bindFromObservations: a missing side does not bind', () => {
  assert.equal(bindFromObservations({ before: null, after: obs() }, 'h1', 'h1'), null);
  assert.equal(bindFromObservations({ before: obs(), after: null }, 'h1', 'h1'), null);
});

test('bindFromObservations: a review re-pointed to the current head binds to the observed head', () => {
  assert.deepEqual(bindFromObservations(around(), 'h9', 'h9'), { headSha: 'h1', baseRef: 'main', mergeBase: 'm1' });
});

test('bindFromObservations: a review of some other commit does not bind', () => {
  assert.equal(bindFromObservations(around(), 'h7', 'h9'), null);
});

const cur = { headSha: 'h1', baseRef: 'main', mergeBase: 'm1' };

test('bindFromTimeline: an approval of the current head given on the default branch binds', () => {
  assert.deepEqual(bindFromTimeline('main', 'h1', cur, ['main']), cur);
});

test('bindFromTimeline: an approval of the current head given on feat-a does not bind', () => {
  assert.equal(bindFromTimeline('feat-a', 'h1', cur, ['main']), null);
});

test('bindFromTimeline: an approval of an older commit does not bind', () => {
  assert.equal(bindFromTimeline('main', 'h0', cur, ['main']), null);
});

test('approvalOutcome: direct, compare and stale', () => {
  assert.equal(approvalOutcome(cur, cur), 'direct');
  assert.equal(approvalOutcome(cur, { ...cur, mergeBase: 'm2' }), 'compare');
  assert.equal(approvalOutcome(cur, { ...cur, baseRef: 'feat-a' }), 'compare');
  assert.equal(approvalOutcome(null, cur), 'stale');
});

test('state: encode then decode round-trips; a legacy colon value decodes to null', () => {
  const s: GateState = { headSha: 'h1', baseRef: 'main', mergeBase: 'm1', verdict: 'pass', detail: 'ok' };
  assert.deepEqual(decodeState(encodeState(s)), s);
  assert.equal(decodeState('pass:h1'), null);
  assert.equal(decodeState(null), null);
  assert.equal(decodeState('{"headSha":"h1"}'), null);
});

const pass = (headSha: string, baseRef: string): GateState => ({ headSha, baseRef, mergeBase: 'm', verdict: 'pass', detail: '' });
const m1: ChainMember = { number: 1, position: 1, baseRef: 'main', headRef: 'br1', headSha: 'h1' };
const m2: ChainMember = { number: 2, position: 2, baseRef: 'br1', headRef: 'br2', headSha: 'h2' };

test('queueChain: a two-PR stack passes when both pass and the chain closes on main', () => {
  const states = new Map([[1, pass('h1', 'main')], [2, pass('h2', 'br1')]]);
  assert.deepEqual(queueChain(2, [m2, m1], states, 'main'), { passed: true });
});

test('queueChain: the top waits while the PR below has no saved pass', () => {
  const states = new Map<number, GateState | null>([[1, null], [2, pass('h2', 'br1')]]);
  assert.deepEqual(queueChain(2, [m1, m2], states, 'main'), { passed: false, blocker: 1 });
});

test('queueChain: a saved pass for an older head of a member does not count', () => {
  const states = new Map([[1, pass('h0', 'main')], [2, pass('h2', 'br1')]]);
  assert.deepEqual(queueChain(2, [m1, m2], states, 'main'), { passed: false, blocker: 1 });
});

test('queueChain: a chain whose bottom does not target the queue branch waits', () => {
  const states = new Map([[1, pass('h1', 'main')], [2, pass('h2', 'br1')]]);
  assert.deepEqual(queueChain(2, [m1, m2], states, 'release'), { passed: false, blocker: 1 });
});

test('queueChain: a closed member below breaks the chain', () => {
  const states = new Map([[2, pass('h2', 'br1')]]);
  assert.deepEqual(queueChain(2, [m2], states, 'main'), { passed: false, blocker: 2 });
});

test('queueChain: a PR alone passes only with a saved pass for the queue branch', () => {
  const alone: ChainMember = { number: 5, position: 1, baseRef: 'main', headRef: 'x', headSha: 'h5' };
  assert.deepEqual(queueChain(5, [alone], new Map([[5, pass('h5', 'main')]]), 'main'), { passed: true });
  assert.deepEqual(queueChain(5, [alone], new Map([[5, pass('h5', 'feat-a')]]), 'main'), { passed: false, blocker: 5 });
});

test('queueChain: an entry with a non-finite position never passes', () => {
  for (const position of [NaN, undefined as unknown as number]) {
    const bad: ChainMember = { ...m1, position };
    assert.deepEqual(queueChain(1, [bad], new Map(), 'main'), { passed: false, blocker: 1 });
  }
});

test('queueChain: a break in the middle link blames the middle member', () => {
  const m3: ChainMember = { number: 3, position: 3, baseRef: 'br2', headRef: 'br3', headSha: 'h3' };
  const mid: ChainMember = { ...m2, baseRef: 'other' };
  const states = new Map([[1, pass('h1', 'main')], [2, pass('h2', 'other')], [3, pass('h3', 'br2')]]);
  assert.deepEqual(queueChain(3, [m1, mid, m3], states, 'main'), { passed: false, blocker: 2 });
});
