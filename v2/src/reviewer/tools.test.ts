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
  const base = { summary: 's', confidence: 'high' as const, lenses_completed: ['correctness'], questions: [], findings: [] };
  // Omits other.py every time: rejected three times, then accepted with the problem still there.
  for (let i = 0; i < 4; i++) await submit.run({ ...base, reviewed_files: ['svc.py'] } as never);
  assert.equal(state.accepted?.submission.confidence, 'medium');

  const clean: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
  const okTools = buildTools(worktree, parseUnifiedDiff(''), parsePolicy('version: 1\nname: p', 'p'), { baseRead: async () => null, changedFiles: ['svc.py'] }, clean);
  await okTools.find((t) => t.name === 'submit_review')!.run({ ...base, reviewed_files: ['svc.py'] } as never);
  assert.equal(clean.accepted?.submission.confidence, 'high');
});
