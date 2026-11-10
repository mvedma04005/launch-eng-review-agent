import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingPlanSections } from './plan.ts';

test('missingPlanSections wants a filled Problem and Plan', () => {
  const filled = '## Problem\nReports time out for accounts with more than 500 campaigns.\n\n## Plan\nPage the query in batches of 100 and stream the rows to the client.';
  assert.deepEqual(missingPlanSections(filled, ['Problem', 'Plan']), []);
  assert.deepEqual(missingPlanSections('## Problem\nReports time out for accounts with more than 500 campaigns.', ['Problem', 'Plan']), ['Plan']);
  assert.deepEqual(missingPlanSections('## Problem\n<!-- What is wrong today? -->\n\n## Plan\n<!-- How does this fix it? -->', ['Problem', 'Plan']), ['Problem', 'Plan']);
  assert.deepEqual(missingPlanSections('### problem statement\n' + 'x'.repeat(40) + '\n# PLAN\n' + 'y'.repeat(40), ['Problem', 'Plan']), []);
  assert.deepEqual(missingPlanSections('', ['Problem', 'Plan']), ['Problem', 'Plan']);
});

test('a # line in a fenced block or a sub-heading does not end a section', () => {
  const P = '## Problem\nReports time out for accounts with more than 500 campaigns.\n';
  const fenced = `${P}## Plan\nRun it:\n\`\`\`bash\n# dry run first\n./backfill --dry-run --batch 100 --since 2026-01-01\n\`\`\`\nThen flip the flag.`;
  assert.deepEqual(missingPlanSections(fenced, ['Problem', 'Plan']), []);
  const sub = `${P}## Plan\n### Step 1\nPage the query in batches of 100.\n### Step 2\nStream the rows to the client.`;
  assert.deepEqual(missingPlanSections(sub, ['Problem', 'Plan']), []);
  const onlyInFence = '```\n## Problem\nReports time out for accounts with more than 500 campaigns.\n## Plan\nPage the query in batches of 100 and stream.\n```';
  assert.deepEqual(missingPlanSections(onlyInFence, ['Problem', 'Plan']), ['Problem', 'Plan']);
});
