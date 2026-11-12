import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../evidence/diff.ts';
import type { Worktree } from '../evidence/git.ts';
import { parsePolicy } from '../policy/load.ts';
import { buildTools, type ToolState } from './tools.ts';

test('a submission accepted with unresolved problems is downgraded to medium confidence', async () => {
  const worktree = { exists: () => true, readText: () => 'def handler(user):\n    return user.name\n', resolve: (p: string) => p } as unknown as Worktree;
  const state: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
  const tools = buildTools(worktree, parseUnifiedDiff(''), parsePolicy('version: 1\nname: p', 'p'), { baseRead: async () => null, changedFiles: ['svc.py', 'other.py'] }, state);
  const submit = tools.find((t) => t.name === 'submit_review')!;
  const base = { summary: 's', confidence: 'high' as const, lenses_completed: ['correctness'], questions: [], findings: [], risks: [{ risk: 'null user', held: false, checked: 'handler.py' }, { risk: 'bad import', held: false, checked: 'handler.py' }] };
  // Omits other.py every time: rejected three times, then accepted with the problem still there.
  for (let i = 0; i < 4; i++) await submit.run({ ...base, reviewed_files: ['svc.py'] } as never);
  assert.equal(state.accepted?.submission.confidence, 'medium');

  const clean: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
  const okTools = buildTools(worktree, parseUnifiedDiff(''), parsePolicy('version: 1\nname: p', 'p'), { baseRead: async () => null, changedFiles: ['svc.py'] }, clean);
  await okTools.find((t) => t.name === 'submit_review')!.run({ ...base, reviewed_files: ['svc.py'] } as never);
  assert.equal(clean.accepted?.submission.confidence, 'high');

  // Fewer than two probed risks: rejected like any other problem, so the review cannot approve.
  const lazy: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
  const lazyTools = buildTools(worktree, parseUnifiedDiff(''), parsePolicy('version: 1\nname: p', 'p'), { baseRead: async () => null, changedFiles: ['svc.py'] }, lazy);
  const first = await lazyTools.find((t) => t.name === 'submit_review')!.run({ ...base, risks: [], reviewed_files: ['svc.py'] } as never);
  assert.match(String(first), /risks needs at least two entries/);
  // A risk the reviewer says is real, with no finding to carry it, is rejected too: it must not ride along on an approval.
  const held = await lazyTools.find((t) => t.name === 'submit_review')!.run({ ...base, risks: [{ risk: 'null user', held: true, checked: 'svc.py' }, { risk: 'x <!-- y', held: false, checked: 'svc.py' }], reviewed_files: ['svc.py'] } as never);
  assert.match(String(held), /marked held but there is no finding/);
  assert.match(String(held), /risks: HTML comments are not allowed/);
});
