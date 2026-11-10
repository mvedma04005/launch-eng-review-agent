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
