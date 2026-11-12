import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerificationSchema } from './schema.ts';

test('a long second-opinion reason parses: the caller clips it, the review is not held', () => {
  assert.equal(VerificationSchema.parse({ real: true, confidence: 0.9, reason: 'x'.repeat(5000) }).reason.length, 5000);
});
