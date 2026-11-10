import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHub } from './github.ts';

const HEAD = 'h'.repeat(40);
const review = (login: string, state: string, commit_id = HEAD) => ({ user: { login }, state, commit_id });

test('approvers: only the latest verdict on exactly the head counts', async () => {
  const rows = [
    review('old', 'APPROVED', 'o'.repeat(40)),
    review('chatty', 'APPROVED'), review('chatty', 'COMMENTED'),
    review('flipped', 'APPROVED'), review('flipped', 'CHANGES_REQUESTED'),
    review('dismissed', 'DISMISSED'),
    review('good', 'APPROVED'),
  ];
  const octokit = { paginate: async () => rows, pulls: { listReviews: {} } } as unknown as Octokit;
  assert.deepEqual(await new OctokitGitHub(octokit, null).approvers('acme/demo', 3, HEAD), ['chatty', 'good']);
});
